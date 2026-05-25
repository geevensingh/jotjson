#!/usr/bin/env node
// Codemod: Jasmine -> Vitest API migration (jotjson issue #47, Phase 2)
//
// One-shot script. Reads tsconfig.spec.json to determine the spec set,
// transforms each file's Jasmine API surface to Vitest, renames *.spec.ts
// -> *.test.ts, and prints a hand-review summary.
//
// This script is deleted in Phase 3 (cutover commit) alongside karma.conf.js.

import { renameSync } from 'node:fs';
import { argv } from 'node:process';
import { Node, Project } from 'ts-morph';

const dryRun = argv.includes('--dry-run');
const verbose = argv.includes('--verbose');

const project = new Project({
  tsConfigFilePath: 'tsconfig.spec.json',
  skipFileDependencyResolution: false,
});

project.addSourceFilesAtPaths(['src/testing/**/*.ts']);

const allFiles = project.getSourceFiles().filter((sf) => {
  const path = sf.getFilePath();
  return (
    (path.endsWith('.spec.ts') || path.includes('src/testing')) &&
    !path.endsWith('.perf.ts') &&
    !path.endsWith('.d.ts') &&
    path.includes('jotjson-3a43b2a9')
  );
});

const stats = {
  filesScanned: allFiles.length,
  filesChanged: 0,
  filesRenamed: 0,
  patternHits: {},
};
const flagsForHandReview = [];

function bumpHit(name) {
  stats.patternHits[name] = (stats.patternHits[name] ?? 0) + 1;
}

function flagNode(sourceFile, node, note) {
  const line = sourceFile.getLineAndColumnAtPos(node.getStart()).line;
  flagsForHandReview.push({
    file: sourceFile.getFilePath().replace(/.*[\\/]src[\\/]/, 'src/'),
    line,
    note,
  });
}

function rewriteWithContext(text) {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '/' && text[i + 1] === '/') {
      const nl = text.indexOf('\n', i);
      const end = nl === -1 ? text.length : nl;
      out += text.slice(i, end);
      i = end;
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      const close = text.indexOf('*/', i + 2);
      const end = close === -1 ? text.length : close + 2;
      out += text.slice(i, end);
      i = end;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      let j = i + 1;
      while (j < text.length) {
        if (text[j] === '\\') {
          j += 2;
          continue;
        }
        if (text[j] === quote) {
          j++;
          break;
        }
        if (quote === '`' && text[j] === '$' && text[j + 1] === '{') {
          let depth = 1;
          j += 2;
          while (j < text.length && depth > 0) {
            if (text[j] === '{') depth++;
            else if (text[j] === '}') depth--;
            j++;
          }
          continue;
        }
        j++;
      }
      out += text.slice(i, j);
      i = j;
      continue;
    }
    if (
      ch === 'e' &&
      text.startsWith('expect(', i) &&
      (i === 0 || !/[A-Za-z0-9_$]/.test(text[i - 1] ?? ''))
    ) {
      let depth = 1;
      let j = i + 7;
      while (j < text.length && depth > 0) {
        const cc = text[j];
        if (cc === '(') depth++;
        else if (cc === ')') depth--;
        else if (cc === '"' || cc === "'" || cc === '`') {
          const q = cc;
          j++;
          while (j < text.length) {
            if (text[j] === '\\') {
              j += 2;
              continue;
            }
            if (text[j] === q) {
              j++;
              break;
            }
            j++;
          }
          continue;
        }
        j++;
      }
      const expectArg = text.slice(i + 7, j - 1);
      let chainStart = j;
      while (chainStart < text.length) {
        const cc = text[chainStart];
        if (cc === ' ' || cc === '\t' || cc === '\n' || cc === '\r') {
          chainStart++;
          continue;
        }
        if (cc === '/' && text[chainStart + 1] === '/') {
          const nl = text.indexOf('\n', chainStart);
          chainStart = nl === -1 ? text.length : nl;
          continue;
        }
        if (cc === '/' && text[chainStart + 1] === '*') {
          const close = text.indexOf('*/', chainStart + 2);
          chainStart = close === -1 ? text.length : close + 2;
          continue;
        }
        break;
      }
      if (text.startsWith('.withContext(', chainStart)) {
        let mDepth = 1;
        let k = chainStart + 13;
        while (k < text.length && mDepth > 0) {
          const cc = text[k];
          if (cc === '(') mDepth++;
          else if (cc === ')') mDepth--;
          else if (cc === '"' || cc === "'" || cc === '`') {
            const q = cc;
            k++;
            while (k < text.length) {
              if (text[k] === '\\') {
                k += 2;
                continue;
              }
              if (text[k] === q) {
                k++;
                break;
              }
              k++;
            }
            continue;
          }
          k++;
        }
        // BUG FIX (vs prior version): chainStart + 13 is correct (start of
        // msg, just past .withContext( open paren). Earlier the offset
        // used `j + 13` which was inside withContext when there was any
        // whitespace between expect() and .withContext(.
        const msgArg = text.slice(chainStart + 13, k - 1);
        out += `expect(${expectArg}, ${msgArg})`;
        bumpHit('withContext');
        i = k;
        continue;
      }
      out += text.slice(i, j);
      i = j;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

function transformText(text, sourceFile) {
  let out = text;

  const simpleReplacements = [
    [/\.toBeTrue\(\)/g, '.toBe(true)', 'toBeTrue->toBe(true)'],
    [/\.toBeFalse\(\)/g, '.toBe(false)', 'toBeFalse->toBe(false)'],
    [/\.toHaveSize\(/g, '.toHaveLength(', 'toHaveSize->toHaveLength'],
    [/\bjasmine\.any\(/g, 'expect.any(', 'jasmine.any->expect.any'],
    [/\bjasmine\.anything\(/g, 'expect.anything(', 'jasmine.anything->expect.anything'],
    [/\bjasmine\.objectContaining\(/g, 'expect.objectContaining(', 'jasmine.objectContaining'],
    [/\bjasmine\.arrayContaining\(/g, 'expect.arrayContaining(', 'jasmine.arrayContaining'],
    [/\bjasmine\.stringMatching\(/g, 'expect.stringMatching(', 'jasmine.stringMatching'],
    [/\bjasmine\.clock\(\)\.install\(\)/g, 'vi.useFakeTimers()', 'jasmine.clock().install'],
    [/\bjasmine\.clock\(\)\.uninstall\(\)/g, 'vi.useRealTimers()', 'jasmine.clock().uninstall'],
    [/\bjasmine\.clock\(\)\.tick\(/g, 'vi.advanceTimersByTime(', 'jasmine.clock().tick'],
    [/\bjasmine\.clock\(\)\.mockDate\(/g, 'vi.setSystemTime(', 'jasmine.clock().mockDate'],
    [/\.calls\.count\(\)/g, '.mock.calls.length', '.calls.count'],
    [/\.calls\.allArgs\(\)/g, '.mock.calls', '.calls.allArgs'],
    [/\.calls\.first\(\)/g, '.mock.calls[0]', '.calls.first'],
    [/\.calls\.reset\(\)/g, '.mockClear()', '.calls.reset'],
    [/\.and\.returnValue\(/g, '.mockReturnValue(', '.and.returnValue'],
    [/\.and\.callFake\(/g, '.mockImplementation(', '.and.callFake'],
    [/\.and\.resolveTo\(/g, '.mockResolvedValue(', '.and.resolveTo'],
    [/\.and\.rejectWith\(/g, '.mockRejectedValue(', '.and.rejectWith'],
    [/\.and\.callThrough\(\)/g, '', '.and.callThrough (Vitest default)'],
    [/\.calls\.mostRecent\(\)\.args/g, '.mock.lastCall', '.calls.mostRecent().args'],
    [/\bxit\(/g, 'it.skip(', 'xit'],
    [/\bfit\(/g, 'it.only(', 'fit'],
    [/\bxdescribe\(/g, 'describe.skip(', 'xdescribe'],
    [/\bfdescribe\(/g, 'describe.only(', 'fdescribe'],
    [/(^|[^.\w])fail\(/g, '$1expect.fail(', 'fail->expect.fail'],
    [/\bjasmine\.createSpy\(\s*['"][^'"]*['"]\s*\)/g, 'vi.fn()', 'jasmine.createSpy(name)'],
    [/\bjasmine\.createSpy\(\)/g, 'vi.fn()', 'jasmine.createSpy()'],
    [/\bspyOn\(/g, 'vi.spyOn(', 'spyOn'],
  ];

  for (const [pattern, replacement, name] of simpleReplacements) {
    const matches = out.match(pattern);
    if (matches) {
      stats.patternHits[name] = (stats.patternHits[name] ?? 0) + matches.length;
      out = out.replace(pattern, replacement);
    }
  }

  out = out.replace(/\.calls\.argsFor\(([^()]*)\)/g, (_m, inner) => {
    bumpHit('.calls.argsFor');
    return `.mock.calls[${inner}]`;
  });

  const beforeTypes = out;
  out = out
    .replace(/\bjasmine\.SpyObj</g, 'Mocked<')
    .replace(/\bjasmine\.Spy</g, 'MockInstance<')
    .replace(/\bjasmine\.Spy\b(?!<)/g, 'MockInstance');
  if (out !== beforeTypes) bumpHit('jasmine type-position');

  out = rewriteWithContext(out);

  if (out.includes('.withContext(')) {
    const lines = out.split('\n');
    lines.forEach((line, idx) => {
      if (line.includes('.withContext(')) {
        flagsForHandReview.push({
          file: sourceFile.getFilePath().replace(/.*[\\/]src[\\/]/, 'src/'),
          line: idx + 1,
          note: 'remaining withContext after walker',
        });
      }
    });
  }

  return out;
}

function transformAst(sourceFile) {
  sourceFile.forEachDescendant((node) => {
    if (!Node.isCallExpression(node)) return;
    const expr = node.getExpression();
    if (!Node.isPropertyAccessExpression(expr)) return;
    if (expr.getName() !== 'createSpyObj') return;
    const target = expr.getExpression();
    if (!Node.isIdentifier(target) || target.getText() !== 'jasmine') return;

    const args = node.getArguments();
    let methodsArg;
    if (args.length === 1) methodsArg = args[0];
    else if (args.length >= 2) methodsArg = args[1];
    if (!methodsArg || !Node.isArrayLiteralExpression(methodsArg)) {
      flagNode(sourceFile, node, 'jasmine.createSpyObj with non-literal methods array');
      return;
    }
    const methodNames = methodsArg.getElements().map((el) => {
      if (Node.isStringLiteral(el) || Node.isNoSubstitutionTemplateLiteral(el)) {
        return el.getLiteralValue();
      }
      return null;
    });
    if (methodNames.some((name) => name === null)) {
      flagNode(sourceFile, node, 'jasmine.createSpyObj with non-string-literal method names');
      return;
    }

    const typeArg = node.getTypeArguments()[0];
    const typeArgText = typeArg ? typeArg.getText() : null;

    const objectLiteral = `{ ${methodNames.map((name) => `${name}: vi.fn()`).join(', ')} }`;
    const replacement = typeArgText ? `${objectLiteral} as Mocked<${typeArgText}>` : objectLiteral;
    node.replaceWithText(replacement);
    bumpHit('jasmine.createSpyObj');
  });

  const text = sourceFile.getFullText();
  const flagPatterns = [
    [/\bpending\(/g, 'pending() needs ctx.skip rewrite'],
    [/\bfakeAsync\(/g, 'fakeAsync needs vi.useFakeTimers rewrite'],
    [/\.and\.returnValues\(/g, 'and.returnValues needs chained mockReturnValueOnce'],
    [/\bdone\.fail\(/g, 'done.fail() needs throw/reject rewrite'],
    [/\bjasmine\.addMatchers\(/g, 'jasmine.addMatchers needs expect.extend rewrite'],
    [/\bjasmine\.SpyObj\b/g, 'remaining jasmine.SpyObj (post-transform)'],
    [/\bjasmine\.Spy\b/g, 'remaining jasmine.Spy (post-transform)'],
    [/\bjasmine\./g, 'remaining jasmine.* reference'],
  ];
  const seenInFile = new Set();
  for (const [pattern, note] of flagPatterns) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const lineNum = text.slice(0, match.index).split('\n').length;
      const key = `${lineNum}:${note}`;
      if (seenInFile.has(key)) continue;
      seenInFile.add(key);
      flagsForHandReview.push({
        file: sourceFile.getFilePath().replace(/.*[\\/]src[\\/]/, 'src/'),
        line: lineNum,
        note,
      });
    }
  }
}

function ensureTypeImports(sourceFile) {
  const text = sourceFile.getFullText();
  const needsMocked = /\bMocked\s*</.test(text);
  const needsMockInstance = /\bMockInstance\b/.test(text);
  if (!needsMocked && !needsMockInstance) return false;

  const existing = sourceFile.getImportDeclaration((d) => d.getModuleSpecifierValue() === 'vitest');
  if (existing) {
    const names = new Set(existing.getNamedImports().map((n) => n.getName()));
    if (needsMocked && !names.has('Mocked')) {
      existing.addNamedImport({ name: 'Mocked', isTypeOnly: true });
    }
    if (needsMockInstance && !names.has('MockInstance')) {
      existing.addNamedImport({ name: 'MockInstance', isTypeOnly: true });
    }
    return true;
  }

  const imports = [];
  if (needsMocked) imports.push({ name: 'Mocked', isTypeOnly: true });
  if (needsMockInstance) imports.push({ name: 'MockInstance', isTypeOnly: true });
  sourceFile.addImportDeclaration({
    namedImports: imports,
    moduleSpecifier: 'vitest',
  });
  return true;
}

for (const sourceFile of allFiles) {
  const beforeText = sourceFile.getFullText();
  const newText = transformText(beforeText, sourceFile);
  if (newText !== beforeText) sourceFile.replaceWithText(newText);
  transformAst(sourceFile);
  ensureTypeImports(sourceFile);
  if (sourceFile.getFullText() !== beforeText) {
    stats.filesChanged++;
    if (verbose) {
      console.log(`changed: ${sourceFile.getFilePath().replace(/.*[\\/]src[\\/]/, 'src/')}`);
    }
  }
}

if (!dryRun) {
  await project.save();
  for (const sourceFile of allFiles) {
    const oldPath = sourceFile.getFilePath();
    if (oldPath.endsWith('.spec.ts')) {
      const newPath = oldPath.replace(/\.spec\.ts$/, '.test.ts');
      renameSync(oldPath, newPath);
      stats.filesRenamed++;
    }
  }
}

console.log('\n=== Codemod summary ===');
console.log(`Files scanned: ${stats.filesScanned}`);
console.log(`Files changed: ${stats.filesChanged}`);
console.log(`Files renamed (.spec.ts -> .test.ts): ${stats.filesRenamed}`);
console.log('\nPattern hits:');
const sortedPatterns = Object.entries(stats.patternHits).sort((a, b) => b[1] - a[1]);
for (const [name, count] of sortedPatterns) {
  console.log(`  ${count.toString().padStart(5)}  ${name}`);
}
console.log(`\nHand-review flags: ${flagsForHandReview.length}`);
if (flagsForHandReview.length >= 1) {
  const counts = {};
  for (const item of flagsForHandReview) {
    counts[item.note] = (counts[item.note] ?? 0) + 1;
  }
  console.log('\nFlag categories:');
  for (const [note, count] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${count.toString().padStart(5)}  ${note}`);
  }
}
