#!/usr/bin/env node
// .tree-row Grid structural lint (issue #278). Promotes the runtime
// Karma-only structural assertions in
// `json-tree.component.grid-structural.spec.ts` to a build-time gate
// so regressions surface in milliseconds at `npm run lint` time
// instead of seconds-to-minutes inside Karma (and only when the
// relevant browser path executes).
//
// Three invariants:
//   1. Direct-child allowlist of `.tree-row`: every direct DOM child
//      must have a static `class` attribute, and at least one
//      whitespace-separated token must be in DIRECT_CHILD_ALLOWLIST.
//   2. Grid-column track integrity: inside the canonical `.tree-row`
//      SCSS block, every `> .X { grid-column: ... }` direct-child
//      rule uses one of two restricted grammar forms (bare name OR
//      `name / span <int>`) AND the name appears in
//      `grid-template-columns: ...` brackets.
//   3. `flex-shrink: 0` preserved on the three structural-wrapper
//      retainees: `.tree-twisty`, `.tree-beacon-badge`,
//      `.tree-rule-icon`. Accepts `flex-shrink: 0;`, `flex: <a> 0 <b>;`
//      (second token literally 0), or `flex: none;`.
//
// Layered defenses (multi-block guard, walker tripwire parity check,
// back-pointer comment self-assertion) are documented inline.
//
// Convention break (acknowledged): this is the FIRST
// scripts/check-*.mjs to top-level ESM-import a multi-MB dependency
// from node_modules (`@angular/compiler`). Cold-import cost measured
// at ~49ms on Node 24, well under the 500ms hysteresis threshold, so
// the gate lives in the `lint` chain (end). Future check-*.mjs
// authors should measure first and consult the decision rationale
// before importing similarly large deps.
//
// How to re-measure cold-import cost:
//   node -e "const s = Date.now(); import('@angular/compiler').then(() => console.log('compiler ms:', Date.now() - s));"
//   node scripts/check-tree-row-grid.mjs  # time the whole run
// Median of 3 cold runs. If `>500ms` AND `>20%` of the lint chain's
// wall-clock floor, propose flipping placement to `lint:all` in
// package.json. Otherwise keep in lint chain.
//
// AST-snapshot-version: @angular/compiler 21.x. The walker throws on
// unknown TmplAst* node kinds. If Angular adds a new template block
// form on a major bump, the lint fails closed with a clear
// diagnostic naming the unrecognized class; the fix is a one-line
// addition to SKIP / TRANSPARENT_DESCENT / ELEMENTAL inside
// parseAngularTemplate() plus a new fixture.

import {
  parseTemplate,
  TmplAstBoundText,
  TmplAstComponent,
  TmplAstContent,
  TmplAstDeferredBlock,
  TmplAstDeferredBlockError,
  TmplAstDeferredBlockLoading,
  TmplAstDeferredBlockPlaceholder,
  TmplAstDirective,
  TmplAstElement,
  TmplAstForLoopBlock,
  TmplAstForLoopBlockEmpty,
  TmplAstIcu,
  TmplAstIfBlock,
  TmplAstIfBlockBranch,
  TmplAstLetDeclaration,
  TmplAstSwitchBlock,
  TmplAstSwitchBlockCase,
  TmplAstSwitchBlockCaseGroup,
  TmplAstTemplate,
  TmplAstText,
  TmplAstUnknownBlock,
} from '@angular/compiler';
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..');
const CANONICAL_HTML = resolve(
  repoRoot,
  'src/app/shared/components/json-tree/json-tree.component.html',
);
const CANONICAL_SCSS = resolve(
  repoRoot,
  'src/app/shared/components/json-tree/json-tree.component.scss',
);
const BACK_POINTER_PHRASE = 'Structural invariants enforced by scripts/check-tree-row-grid.mjs';

// Boundary-aware: matches `class="tree-row"`, `class="tree-row x"`,
// `class="x tree-row"`, `class="x tree-row y"` -- but NOT
// `class="tree-row-leading"` (no whitespace/quote boundary after
// `tree-row`). Used by the walker tripwire parity check.
//
// NOTE: this regex has the `/g` flag. Callers MUST use
// `String.prototype.matchAll(htmlSrc, TREE_ROW_HTML_PATTERN)` to
// avoid mutating the shared `lastIndex` on this exported binding.
// Never call `.exec` or `.test` directly on this regex.
export const TREE_ROW_HTML_PATTERN = /class="(?:[^"]*\s)?tree-row(?:\s[^"]*)?"/g;

// Allowlisted direct-child classes of `.tree-row`. New entries
// require a `grid-template-columns:` track addition AND a paired
// `> .X { grid-column: ... }` placement rule in the canonical block.
export const DIRECT_CHILD_ALLOWLIST = new Set([
  'tree-row-leading',
  'tree-row-trailing',
  'tree-row-value-cell',
  'tree-key',
  'tree-key-sep',
  'tree-index',
  'tree-row-right',
  'sr-only',
]);

// Single source of truth for invariant #3. A rename of one of these
// classes without a constant update silently exempts it; the runtime
// Karma spec catches that, but the build-time lint here makes the
// change explicit.
export const FLEX_SHRINK_GUARDS = ['tree-twisty', 'tree-beacon-badge', 'tree-rule-icon'];

// Compound-selector strings that DO start with `.tree-row` exactly
// (no `-suffix`) and have no combinator before the body brace, but
// are exempt from the multi-block guard because they are intentional
// pseudo-/qualifier-extensions of the canonical block.
const EXEMPT_CANONICAL_COMPOUNDS = new Set([
  '.tree-row',
  '.tree-row.tree-row--close',
  '.tree-row:focus-visible',
]);

// SKIP invariant: every member of SKIP must be a class whose
// instances may appear in `Element.children` but which renders no
// DOM element of its own. Adding a non-SKIP class here would
// silently hide that class from the walker. Removing a class here
// would cause the walker to throw on encountering it (the loud
// failure we want for genuinely unknown nodes).
const SKIP = new Set([
  TmplAstText,
  TmplAstBoundText,
  TmplAstLetDeclaration,
  TmplAstContent,
  TmplAstIcu,
  TmplAstUnknownBlock,
  TmplAstDirective,
  TmplAstSwitchBlockCase,
]);

// TRANSPARENT_DESCENT invariant: each entry is a class whose
// instance does NOT render its own DOM element but DOES carry a body
// of nodes the walker must descend into. The value function returns
// the canonical child-bearing field(s); the walker does NOT
// introspect `.children` directly for these. Each entry's descent
// function declares ITS OWN canonical fields; NO `?? []` fallback
// (missing field throws TypeError = loud failure on AST drift).
// Adding an entry here grants the new class transparency in the
// walk; removing one causes the walker to throw.
const TRANSPARENT_DESCENT = new Map([
  [TmplAstIfBlock, (node) => node.branches],
  [TmplAstIfBlockBranch, (node) => node.children],
  [TmplAstSwitchBlock, (node) => node.groups],
  [TmplAstSwitchBlockCaseGroup, (node) => node.children],
  [TmplAstForLoopBlock, (node) => [...node.children, ...(node.empty ? [node.empty] : [])]],
  [TmplAstForLoopBlockEmpty, (node) => node.children],
  [
    TmplAstDeferredBlock,
    (node) => [
      ...node.children,
      ...(node.placeholder ? [node.placeholder] : []),
      ...(node.loading ? [node.loading] : []),
      ...(node.error ? [node.error] : []),
    ],
  ],
  [TmplAstDeferredBlockPlaceholder, (node) => node.children],
  [TmplAstDeferredBlockLoading, (node) => node.children],
  [TmplAstDeferredBlockError, (node) => node.children],
]);

// ELEMENTAL invariant: each entry is a class whose instance renders
// a DOM element (or, for selectorless TmplAstComponent in v21+, a
// DOM element-equivalent) AND whose `.children` is the direct-DOM-
// children list. The walker tags ELEMENTAL instances as potential
// `.tree-row` carriers and recurses into their children. Adding a
// non-elemental class here would cause the walker to enumerate it as
// a row candidate (probably wrong); removing one would cause the
// walker to skip a real DOM element.
const ELEMENTAL = new Set([TmplAstElement, TmplAstTemplate, TmplAstComponent]);

// NOT classified (intentional): TmplAstHostElement, TmplAstReference,
// TmplAstVariable, TmplAstBoundAttribute, TmplAstBoundEvent,
// TmplAstTextAttribute. These never appear in `Element.children`;
// they live on sibling fields (inputs/outputs/references/variables/
// attributes) that this walker does NOT traverse. The walker only
// enqueues `node.children` positions and the canonical descent
// fields above.

function tagNameOf(node) {
  if (node instanceof TmplAstElement) return node.name;
  if (node instanceof TmplAstTemplate) return node.tagName ?? 'ng-template';
  if (node instanceof TmplAstComponent) return node.componentName ?? '';
  return '';
}

function staticClasses(node) {
  const attributes = node.attributes ?? [];
  for (const attribute of attributes) {
    if (attribute.name === 'class' && typeof attribute.value === 'string') {
      return attribute.value
        .split(/\s+/u)
        .map((token) => token.trim())
        .filter((token) => token.length > 0);
    }
  }
  return [];
}

function hasStaticClassAttribute(node) {
  const attributes = node.attributes ?? [];
  for (const attribute of attributes) {
    if (attribute.name === 'class') return true;
  }
  return false;
}

function parseAngularTemplate(source, path) {
  const result = parseTemplate(source, path, { preserveWhitespaces: false });
  if (result.errors && result.errors.length > 0) {
    const first = result.errors[0];
    return {
      parseErrors: [
        {
          path,
          line: first.span?.start?.line != null ? first.span.start.line + 1 : 1,
          message: `parseTemplate error: ${first.msg ?? String(first)}`,
        },
      ],
      rows: [],
    };
  }
  return { parseErrors: [], rows: findTreeRows(result.nodes) };
}

// Walks the AST and returns every ELEMENTAL node whose static class
// list contains `tree-row` AND whose tag name is neither
// `ng-container` nor `ng-template`. Recurses through TRANSPARENT
// nodes via the canonical descent map. Throws on unknown node kinds.
function findTreeRows(rootNodes) {
  const rows = [];
  const queue = [...rootNodes];
  while (queue.length > 0) {
    const node = queue.shift();
    const ctor = node.constructor;
    if (ELEMENTAL.has(ctor)) {
      const classes = staticClasses(node);
      const tag = tagNameOf(node);
      const isTreeRow =
        classes.includes('tree-row') && tag !== 'ng-container' && tag !== 'ng-template';
      if (isTreeRow) rows.push(node);
      queue.push(...(node.children ?? []));
    } else if (TRANSPARENT_DESCENT.has(ctor)) {
      queue.unshift(...TRANSPARENT_DESCENT.get(ctor)(node));
    } else if (SKIP.has(ctor)) {
      // intentional skip
    } else {
      throw new Error(
        `check-tree-row-grid.mjs: unrecognized AST node ${ctor.name}. ` +
          `An Angular upgrade likely added a new template block form; ` +
          `add it to SKIP / TRANSPARENT_DESCENT / ELEMENTAL inside ` +
          `parseAngularTemplate() and add a fixture.`,
      );
    }
  }
  return rows;
}

// Returns the direct DOM children of an ELEMENTAL node, walking
// through any intervening TRANSPARENT nodes. SKIP nodes are ignored.
function directDomChildren(node) {
  const out = [];
  const queue = [...(node.children ?? [])];
  while (queue.length > 0) {
    const child = queue.shift();
    const ctor = child.constructor;
    if (ELEMENTAL.has(ctor)) {
      out.push(child);
    } else if (TRANSPARENT_DESCENT.has(ctor)) {
      queue.unshift(...TRANSPARENT_DESCENT.get(ctor)(child));
    } else if (SKIP.has(ctor)) {
      // intentional skip
    } else {
      throw new Error(
        `check-tree-row-grid.mjs: unrecognized AST node ${ctor.name}. ` +
          `An Angular upgrade likely added a new template block form; ` +
          `add it to SKIP / TRANSPARENT_DESCENT / ELEMENTAL inside ` +
          `parseAngularTemplate() and add a fixture.`,
      );
    }
  }
  return out;
}

function locationOf(node) {
  if (node.startSourceSpan?.start) {
    return {
      line: node.startSourceSpan.start.line + 1,
      column: node.startSourceSpan.start.col + 1,
    };
  }
  if (node.sourceSpan?.start) {
    return {
      line: node.sourceSpan.start.line + 1,
      column: node.sourceSpan.start.col + 1,
    };
  }
  return { line: 1, column: 1 };
}

// Consume a `/* ... */` block comment starting at `text[i]` (which
// must be `/` followed by `*`). Returns the index immediately after
// the closing `*/`. Throws a `check-tree-row-grid.mjs:`-prefixed
// error on an unterminated block comment so the CLI try/catch can
// emit a one-line diagnostic instead of silently dropping content.
// The `sitePath` argument is used to name the source file in the
// error; pass an opaque label like `'<stripScssComments>'` when the
// caller does not have a file path handy.
function consumeBlockCommentOrThrow(text, startIndex, sitePath) {
  let i = startIndex + 2;
  while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) {
    i += 1;
  }
  if (i >= text.length) {
    throw new Error(
      `check-tree-row-grid.mjs: unterminated /* ... */ block comment in ` +
        `${sitePath} (started at offset ${startIndex}).`,
    );
  }
  return i + 2;
}

// Strip SCSS line comments (`// ...`) and block comments (`/* ... */`)
// from a string. Used before tokenizing selector and declaration
// text. Conservative: does not attempt to respect strings (SCSS
// selectors don't carry comment-introducing tokens inside strings in
// any pattern used by the canonical block).
//
// LENGTH-PRESERVING: block comments are replaced with the same
// number of `\n`s for embedded newlines and ASCII spaces for every
// other character. This keeps offsets in the stripped text aligned
// 1:1 with offsets in the original `text`, so `lineStarts` (built
// from the original) gives correct line numbers when handed offsets
// from `stripped`. Line comments preserve their content's newlines
// implicitly because `//` only terminates at `\n` (which we keep).
function stripScssComments(text, sitePath = '<stripScssComments>') {
  let result = '';
  let i = 0;
  while (i < text.length) {
    if (text[i] === '/' && text[i + 1] === '/') {
      // Line comment: replace `//<content>` with spaces; leave the
      // trailing `\n` (or EOF) alone so line counts stay aligned.
      while (i < text.length && text[i] !== '\n') {
        result += ' ';
        i += 1;
      }
    } else if (text[i] === '/' && text[i + 1] === '*') {
      const start = i;
      const end = consumeBlockCommentOrThrow(text, i, sitePath);
      for (let j = start; j < end; j += 1) {
        result += text[j] === '\n' ? '\n' : ' ';
      }
      i = end;
    } else {
      result += text[i];
      i += 1;
    }
  }
  return result;
}

// Brace-aware top-level rule walker. Yields each top-level CSS rule
// (selector list + body) at file root or inside an @media/@supports/
// @container/@layer at-rule body. Yields ALSO each at-rule itself so
// callers can decide whether to recurse. Each yielded item carries
// the source offsets so callers can compute line numbers via
// lineNumberForOffset.
function* walkScssRules(text) {
  let i = 0;
  const len = text.length;
  while (i < len) {
    while (i < len && /\s/u.test(text[i])) i += 1;
    if (i >= len) break;
    if (text[i] === '/' && text[i + 1] === '/') {
      while (i < len && text[i] !== '\n') i += 1;
      continue;
    }
    if (text[i] === '/' && text[i + 1] === '*') {
      i = consumeBlockCommentOrThrow(text, i, '<walkScssRules>');
      continue;
    }
    const headerStart = i;
    while (i < len && text[i] !== '{' && text[i] !== ';') i += 1;
    if (i >= len || text[i] === ';') {
      i += 1;
      continue;
    }
    const header = text.slice(headerStart, i).trim();
    i += 1;
    const bodyStart = i;
    let depth = 1;
    while (i < len && depth > 0) {
      const ch = text[i];
      if (ch === '/' && text[i + 1] === '/') {
        while (i < len && text[i] !== '\n') i += 1;
        continue;
      }
      if (ch === '/' && text[i + 1] === '*') {
        i = consumeBlockCommentOrThrow(text, i, '<walkScssRules:body>');
        continue;
      }
      if (ch === '{') depth += 1;
      else if (ch === '}') depth -= 1;
      i += 1;
    }
    const bodyEnd = i - 1;
    yield { header, headerStart, body: text.slice(bodyStart, bodyEnd), bodyStart };
  }
}

// Yields every top-level rule whose selector list includes the
// canonical `.tree-row` compound (per the multi-block guard rules).
// Recurses into @media/@supports/@container/@layer bodies. Does NOT
// recurse into other rule bodies (those are nested children of some
// other selector and are not "top-level" for canonical-block
// purposes).
function* walkTopLevelTreeRowCandidates(text) {
  const AT_RULE_PATTERN = /^@(media|supports|container|layer)\b/u;
  function* recurse(scope) {
    for (const rule of walkScssRules(scope)) {
      if (rule.header.startsWith('@')) {
        if (AT_RULE_PATTERN.test(rule.header)) {
          yield* recurse(rule.body);
        }
        continue;
      }
      yield rule;
    }
  }
  yield* recurse(text);
}

// Returns true if the compound selector string is a candidate
// canonical `.tree-row` block per the v4-final multi-block guard
// rules:
//   1. First simple-selector token == `.tree-row` exactly (not
//      `.tree-row-*` / `.tree-row5` / `.tree-row_x` -- any
//      CSS-identifier-continuation character disqualifies).
//   2. No combinator (space, `>`, `+`, `~`) between `.tree-row` and
//      end of compound.
//
// CSS identifier continuation chars: `[a-zA-Z0-9_-]` (plus non-ASCII
// per the CSS spec; we don't expect those in this codebase but the
// `\w` class would miss them and we still want to reject them). The
// `/^[\w-]/u` test rejects any of `_`, `-`, `0-9`, `a-z`, `A-Z` at
// `afterPrefix[0]`, which is exactly the "the previous selector
// hadn't ended at `.tree-row`" condition.
function isCandidateCanonicalCompound(compound) {
  const trimmed = compound.trim();
  if (!trimmed.startsWith('.tree-row')) return false;
  const afterPrefix = trimmed.slice('.tree-row'.length);
  if (/^[\w-]/u.test(afterPrefix)) return false;
  for (const ch of afterPrefix) {
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '>' || ch === '+' || ch === '~') {
      return false;
    }
  }
  return true;
}

function buildLineStarts(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '\n') starts.push(i + 1);
  }
  return starts;
}

function lineNumberForOffset(lineStarts, offset) {
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const start = lineStarts[mid];
    const nextStart = mid + 1 < lineStarts.length ? lineStarts[mid + 1] : Infinity;
    if (offset < start) hi = mid - 1;
    else if (offset >= nextStart) lo = mid + 1;
    else return mid + 1;
  }
  return lineStarts.length;
}

// Tokenize a value string into whitespace-separated tokens, treating
// `(...)` groups (e.g., `calc(100% - 8px)`) as a single token.
function tokenizeValue(value) {
  const tokens = [];
  let i = 0;
  while (i < value.length) {
    while (i < value.length && /\s/u.test(value[i])) i += 1;
    if (i >= value.length) break;
    let start = i;
    let parenDepth = 0;
    while (i < value.length) {
      const ch = value[i];
      if (ch === '(') parenDepth += 1;
      else if (ch === ')') parenDepth -= 1;
      else if (/\s/u.test(ch) && parenDepth === 0) break;
      i += 1;
    }
    tokens.push(value.slice(start, i));
  }
  return tokens;
}

function parseGridTemplateColumnsTracks(declarationValue) {
  const tracks = new Set();
  const pattern = /\[([-_a-zA-Z][-_a-zA-Z0-9]*)\]/gu;
  let match;
  while ((match = pattern.exec(declarationValue)) !== null) {
    tracks.add(match[1]);
  }
  return tracks;
}

// Find the first top-level (within `body`) declaration matching
// `prop: <value>;`. Returns { value, offset } or null. Body is
// expected to already have `> .X { ... }` nested rules so we must
// skip braces. Comments stripped by caller.
function findTopLevelDeclaration(body, property) {
  let i = 0;
  while (i < body.length) {
    while (i < body.length && /\s/u.test(body[i])) i += 1;
    if (i >= body.length) break;
    if (body[i] === '/' && body[i + 1] === '/') {
      while (i < body.length && body[i] !== '\n') i += 1;
      continue;
    }
    if (body[i] === '/' && body[i + 1] === '*') {
      i = consumeBlockCommentOrThrow(body, i, '<findTopLevelDeclaration>');
      continue;
    }
    const start = i;
    let semiOrBraceIndex = -1;
    let depth = 0;
    while (i < body.length) {
      const ch = body[i];
      if (ch === '(') {
        depth += 1;
      } else if (ch === ')') {
        depth -= 1;
      } else if (depth === 0 && ch === ';') {
        semiOrBraceIndex = i;
        break;
      } else if (depth === 0 && ch === '{') {
        semiOrBraceIndex = i;
        break;
      }
      i += 1;
    }
    if (semiOrBraceIndex === -1) break;
    const chunk = body.slice(start, semiOrBraceIndex);
    if (body[semiOrBraceIndex] === '{') {
      let braceDepth = 1;
      i = semiOrBraceIndex + 1;
      while (i < body.length && braceDepth > 0) {
        if (body[i] === '{') braceDepth += 1;
        else if (body[i] === '}') braceDepth -= 1;
        i += 1;
      }
      continue;
    }
    const colonIdx = chunk.indexOf(':');
    if (colonIdx !== -1) {
      const propName = chunk.slice(0, colonIdx).trim();
      if (propName === property) {
        return {
          value: chunk.slice(colonIdx + 1).trim(),
          offset: start,
        };
      }
    }
    i = semiOrBraceIndex + 1;
  }
  return null;
}

// Find every direct-child nested rule of the form
// `> .X { ... }` inside the canonical block body. Returns an array
// of { className, body, offset }.
function findDirectChildRules(body) {
  const rules = [];
  for (const rule of walkScssRules(body)) {
    const header = rule.header;
    const directChildMatch = header.match(/^>\s*\.([-_a-zA-Z][-_a-zA-Z0-9]*)\s*$/u);
    if (directChildMatch) {
      rules.push({
        className: directChildMatch[1],
        body: rule.body,
        offset: rule.headerStart,
      });
    }
  }
  return rules;
}

function parseGridColumnValue(value) {
  const trimmed = value.trim();
  const bareMatch = trimmed.match(/^([-_a-zA-Z][-_a-zA-Z0-9]*)$/u);
  if (bareMatch) {
    return { ok: true, name: bareMatch[1], span: 1 };
  }
  const spanMatch = trimmed.match(/^([-_a-zA-Z][-_a-zA-Z0-9]*)\s*\/\s*span\s+(\d+)$/u);
  if (spanMatch) {
    return { ok: true, name: spanMatch[1], span: Number.parseInt(spanMatch[2], 10) };
  }
  return { ok: false };
}

function bodyHasAcceptedFlexShrink(body) {
  const stripped = stripScssComments(body);
  let i = 0;
  while (i < stripped.length) {
    while (i < stripped.length && /\s/u.test(stripped[i])) i += 1;
    if (i >= stripped.length) break;
    const start = i;
    let depth = 0;
    let semiOrBraceIndex = -1;
    while (i < stripped.length) {
      const ch = stripped[i];
      if (ch === '(') depth += 1;
      else if (ch === ')') depth -= 1;
      else if (depth === 0 && ch === ';') {
        semiOrBraceIndex = i;
        break;
      } else if (depth === 0 && ch === '{') {
        let braceDepth = 1;
        i += 1;
        while (i < stripped.length && braceDepth > 0) {
          if (stripped[i] === '{') braceDepth += 1;
          else if (stripped[i] === '}') braceDepth -= 1;
          i += 1;
        }
        semiOrBraceIndex = -2;
        break;
      }
      i += 1;
    }
    if (semiOrBraceIndex === -2) continue;
    if (semiOrBraceIndex === -1) break;
    const chunk = stripped.slice(start, semiOrBraceIndex);
    const colonIdx = chunk.indexOf(':');
    if (colonIdx !== -1) {
      const propName = chunk.slice(0, colonIdx).trim();
      const value = chunk.slice(colonIdx + 1).trim();
      if (propName === 'flex-shrink') {
        if (value === '0') return true;
      } else if (propName === 'flex') {
        if (value === 'none') return true;
        const tokens = tokenizeValue(value);
        if (tokens.length >= 2 && tokens[1] === '0') return true;
      }
    }
    i = semiOrBraceIndex + 1;
  }
  return false;
}

// Tokenize a comma-separated selector list. Respects parentheses
// (e.g., `:is(.a, .b)`).
function splitSelectorList(selectorList) {
  const compounds = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < selectorList.length; i += 1) {
    const ch = selectorList[i];
    if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
    else if (ch === ',' && depth === 0) {
      compounds.push(selectorList.slice(start, i).trim());
      start = i + 1;
    }
  }
  compounds.push(selectorList.slice(start).trim());
  return compounds.filter((c) => c.length > 0);
}

function scanScss(scssSrc, scssPath) {
  const violations = [];
  const stripped = stripScssComments(scssSrc, scssPath);
  const lineStarts = buildLineStarts(scssSrc);

  let canonicalBlock = null;
  let closeBlock = null;
  const candidateCompoundsSeen = [];

  for (const rule of walkTopLevelTreeRowCandidates(stripped)) {
    if (rule.header.startsWith('@')) continue;
    const compounds = splitSelectorList(rule.header);
    let isCandidate = false;
    let matchingCompound = null;
    for (const compound of compounds) {
      if (isCandidateCanonicalCompound(compound)) {
        isCandidate = true;
        matchingCompound = compound;
        break;
      }
    }
    if (!isCandidate) continue;
    candidateCompoundsSeen.push({
      compound: matchingCompound,
      offset: rule.headerStart,
      body: rule.body,
      bodyStart: rule.bodyStart,
    });
  }

  for (const candidate of candidateCompoundsSeen) {
    if (EXEMPT_CANONICAL_COMPOUNDS.has(candidate.compound)) {
      if (candidate.compound === '.tree-row') {
        if (canonicalBlock === null) {
          canonicalBlock = candidate;
        } else {
          violations.push({
            path: scssPath,
            line: lineNumberForOffset(lineStarts, candidate.offset),
            message:
              `multi-block guard: second canonical .tree-row block detected ` +
              `(only one allowed at file root or @media/@supports/@container/@layer body); ` +
              `extend EXEMPT_CANONICAL_COMPOUNDS in check-tree-row-grid.mjs or refactor.`,
          });
        }
      } else if (candidate.compound === '.tree-row.tree-row--close' && closeBlock === null) {
        closeBlock = candidate;
      }
      continue;
    }
    violations.push({
      path: scssPath,
      line: lineNumberForOffset(lineStarts, candidate.offset),
      message:
        `multi-block guard: unexpected compound selector "${candidate.compound}" ` +
        `that begins with .tree-row (not a -suffix sibling like .tree-row-leading); ` +
        `extend EXEMPT_CANONICAL_COMPOUNDS in check-tree-row-grid.mjs or refactor.`,
    });
  }

  if (canonicalBlock === null) {
    violations.push({
      path: scssPath,
      line: 1,
      message:
        `canonical .tree-row block not found; expected one top-level ` +
        `\`.tree-row { ... }\` rule in this file.`,
    });
    return { violations, canonicalBlock };
  }

  const canonicalBody = canonicalBlock.body;
  const canonicalBodyStart = canonicalBlock.bodyStart;
  const gridTemplateDeclaration = findTopLevelDeclaration(canonicalBody, 'grid-template-columns');
  let declaredTracks = new Set();
  if (gridTemplateDeclaration) {
    declaredTracks = parseGridTemplateColumnsTracks(gridTemplateDeclaration.value);
  } else {
    violations.push({
      path: scssPath,
      line: lineNumberForOffset(lineStarts, canonicalBodyStart),
      message:
        `canonical .tree-row block is missing a \`grid-template-columns:\` ` +
        `declaration with at least one bracketed track name.`,
    });
  }

  const directRules = findDirectChildRules(canonicalBody);
  for (const directRule of directRules) {
    const gridColumn = findTopLevelDeclaration(directRule.body, 'grid-column');
    if (!gridColumn) continue;
    const parsed = parseGridColumnValue(gridColumn.value);
    const absoluteOffset = canonicalBodyStart + directRule.offset;
    if (!parsed.ok) {
      violations.push({
        path: scssPath,
        line: lineNumberForOffset(lineStarts, absoluteOffset),
        message:
          `unsupported \`grid-column\` form "${gridColumn.value}" in ` +
          `\`> .${directRule.className} { ... }\`. Accepted grammar: ` +
          `\`<name>\` or \`<name> / span <integer>\` (see ` +
          `scripts/check-tree-row-grid.mjs).`,
      });
      continue;
    }
    if (declaredTracks.size > 0 && !declaredTracks.has(parsed.name)) {
      violations.push({
        path: scssPath,
        line: lineNumberForOffset(lineStarts, absoluteOffset),
        message:
          `\`grid-column: ${gridColumn.value}\` references track "${parsed.name}" ` +
          `which is not declared as \`[${parsed.name}]\` in this block's ` +
          `\`grid-template-columns\`. Add it to the template or correct the reference.`,
      });
    }
  }

  for (const className of FLEX_SHRINK_GUARDS) {
    // Find the retainee rule via the same top-level walk used for
    // the canonical `.tree-row` block detection (covers file root
    // and `@media`/`@supports`/`@container`/`@layer` bodies; does
    // NOT match nested-only declarations like
    // `.parent { .${className} { ... } }`, which would be at
    // greater specificity and would not actually preserve the
    // top-level retainee class's `flex-shrink: 0`). Same bug class
    // as F2 -- a flat regex like `(?:^|\n)\s*\.X\s*\{` would match
    // a `.${className}` inside another rule's body, missing the
    // top-level semantics this lint must enforce.
    let foundRule = null;
    let foundOffset = -1;
    for (const rule of walkTopLevelTreeRowCandidates(stripped)) {
      if (rule.header.startsWith('@')) continue;
      const compounds = splitSelectorList(rule.header);
      for (const compound of compounds) {
        if (compound.trim() === `.${className}`) {
          foundRule = rule;
          foundOffset = rule.headerStart + rule.header.indexOf(`.${className}`);
          break;
        }
      }
      if (foundRule) break;
    }
    if (!foundRule) {
      violations.push({
        path: scssPath,
        line: 1,
        message:
          `flex-shrink retainee block not found: expected a top-level ` +
          `\`.${className} { ... }\` SCSS block (FLEX_SHRINK_GUARDS in ` +
          `check-tree-row-grid.mjs).`,
      });
      continue;
    }
    if (!bodyHasAcceptedFlexShrink(foundRule.body)) {
      violations.push({
        path: scssPath,
        line: lineNumberForOffset(lineStarts, foundOffset),
        message:
          `\`.${className}\` block is missing a shrink-of-zero declaration. ` +
          `Accepted forms: \`flex-shrink: 0;\`, \`flex: <grow> 0 [<basis>];\` ` +
          `(second token literally 0), or \`flex: none;\` (see ` +
          `scripts/check-tree-row-grid.mjs FLEX_SHRINK_GUARDS).`,
      });
    }
  }

  // Issue #282 (v0.28.2): assert the close-row block declares
  // `display: flex`. The `lintTemplate` carve-out at the top of
  // this file accepts ANY direct-child class on `.tree-row--close`
  // rows on the premise that they are `display: flex` and the grid
  // direct-child allowlist doesn't apply. If a future contributor
  // flips this block to `display: grid` (or removes the `display`
  // declaration so it inherits the canonical `display: grid` from
  // `.tree-row`), the carve-out becomes a silent gap. This
  // assertion fails loudly in that case.
  if (closeBlock === null) {
    violations.push({
      path: scssPath,
      line: 1,
      message:
        `close-row block not found: expected one top-level ` +
        `\`.tree-row.tree-row--close { ... }\` rule. The lintTemplate ` +
        `carve-out for close rows assumes this block exists and ` +
        `declares \`display: flex\`.`,
    });
  } else {
    const displayDeclaration = findTopLevelDeclaration(closeBlock.body, 'display');
    if (!displayDeclaration || displayDeclaration.value.trim() !== 'flex') {
      violations.push({
        path: scssPath,
        line: lineNumberForOffset(lineStarts, closeBlock.offset),
        message:
          `\`.tree-row.tree-row--close\` must declare \`display: flex\` ` +
          `(found: ${displayDeclaration ? `\`display: ${displayDeclaration.value.trim()}\`` : 'no `display` declaration'}). ` +
          `The lintTemplate carve-out for close rows assumes this; ` +
          `flipping to grid without lifting the carve-out would silently ` +
          `accept any direct-child class on close rows.`,
      });
    }
  }

  return { violations, canonicalBlock };
}

export function lintTemplate({ htmlSrc, scssSrc, htmlPath, scssPath }) {
  const violations = [];
  const { parseErrors, rows } = parseAngularTemplate(htmlSrc, htmlPath);
  if (parseErrors.length > 0) {
    violations.push(...parseErrors);
    return violations;
  }
  for (const row of rows) {
    const rowClasses = staticClasses(row);
    // `.tree-row.tree-row--close` is `display: flex` (scss block at
    // `.tree-row.tree-row--close`), so the Grid direct-child
    // allowlist doesn't apply: grid-column placements on its
    // children would be inert. Close rows still use the same three
    // structural wrappers as leaf/open rows (`tree-row-leading`,
    // `tree-row-value-cell`, `tree-row-trailing`) for visual parity
    // (issue #282, v0.28.2), but the carve-out remains because the
    // grid-track invariants in `lintTemplate` don't model flex
    // layout. The SCSS-side `scanScss` checks that this block
    // declares `display: flex` so a future contributor flipping the
    // display value can't silently regress the carve-out into a
    // silent gap.
    if (rowClasses.includes('tree-row--close')) continue;
    const children = directDomChildren(row);
    for (const child of children) {
      const tag = tagNameOf(child);
      if (tag === 'ng-container' || tag === 'ng-template') continue;
      if (!hasStaticClassAttribute(child)) {
        const loc = locationOf(child);
        violations.push({
          path: htmlPath,
          line: loc.line,
          message:
            `direct child of .tree-row has no static \`class\` attribute; ` +
            `the build-time lint cannot statically validate fully-dynamic ` +
            `children. Add a static class containing one of: ` +
            `${[...DIRECT_CHILD_ALLOWLIST].join(', ')}.`,
        });
        continue;
      }
      const classes = staticClasses(child);
      const hasAllowed = classes.some((token) => DIRECT_CHILD_ALLOWLIST.has(token));
      if (!hasAllowed) {
        const loc = locationOf(child);
        violations.push({
          path: htmlPath,
          line: loc.line,
          message:
            `direct child of .tree-row has class="${classes.join(' ')}" ` +
            `but none of those tokens are in DIRECT_CHILD_ALLOWLIST ` +
            `(${[...DIRECT_CHILD_ALLOWLIST].join(', ')}). Add the new ` +
            `class to the allowlist (after pairing it with a ` +
            `grid-template-columns track + > .X placement rule).`,
        });
      }
    }
  }
  const { violations: scssViolations } = scanScss(scssSrc, scssPath);
  violations.push(...scssViolations);
  return violations;
}

export function countTreeRowAttributes(htmlSrc) {
  // `matchAll` does not mutate the regex's `lastIndex` between calls,
  // so the shared exported `TREE_ROW_HTML_PATTERN` stays safe even if
  // any other caller is using `exec`/`test` on it concurrently in
  // some future code path. (Today, this is the only caller; the
  // safety is a defense-in-depth guarantee.)
  let count = 0;
  for (const _match of htmlSrc.matchAll(TREE_ROW_HTML_PATTERN)) count += 1;
  return count;
}

export function lintCanonicalFiles() {
  const htmlSrc = readFileSync(CANONICAL_HTML, 'utf8');
  const scssSrc = readFileSync(CANONICAL_SCSS, 'utf8');
  const violations = lintTemplate({
    htmlSrc,
    scssSrc,
    htmlPath: CANONICAL_HTML,
    scssPath: CANONICAL_SCSS,
  });
  if (!htmlSrc.includes(BACK_POINTER_PHRASE)) {
    violations.push({
      path: CANONICAL_HTML,
      line: 1,
      message:
        `back-pointer comment missing: expected to find the phrase ` +
        `"${BACK_POINTER_PHRASE}" somewhere in the HTML. Without it, a ` +
        `rename of this lint would silently lose its anchor. Restore the ` +
        `back-pointer near the first .tree-row.`,
    });
  }
  if (!scssSrc.includes(BACK_POINTER_PHRASE)) {
    violations.push({
      path: CANONICAL_SCSS,
      line: 1,
      message:
        `back-pointer comment missing: expected to find the phrase ` +
        `"${BACK_POINTER_PHRASE}" somewhere in the SCSS. Without it, a ` +
        `rename of this lint would silently lose its anchor. Restore the ` +
        `back-pointer inside the canonical .tree-row block.`,
    });
  }
  const { parseErrors, rows } = parseAngularTemplate(htmlSrc, CANONICAL_HTML);
  if (parseErrors.length === 0) {
    const walkerCount = rows.length;
    const regexCount = countTreeRowAttributes(htmlSrc);
    if (walkerCount === 0) {
      violations.push({
        path: CANONICAL_HTML,
        line: 1,
        message:
          `walker tripwire: zero .tree-row elements found in the AST walk; ` +
          `the walker appears to be a no-op. Check if .tree-row markup has ` +
          `moved out of json-tree.component.html OR the AST descent is ` +
          `short-circuiting (e.g., a missing transparent block entry).`,
      });
    } else if (walkerCount !== regexCount) {
      violations.push({
        path: CANONICAL_HTML,
        line: 1,
        message:
          `walker tripwire parity drift: AST walker found ${walkerCount} ` +
          `.tree-row elements; boundary-aware regex found ${regexCount}. ` +
          (walkerCount > regexCount
            ? `Walker > regex: the AST is finding rows the static-pattern ` +
              `scan missed -- check if the file added a non-standard ` +
              `class-attribute form (e.g., backslash escapes, multi-line ` +
              `attribute).`
            : `Walker < regex: the AST descent is missing rows -- check ` +
              `if a new transparent block kind needs to be added to ` +
              `TRANSPARENT_DESCENT inside parseAngularTemplate().`),
      });
    }
  }
  return violations;
}

function emitDiagnostics(violations, scriptPathForCi) {
  for (const violation of violations) {
    console.error(`${violation.path}:${violation.line}: ${violation.message}`);
  }
  if (process.env.GITHUB_ACTIONS === 'true') {
    for (const violation of violations) {
      const file = violation.path.replace(/%/g, '%25');
      const message = violation.message
        .replace(/%/g, '%25')
        .replace(/\r/g, '%0D')
        .replace(/\n/g, '%0A');
      console.log(`::error file=${file},line=${violation.line}::${message}`);
    }
  }
}

// Detects whether this module is the CLI entry point. Uses the repo
// idiom shared with `check-deploy-freshness.mjs`,
// `check-csp-hashes.mjs`, `check-prod-patterns.mjs`,
// `check-lockfile.mjs`, `check-swa-config.mjs`, and
// `write-ngsw-appdata.mjs`: convert `process.argv[1]` to a file URL
// via `pathToFileURL` (handles backslashes / drive letters / the
// triple-slash boundary correctly on every platform) after resolving
// symlinks via `realpathSync` (so a script invoked through a symlink
// still detects as main). Compare strict-equal against
// `import.meta.url`.
function isMain() {
  if (!process.argv[1]) return false;
  try {
    const realPath = realpathSync(process.argv[1]);
    return pathToFileURL(realPath).href === import.meta.url;
  } catch {
    return false;
  }
}

if (isMain()) {
  let violations;
  try {
    violations = lintCanonicalFiles();
  } catch (error) {
    const message = error?.message ?? String(error);
    if (typeof message === 'string' && message.startsWith('check-tree-row-grid.mjs:')) {
      console.error(`check-tree-row-grid: ${message}`);
      if (process.env.GITHUB_ACTIONS === 'true') {
        const safeMessage = message
          .replace(/%/g, '%25')
          .replace(/\r/g, '%0D')
          .replace(/\n/g, '%0A');
        console.log(`::error::${safeMessage}`);
      }
      process.exit(2);
    }
    throw error;
  }
  if (violations.length === 0) {
    console.log(`check-tree-row-grid: OK (2 files scanned, 0 violations)`);
    process.exit(0);
  }
  console.error('check-tree-row-grid: violations found:');
  emitDiagnostics(violations);
  console.error(`\n${violations.length} violation(s).`);
  process.exit(1);
}
