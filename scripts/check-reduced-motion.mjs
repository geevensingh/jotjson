#!/usr/bin/env node
// Reduced-motion lint: every SCSS transition, animation, animation-name,
// transition-property, and @keyframes block must be scoped to an explicit
// prefers-reduced-motion media query or carry a local allow pragma.
//
// The scanner is intentionally text-based and dependency-free, matching the
// other scripts/check-*.mjs gates. It tracks SCSS brace nesting so declarations
// inside nested @media (prefers-reduced-motion: reduce) blocks are recognized
// at any depth and are not mistaken for new unguarded motion.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const PRAGMA_TEXT = '// allow:reduced-motion';
const PRAGMA_PATTERN = /\/\/\s*allow:reduced-motion(?:\s+(?<reason>.+))?$/;
const MOTION_PATTERN =
  /@keyframes\s+[-_a-zA-Z0-9]+|\b(?:transition-property|animation-name|transition|animation)\s*:/g;
const EXCLUDED_PATH_PARTS = new Set(['node_modules', 'dist', 'coverage', '.angular']);

function listScssFiles() {
  const output = execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    { encoding: 'buffer' },
  );
  return output
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
    .map((path) => path.replace(/\\/g, '/'))
    .filter((path) => path.endsWith('.scss'))
    .filter((path) => !path.split('/').some((part) => EXCLUDED_PATH_PARTS.has(part)));
}

function buildLineStarts(text) {
  const lineStarts = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '\n') {
      lineStarts.push(index + 1);
    }
  }
  return lineStarts;
}

function lineNumberForOffset(lineStarts, offset) {
  let lowerBound = 0;
  let upperBound = lineStarts.length - 1;
  while (lowerBound <= upperBound) {
    const middle = Math.floor((lowerBound + upperBound) / 2);
    const lineStart = lineStarts[middle];
    const nextLineStart = middle + 1 < lineStarts.length ? lineStarts[middle + 1] : Infinity;
    if (offset < lineStart) {
      upperBound = middle - 1;
    } else if (offset >= nextLineStart) {
      lowerBound = middle + 1;
    } else {
      return middle + 1;
    }
  }
  return lineStarts.length;
}

function lineBoundsForNumber(text, lineStarts, lineNumber) {
  const lineStart = lineStarts[lineNumber - 1] ?? 0;
  const nextLineStart = lineStarts[lineNumber] ?? text.length;
  const lineEnd =
    nextLineStart > lineStart && text[nextLineStart - 1] === '\n'
      ? nextLineStart - 1
      : nextLineStart;
  const trimmedLineEnd = lineEnd > lineStart && text[lineEnd - 1] === '\r' ? lineEnd - 1 : lineEnd;
  return { lineStart, lineEnd: trimmedLineEnd };
}

function isMotionPreferenceMedia(header) {
  return /^@media\b/.test(header) && /\bprefers-reduced-motion\b/.test(header);
}

function parseScss(text) {
  const scopes = [];
  const scopeStack = [];
  const ignored = new Uint8Array(text.length);
  let headerStart = 0;
  let lineComment = false;
  let blockComment = false;
  let quote = null;
  let interpolationDepth = 0;
  let index = 0;

  while (index < text.length) {
    const character = text[index];
    const nextCharacter = text[index + 1];

    if (lineComment) {
      ignored[index] = 1;
      if (character === '\n') {
        lineComment = false;
      }
      index += 1;
      continue;
    }

    if (blockComment) {
      ignored[index] = 1;
      if (character === '*' && nextCharacter === '/') {
        ignored[index + 1] = 1;
        blockComment = false;
        index += 2;
      } else {
        index += 1;
      }
      continue;
    }

    if (quote) {
      ignored[index] = 1;
      if (character === '\\') {
        if (index + 1 < text.length) {
          ignored[index + 1] = 1;
        }
        index += 2;
      } else if (character === quote) {
        quote = null;
        index += 1;
      } else {
        index += 1;
      }
      continue;
    }

    if (interpolationDepth > 0) {
      if (character === '{') {
        interpolationDepth += 1;
      } else if (character === '}') {
        interpolationDepth -= 1;
      }
      index += 1;
      continue;
    }

    if (character === '/' && nextCharacter === '/') {
      ignored[index] = 1;
      ignored[index + 1] = 1;
      lineComment = true;
      index += 2;
      continue;
    }

    if (character === '/' && nextCharacter === '*') {
      ignored[index] = 1;
      ignored[index + 1] = 1;
      blockComment = true;
      index += 2;
      continue;
    }

    if (character === "'" || character === '"') {
      ignored[index] = 1;
      quote = character;
      index += 1;
      continue;
    }

    if (character === '#' && nextCharacter === '{') {
      interpolationDepth = 1;
      index += 2;
      continue;
    }

    if (character === '{') {
      const header = text.slice(headerStart, index).trim();
      const parentIndex = scopeStack.length > 0 ? scopeStack[scopeStack.length - 1] : -1;
      const scopeIndex = scopes.length;
      scopes.push({
        header,
        headerStart,
        openBrace: index,
        closeBrace: text.length,
        parentIndex,
        isMotionPreferenceMedia: isMotionPreferenceMedia(header),
      });
      scopeStack.push(scopeIndex);
      headerStart = index + 1;
      index += 1;
      continue;
    }

    if (character === '}') {
      const scopeIndex = scopeStack.pop();
      if (scopeIndex !== undefined) {
        scopes[scopeIndex].closeBrace = index;
      }
      headerStart = index + 1;
      index += 1;
      continue;
    }

    if (character === ';') {
      headerStart = index + 1;
    }

    index += 1;
  }

  return { scopes, ignored };
}

function collectPragmas(path, text, lineStarts) {
  const validPragmas = [];
  const violations = [];
  for (let lineNumber = 1; lineNumber <= lineStarts.length; lineNumber += 1) {
    const { lineStart, lineEnd } = lineBoundsForNumber(text, lineStarts, lineNumber);
    const fullLine = text.slice(lineStart, lineEnd);
    if (!fullLine.includes(PRAGMA_TEXT)) {
      continue;
    }
    const pragmaMatch = PRAGMA_PATTERN.exec(fullLine);
    const reason = pragmaMatch?.groups?.reason?.trim() ?? '';
    if (!reason) {
      violations.push({
        path,
        line: lineNumber,
        message: `${PRAGMA_TEXT} pragmas must include a non-empty reason.`,
      });
      continue;
    }
    validPragmas.push({ lineNumber, lineStart, lineEnd, reason });
  }
  return { validPragmas, violations };
}

function containingScopesForOffset(scopes, offset) {
  return scopes.filter((scope) => scope.openBrace < offset && offset < scope.closeBrace);
}

function hasScopedPragma(validPragmas, containingScopes, matchLineStart, matchLineEnd) {
  if (
    validPragmas.some(
      (pragma) => pragma.lineStart === matchLineStart && pragma.lineEnd === matchLineEnd,
    )
  ) {
    return true;
  }

  return containingScopes.some((scope) =>
    validPragmas.some(
      (pragma) =>
        scope.headerStart <= pragma.lineStart &&
        pragma.lineStart <= matchLineEnd &&
        pragma.lineStart < scope.closeBrace,
    ),
  );
}

function describeMotionSnippet(snippet) {
  if (snippet.startsWith('@keyframes')) {
    return '@keyframes block';
  }
  return `${snippet.replace(/\s+/g, ' ').trim()} declaration`;
}

function scan(path) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return [];
  }

  const lineStarts = buildLineStarts(text);
  const { scopes, ignored } = parseScss(text);
  const { validPragmas, violations } = collectPragmas(path, text, lineStarts);

  MOTION_PATTERN.lastIndex = 0;
  let match;
  while ((match = MOTION_PATTERN.exec(text)) !== null) {
    if (ignored[match.index]) {
      continue;
    }

    const lineNumber = lineNumberForOffset(lineStarts, match.index);
    const { lineStart, lineEnd } = lineBoundsForNumber(text, lineStarts, lineNumber);
    const containingScopes = containingScopesForOffset(scopes, match.index);
    const insideMotionPreferenceMedia = containingScopes.some(
      (scope) => scope.isMotionPreferenceMedia,
    );
    if (insideMotionPreferenceMedia) {
      continue;
    }

    if (hasScopedPragma(validPragmas, containingScopes, lineStart, lineEnd)) {
      continue;
    }

    violations.push({
      path,
      line: lineNumber,
      message:
        `${describeMotionSnippet(match[0])} is outside a prefers-reduced-motion media block` +
        ` and has no ${PRAGMA_TEXT} <reason> pragma in its selector scope.`,
    });
  }

  return violations;
}

const files = listScssFiles();
const allViolations = files.flatMap(scan);

if (allViolations.length === 0) {
  console.log(`check-reduced-motion: OK (${files.length} SCSS files scanned, 0 violations)`);
  process.exit(0);
}

console.error('check-reduced-motion: violations found:');
for (const violation of allViolations) {
  console.error(`${violation.path}:${violation.line}: ${violation.message}`);
}
console.error(`\n${allViolations.length} violation(s) in ${files.length} SCSS files.`);

if (process.env.GITHUB_ACTIONS === 'true') {
  for (const violation of allViolations) {
    const file = violation.path.replace(/%/g, '%25');
    const message = violation.message
      .replace(/%/g, '%25')
      .replace(/\r/g, '%0D')
      .replace(/\n/g, '%0A');
    console.log(`::error file=${file},line=${violation.line}::${message}`);
  }
}

process.exit(1);
