// Vitest setup file: opts the L2 perf bench into the 1M-node fixture
// tier. Included by vitest.perf.config.mts only when
// JOTJSON_PERF_L2_FORCE_1M=1. Runs in the browser context before
// json-tree.component.perf.ts loads, so the spec's module-level
// defaultFixtures() call picks up the flag.
//
// Property name MUST match the spec's `ForceWindow` shape at
// json-tree.component.perf.ts:75-78 (`__perfL2Force1M`, capital M).
// A typo here silently no-ops; Phase 2 measurement scripts guard
// against this by asserting at least one `"size":"1m"` row appears
// in the captured log.
(window as Window & { __perfL2Force1M?: boolean }).__perfL2Force1M = true;
