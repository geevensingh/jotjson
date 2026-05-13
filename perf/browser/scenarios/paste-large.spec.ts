// Layer-3 scenario: paste-large.
//
// The flagship perf bench. Drives the user-pain flow:
//   1. Boot the production bundle.
//   2. Wait for Monaco to load.
//   3. Paste a large JSON string into the editor.
//   4. Wait for the tree to render its first row.
//   5. Capture wall-clock + longtask + heap delta.
//   6. CDP `Profiler.start/stop` writes a `.cpuprofile`.
//   7. CDP `Tracing.start/end` writes a `.trace.json`.
//
// Paste mechanism (chosen by `pickPasteMethod(size)`):
//   - All sizes (10k, 100k, 1m): programmatic `monaco.editor.setValue()`.
//     v1 attempted real Ctrl+V at 10k + 100k; the 10k path proved flaky
//     against the `paste.handle.editor` harness assertion and the 100k
//     path timed out the editor `waitFor` even at 60s on the v1
//     reference machine. Issue #218 tracks bringing the real keyboard
//     pipeline online; until then, every row carries `pasteMethod:
//     "setvalue"` and the bench measures the post-paste render path
//     (Monaco model update -> Angular detection -> tree render),
//     not the editor's onDidPaste handler.
//   - `1m`: same as above; 24 MB wide-aoo also exceeds Chromium's
//     silent clipboard cap, so setValue would be the only option even
//     if #218 lands.
//
// Size gates (v1):
//   - `1m`: gated behind `PERF_FORCE_1M=1` (issue #217). Each timed
//     iter at this size can exceed Playwright's 10-min per-test
//     timeout.
//   - `100k`: gated behind `PERF_FORCE_100K=1` (issue #218). The
//     bench runs 8 page.goto -> 100k-render iters per fixture, and
//     the renderer accumulates state across iters until the
//     post-`goto` `editor.waitFor` exceeds even 60s. This affects
//     both `keyboard` and `setvalue` paths equally (the failure is
//     pre-paste, at editor-load time). The default `paste-large`
//     matrix is 10k only; flip the env var for centerpiece /
//     on-demand 100k captures.
//
// `pasteMethod` is recorded as an additive row field (per the schema
// convention documented in `scripts/perf/baseline.mjs`), NOT as a
// suffix on the 4-tuple `rowKey`. This keeps `perfRowKey` /
// `parsePerfRowKey` / `perf-targets.schema.json` regex parity intact.
// The field accepts `"keyboard"` for forward compatibility when #218
// brings the real-paste path online.
//
// Output: rows emitted via console.log sentinel `@@PERF_L3@@<json>@@END@@`,
// captured by `scripts/perf/run-l3.mjs` into `perf-results/<utc>/layer-3.jsonl`,
// alongside `perf-results/<utc>/traces/paste-large-*.cpuprofile` and
// `perf-results/<utc>/traces/paste-large-*.trace.json`.

import { test, type Page } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FIXTURE_CATALOG } from '../../fixtures/catalog';
import { generate } from '../../fixtures/generate';
import { CdpProfiler } from '../util/cdp-profile';
import {
  HEAP_SAMPLE_SCRIPT,
  LONGTASK_OBSERVER_SCRIPT,
  LONGTASK_OBSERVER_STOP_SCRIPT,
  summarize,
  type IterMetrics,
  type MeasureOpts,
} from '../util/measure';
import { perfHarnessInitScript } from '../util/perf-harness';

type PasteMethod = 'keyboard' | 'setvalue';

const TIMED_ITERS = 7;
const WARMUP_ITERS = 1;

const FIXTURES = FIXTURE_CATALOG.filter((fixture) => fixture.shape === 'wide-aoo');

const RESULTS_ROOT =
  process.env['PERF_RESULTS_DIR'] ?? join(process.cwd(), 'perf-results', 'l3-tmp');
const TRACES_DIR = join(RESULTS_ROOT, 'traces');

function emitRow(row: object): void {
  // eslint-disable-next-line no-console
  console.log(`@@PERF_L3@@${JSON.stringify(row)}@@END@@`);
}

/**
 * Selects the paste mechanism for each size tier. v1 uses programmatic
 * setValue at every size; see file-header comment + issue #218 for the
 * keyboard-pipeline status. The function intentionally retains its
 * size-based shape so re-enabling keyboard at smaller tiers (once #218
 * lands) is a one-line change.
 */
function pickPasteMethod(_size: string): PasteMethod {
  return 'setvalue';
}

async function performSetValuePaste(page: Page, json: string): Promise<void> {
  await page.evaluate(async (text: string) => {
    const monacoApi = (
      window as unknown as { monaco?: { editor?: { getEditors?: () => unknown[] } } }
    ).monaco;
    const editors = monacoApi?.editor?.getEditors?.() as
      | { setValue: (value: string) => void }[]
      | undefined;
    if (editors && editors[0]) {
      editors[0].setValue(text);
    } else {
      const el = document.querySelector('textarea[aria-label="JSON editor"]');
      if (el instanceof HTMLTextAreaElement) {
        el.value = text;
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }
  }, json);
}

// Dormant in v1: real Ctrl+V flow is wired but `pickPasteMethod` returns
// `'setvalue'` for every size pending issue #218. Keeping the code here
// (vs deleting it) makes re-enabling a one-line change in
// `pickPasteMethod` and preserves the schema convention (the row
// `pasteMethod` field stays defined for both literal values).
async function performKeyboardPaste(page: Page, json: string, size: string): Promise<void> {
  // Preload the clipboard. Re-enabling requires granting clipboard
  // permission via `test.use({ permissions: ['clipboard-read',
  // 'clipboard-write'] })` near the top of this file; without it
  // Chromium throws `NotAllowedError: Write permission denied`.
  await page.evaluate(async (text) => {
    await navigator.clipboard.writeText(text);
  }, json);

  // At 100k (~2.4 MB) the clipboard write can silently truncate on
  // some Chromium builds. Read it back and fail loud if it did --
  // otherwise the perf row reports a free-looking win.
  if (size === '100k') {
    const readbackLen = await page.evaluate(
      async () => (await navigator.clipboard.readText()).length,
    );
    if (readbackLen !== json.length) {
      throw new Error(
        `Clipboard truncated at ${size}: wrote ${json.length} chars, read back ${readbackLen}. ` +
          `Chromium silently capped the clipboard. File F-5: investigate longer keyboard timeouts ` +
          `or a different injection path for this size.`,
      );
    }
  }

  // Editor is empty per iter (page.goto reset). No Ctrl+A needed --
  // Ctrl+A on an empty buffer is a no-op and adds noise to wallMs.
  await page.keyboard.press('Control+V');
}

for (const fixture of FIXTURES) {
  test(`paste-large: ${fixture.shape} @ ${fixture.size}`, async ({ page }) => {
    test.skip(
      fixture.size === '1m' && !process.env['PERF_FORCE_1M'],
      'L3 1m tier gated behind PERF_FORCE_1M=1 (issue #217)',
    );
    test.skip(
      fixture.size === '100k' && !process.env['PERF_FORCE_100K'],
      'L3 100k tier gated behind PERF_FORCE_100K=1 (issue #218)',
    );
    test.setTimeout(10 * 60 * 1000);

    const json = generate({ shape: fixture.shape, approxNodes: fixture.approxNodes });
    const bytes = Buffer.byteLength(json, 'utf8');
    const pasteMethod = pickPasteMethod(fixture.size);

    await page.addInitScript({ content: perfHarnessInitScript() });

    const iters: IterMetrics[] = [];
    // Capture .cpuprofile + .trace.json on the first warmup iter so
    // profiler/tracing overhead does not bias the timed iters' stats.

    for (let i = 0; i < WARMUP_ITERS + TIMED_ITERS; i++) {
      const isTimed = i >= WARMUP_ITERS;
      await page.goto('/', { waitUntil: 'load' });
      await page.getByRole('textbox', { name: 'JSON editor' }).waitFor({ state: 'visible' });

      const profiler = new CdpProfiler();
      await profiler.attach(page);

      await page.evaluate(LONGTASK_OBSERVER_SCRIPT);
      const heapBefore: number | null = await page.evaluate(HEAP_SAMPLE_SCRIPT);
      await profiler.collectGarbage();

      const captureFlame = !isTimed && i === 0;
      if (captureFlame) {
        await profiler.startProfiler();
        await profiler.startTracing();
      }

      const editor = page.getByRole('textbox', { name: 'JSON editor' });
      await editor.focus();

      // Pre-count the harness event buffer BEFORE pasting. After
      // paste, we'll assert the count strictly increased AND that at
      // least one new event is `paste.handle.editor`. This mirrors
      // the pattern in `harness-attach.spec.ts:96-104` and tolerates
      // any prior-iter events that may still be in the array.
      const preEventCount =
        pasteMethod === 'keyboard'
          ? await page.evaluate(() => window.__jotjsonPerfHarness?.events.length ?? 0)
          : 0;

      const t0 = Date.now();
      if (pasteMethod === 'keyboard') {
        await performKeyboardPaste(page, json, fixture.size);
      } else {
        await performSetValuePaste(page, json);
      }

      // Wait for the tree pane to show its first rendered row. We use
      // `[role="treeitem"]` (set by mat-tree-node) so the wait does not
      // depend on a known key such as `id`; nested keys remain hidden
      // under collapsed parents. This is the timing terminus for BOTH
      // paste mechanisms -- branching wait conditions would make
      // `wallMs` mean different things across sizes.
      await page
        .locator('section[aria-label="Tree view"] [role="treeitem"]')
        .first()
        .waitFor({
          state: 'visible',
          timeout: 5 * 60 * 1000,
        });
      const wallMs = Date.now() - t0;

      // Keyboard branch only: verify the real paste pipeline actually
      // fired. setValue is programmatic and never triggers Monaco's
      // onPaste handler, so `paste.handle.editor` would never appear.
      if (pasteMethod === 'keyboard') {
        const events = await page.evaluate(() => window.__jotjsonPerfHarness?.events ?? []);
        const newEvents = events.slice(preEventCount);
        const sawPasteEditor = newEvents.some(
          (event: { messageId: string }) => event.messageId === 'paste.handle.editor',
        );
        if (!sawPasteEditor) {
          throw new Error(
            `Keyboard paste at ${fixture.size}: paste.handle.editor never fired ` +
              `(pre=${preEventCount}, post=${events.length}, new=${newEvents.length}). ` +
              `If this is consistent at this size, file F-5 and switch this tier ` +
              `to pasteMethod='setvalue' in pickPasteMethod().`,
          );
        }
      }

      const longestTaskMs: number | null = await page.evaluate(LONGTASK_OBSERVER_STOP_SCRIPT);
      const heapAfter: number | null = await page.evaluate(HEAP_SAMPLE_SCRIPT);
      const heapDelta = heapBefore !== null && heapAfter !== null ? heapAfter - heapBefore : null;

      if (captureFlame) {
        const tag = `paste-large-${fixture.shape}-${fixture.size}-warmup`;
        await profiler.stopProfilerToFile(join(TRACES_DIR, `${tag}.cpuprofile`));
        await profiler.stopTracingToFile(join(TRACES_DIR, `${tag}.trace.json`));
      }
      await profiler.detach();

      if (isTimed) iters.push({ wallMs, longestTaskMs, usedJsHeapBytesDelta: heapDelta });
    }

    const opts: MeasureOpts = {
      scenario: 'paste-large',
      fixture: fixture.shape,
      size: fixture.size,
      approxNodes: fixture.approxNodes,
      bytes,
      warmup: WARMUP_ITERS,
      iters: TIMED_ITERS,
    };
    const row = summarize(opts, iters, []);
    // pasteMethod is an additive harness-variant tag, not part of the
    // 4-tuple rowKey (see scripts/perf/baseline.mjs schema convention).
    emitRow({ ...row, pasteMethod });
  });
}

// Persist a marker file so `run-l3.mjs` knows where TRACES_DIR ended up
// (Playwright spawns specs with cwd = repo root, but PERF_RESULTS_DIR
// may be unset for local debugging).
test.afterAll(() => {
  try {
    writeFileSync(join(RESULTS_ROOT, '.traces-dir.txt'), TRACES_DIR + '\n');
  } catch {
    // Best-effort -- not all runs care about the marker file.
  }
});
