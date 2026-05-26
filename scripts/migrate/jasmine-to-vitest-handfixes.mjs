#!/usr/bin/env node
// One-shot helper: mechanical hand-review fixes the AST codemod
// (scripts/migrate/jasmine-to-vitest.mjs) flagged but did not rewrite.
// Deleted in Phase 3 alongside the main codemod.
//
// Modes (pass exactly one):
//   --returnValues          Rewrite .and.returnValues(a, b, c) -> chained .mockReturnValueOnce(...)
//   --typed-createspy       Rewrite jasmine.createSpy<T>('name') -> vi.fn<T>()
//   --tagged-createspy      Rewrite jasmine.createSpy(`tpl`) -> vi.fn() and inject .mockName(tpl)
//                           Also covers untagged jasmine.createSpy(`tpl`) form the main codemod missed.
//   --multiline-createspy   Collapse `jasmine\n.createSpy*` to single line, then convert both
//                           typed and untyped forms to vi.fn() / vi.fn<T>().

import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { argv } from 'node:process';

const mode = argv.find((a) => a.startsWith('--'));
if (!mode) {
  console.error('usage: node scripts/migrate/jasmine-to-vitest-handfixes.mjs <mode>');
  process.exit(2);
}

function listFiles(pattern) {
  // git grep -l "pattern" -- "src/**/*.test.ts"
  try {
    const out = execSync(`git grep -lE "${pattern}" -- "src/**/*.test.ts"`, { encoding: 'utf8' });
    return out.split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

function findMatchingParen(text, openIdx) {
  // text[openIdx] === '('. Returns index of matching ')' or -1.
  let depth = 0;
  let i = openIdx;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return i;
    } else if (ch === '"' || ch === "'" || ch === '`') {
      const q = ch;
      i++;
      while (i < text.length) {
        if (text[i] === '\\') {
          i += 2;
          continue;
        }
        if (text[i] === q) break;
        if (q === '`' && text[i] === '$' && text[i + 1] === '{') {
          let braceDepth = 1;
          i += 2;
          while (i < text.length && braceDepth > 0) {
            if (text[i] === '{') braceDepth++;
            else if (text[i] === '}') braceDepth--;
            i++;
          }
          continue;
        }
        i++;
      }
    } else if (ch === '/' && text[i + 1] === '/') {
      const nl = text.indexOf('\n', i);
      i = nl === -1 ? text.length : nl;
      continue;
    } else if (ch === '/' && text[i + 1] === '*') {
      const close = text.indexOf('*/', i + 2);
      i = close === -1 ? text.length : close + 2;
      continue;
    }
    i++;
  }
  return -1;
}

function splitTopLevelArgs(inner) {
  // Split `a, b, c` at top-level commas, respecting parens / brackets / braces / strings.
  const parts = [];
  let start = 0;
  let depth = 0;
  let i = 0;
  while (i < inner.length) {
    const ch = inner[i];
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    else if (ch === '"' || ch === "'" || ch === '`') {
      const q = ch;
      i++;
      while (i < inner.length) {
        if (inner[i] === '\\') {
          i += 2;
          continue;
        }
        if (inner[i] === q) break;
        if (q === '`' && inner[i] === '$' && inner[i + 1] === '{') {
          let braceDepth = 1;
          i += 2;
          while (i < inner.length && braceDepth > 0) {
            if (inner[i] === '{') braceDepth++;
            else if (inner[i] === '}') braceDepth--;
            i++;
          }
          continue;
        }
        i++;
      }
    } else if (ch === ',' && depth === 0) {
      parts.push(inner.slice(start, i));
      start = i + 1;
    }
    i++;
  }
  parts.push(inner.slice(start));
  return parts.map((p) => p.trim()).filter((p) => p.length > 0);
}

function rewriteReturnValues(text) {
  let out = '';
  let i = 0;
  let hits = 0;
  while (i < text.length) {
    const idx = text.indexOf('.and.returnValues(', i);
    if (idx === -1) {
      out += text.slice(i);
      break;
    }
    out += text.slice(i, idx);
    const parenOpen = idx + '.and.returnValues'.length;
    const parenClose = findMatchingParen(text, parenOpen);
    if (parenClose === -1) {
      // Unbalanced; bail out to avoid corruption.
      out += text.slice(idx);
      break;
    }
    const innerStart = parenOpen + 1;
    const inner = text.slice(innerStart, parenClose);
    const args = splitTopLevelArgs(inner);
    if (args.length === 0) {
      out += '.and.returnValues()';
      i = parenClose + 1;
      continue;
    }
    const chained = args.map((a) => `.mockReturnValueOnce(${a})`).join('');
    out += chained;
    hits++;
    i = parenClose + 1;
  }
  return { out, hits };
}

function rewriteTypedCreateSpy(text) {
  // jasmine.createSpy<TypeArgs>('name')  ->  vi.fn<TypeArgs>()
  // Handle TypeArgs that may itself contain <...> (e.g., () => Promise<number>).
  let out = '';
  let i = 0;
  let hits = 0;
  while (i < text.length) {
    const idx = text.indexOf('jasmine.createSpy<', i);
    if (idx === -1) {
      out += text.slice(i);
      break;
    }
    out += text.slice(i, idx);
    let depth = 0;
    let j = idx + 'jasmine.createSpy'.length;
    if (text[j] !== '<') {
      out += text.slice(idx, j);
      i = j;
      continue;
    }
    // Walk through balanced <...>. Tricky: must NOT decrement on the `>`
    // of `=>` (arrow type) which is common in generic type args like
    // `<() => void>`. Same for `>=` but that's not a valid type-arg shape.
    while (j < text.length) {
      const ch = text[j];
      if (ch === '<') {
        depth++;
      } else if (ch === '>' && text[j - 1] !== '=') {
        depth--;
        if (depth === 0) {
          j++;
          break;
        }
      }
      j++;
    }
    const typeArgs = text.slice(idx + 'jasmine.createSpy'.length, j);
    if (text[j] !== '(') {
      out += text.slice(idx, j);
      i = j;
      continue;
    }
    const parenClose = findMatchingParen(text, j);
    if (parenClose === -1) {
      out += text.slice(idx);
      break;
    }
    out += `vi.fn${typeArgs}()`;
    hits++;
    i = parenClose + 1;
  }
  return { out, hits };
}

function rewriteTaggedCreateSpy(text) {
  // jasmine.createSpy(`...`) -> vi.fn().mockName(`...`)
  // Note: this is the BACKTICK template-literal form the codemod's
  // simple-quoted-string regex missed.
  let out = '';
  let i = 0;
  let hits = 0;
  while (i < text.length) {
    const idx = text.indexOf('jasmine.createSpy(`', i);
    if (idx === -1) {
      out += text.slice(i);
      break;
    }
    out += text.slice(i, idx);
    const parenOpen = idx + 'jasmine.createSpy'.length;
    const parenClose = findMatchingParen(text, parenOpen);
    if (parenClose === -1) {
      out += text.slice(idx);
      break;
    }
    const inner = text.slice(parenOpen + 1, parenClose).trim();
    out += `vi.fn().mockName(${inner})`;
    hits++;
    i = parenClose + 1;
  }
  return { out, hits };
}

function rewriteMultilineCreateSpy(text) {
  // Step 1: collapse `jasmine\s*\n\s*\.createSpy` -> `jasmine.createSpy`.
  // Prettier will reflow the resulting long line.
  const collapsed = text.replace(/\bjasmine\s*\n\s*\.createSpy\b/g, 'jasmine.createSpy');
  let hits = 0;
  if (collapsed !== text) {
    const before = (text.match(/\bjasmine\s*\n\s*\.createSpy\b/g) || []).length;
    hits += before;
  }

  // Step 2: apply typed conversion (handles `jasmine.createSpy<T>(...)`).
  let { out: afterTyped } = rewriteTypedCreateSpy(collapsed);

  // Step 3: untyped form `jasmine.createSpy('name'|"name")` -> `vi.fn()`.
  // Drops the name to match the original codemod's existing convention.
  afterTyped = afterTyped.replace(/\bjasmine\.createSpy\(\s*['"][^'"]*['"]\s*\)/g, 'vi.fn()');

  // Step 4: backtick template-literal form `jasmine.createSpy(`...`)` -> `vi.fn().mockName(`...`)`.
  ({ out: afterTyped } = (() => {
    const r = rewriteTaggedCreateSpy(afterTyped);
    return r;
  })());

  return { out: afterTyped, hits };
}

const handlers = {
  '--returnValues': {
    pattern: '\\.and\\.returnValues\\(',
    rewrite: rewriteReturnValues,
  },
  '--typed-createspy': {
    pattern: 'jasmine\\.createSpy<',
    rewrite: rewriteTypedCreateSpy,
  },
  '--tagged-createspy': {
    pattern: 'jasmine\\.createSpy\\(`',
    rewrite: rewriteTaggedCreateSpy,
  },
  '--multiline-createspy': {
    pattern: 'jasmine',
    rewrite: rewriteMultilineCreateSpy,
  },
};

const handler = handlers[mode];
if (!handler) {
  console.error(`unknown mode: ${mode}. Known: ${Object.keys(handlers).join(', ')}`);
  process.exit(2);
}

const files = listFiles(handler.pattern);
if (files.length === 0) {
  console.log(`${mode}: no matches; nothing to do.`);
  process.exit(0);
}

let totalHits = 0;
for (const rel of files) {
  const buf = readFileSync(rel, 'utf8');
  const { out, hits } = handler.rewrite(buf);
  if (hits > 0 && out !== buf) {
    writeFileSync(rel, out);
    totalHits += hits;
    console.log(`  ${hits.toString().padStart(4)}  ${rel}`);
  }
}
console.log(`\n${mode}: ${totalHits} rewrites across ${files.length} files.`);
