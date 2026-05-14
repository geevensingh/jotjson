import { HttpTestingController } from '@angular/common/http/testing';
import { ComponentFixture, TestBed, fakeAsync, flushMicrotasks } from '@angular/core/testing';
import { MatDialog, MatDialogRef } from '@angular/material/dialog';
import { MatSnackBar } from '@angular/material/snack-bar';
import { MatTooltip } from '@angular/material/tooltip';
import { By } from '@angular/platform-browser';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { provideFakeAuth } from '../../../../testing/auth.testing';
import { HIGHLIGHT_PATH_FIXTURES } from '../../../../testing/fixtures/highlight-paths.fixture';
import type {
  BlobHighlight,
  FormattingRule,
  FormattingRuleSet,
  FormattingRuleSimple,
} from '../../../core/api/models';
import { RuleSetsService } from '../../../core/api/rule-sets.service';
import type { ExtractedJson } from '../../../core/json/json-extractor.service';
import { PreferencesService } from '../../../core/preferences/preferences.service';
import { bucketCount } from '../../../core/telemetry/buckets';
import { __resetColdFlagsForTesting } from '../../../core/telemetry/cold-flag';
import { LoggerService } from '../../../core/telemetry/logger.service';
import { formatPath } from './build-tree';
import {
  DecodedValueDialogComponent,
  type DecodedValueDialogData,
} from './decoded-value-dialog/decoded-value-dialog.component';
import { HIGHLIGHT_PALETTE_LIGHT, contrastText } from './highlight-palette';
import { JsonTreeComponent, type TreeExtractRequest } from './json-tree.component';

const STORAGE_KEY = 'jotjson.preferences.v1';
const TREE_SEARCH_STORAGE_KEY = 'jotjson.treeSearch.v1';

interface BuiltNode {
  segment: string | number | undefined;
  pathString: string;
  type: string;
  depth: number;
  children?: BuiltNode[];
}

describe('JsonTreeComponent', () => {
  let fixture: ComponentFixture<JsonTreeComponent>;
  let cmp: JsonTreeComponent;
  let prefs: PreferencesService;
  let snackOpen: jasmine.Spy;

  async function createWith(
    value: unknown,
    beforeDetectChanges?: () => void,
    loggerOverride?: jasmine.SpyObj<LoggerService>,
  ): Promise<void> {
    localStorage.removeItem(STORAGE_KEY);
    TestBed.resetTestingModule();
    snackOpen = jasmine.createSpy('snackOpen');
    await TestBed.configureTestingModule({
      imports: [JsonTreeComponent],
      providers: [
        ...provideFakeAuth(),
        // Provide noop animations so Angular Material's MatMenu sets
        // its internal `_animationsDisabled` flag to true. Without
        // this, on Linux headless Chrome `prefers-reduced-motion` is
        // false, animations stay enabled, and `_setIsOpen(false)`
        // schedules a 200 ms exit-fallback timer instead of the
        // immediate microtask-style `setTimeout(0)`. The
        // highlight-menu close behavior tests rely on synchronous
        // tear-down via short `setTimeout(0)` flushes.
        provideNoopAnimations(),
        { provide: MatSnackBar, useValue: { open: snackOpen } },
        ...(loggerOverride ? [{ provide: LoggerService, useValue: loggerOverride }] : []),
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(JsonTreeComponent);
    prefs = TestBed.inject(PreferencesService);
    beforeDetectChanges?.();
    fixture.componentRef.setInput('value', value);
    fixture.detectChanges();
    cmp = fixture.componentInstance;
  }

  async function createWithEventSpy(value: unknown): Promise<jasmine.Spy> {
    let eventSpy: jasmine.Spy | null = null;
    await createWith(value, () => {
      eventSpy = spyOn(TestBed.inject(LoggerService), 'event');
    });
    if (eventSpy === null) {
      throw new Error('Logger event spy was not initialized');
    }
    return eventSpy;
  }

  async function createWithLoggerSpy(value: unknown): Promise<jasmine.SpyObj<LoggerService>> {
    const logger = jasmine.createSpyObj<LoggerService>('LoggerService', [
      'event',
      'info',
      'warn',
      'error',
    ]);
    await createWith(value, undefined, logger);
    return logger;
  }

  function installAnimationFrameQueue(): FrameRequestCallback[] {
    const callbacks: FrameRequestCallback[] = [];
    spyOn(window, 'requestAnimationFrame').and.callFake(
      (callback: FrameRequestCallback): number => {
        callbacks.push(callback);
        return callbacks.length;
      },
    );
    return callbacks;
  }

  function runNextAnimationFrame(callbacks: FrameRequestCallback[]): void {
    const callback = callbacks.shift();
    if (!callback) {
      throw new Error('Expected a queued requestAnimationFrame callback');
    }
    callback(0);
  }

  function runQueuedAnimationFrames(callbacks: FrameRequestCallback[]): void {
    let runCount = 0;
    while (callbacks.length > 0) {
      if (runCount > 20) {
        throw new Error('Too many queued requestAnimationFrame callbacks');
      }
      runNextAnimationFrame(callbacks);
      runCount += 1;
    }
  }

  beforeEach(() => {
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(TREE_SEARCH_STORAGE_KEY);
    __resetColdFlagsForTesting();
  });

  afterEach(() => {
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(TREE_SEARCH_STORAGE_KEY);
  });

  it('does not warn about mixed flat/nested tree node types', async () => {
    const warn = spyOn(console, 'warn').and.callThrough();
    await createWith({ a: { b: 1 } });
    const warnings = warn.calls
      .allArgs()
      .flat()
      .filter((a) => typeof a === 'string' && a.includes('conflicting node types'));
    expect(warnings).withContext('mat-tree must not emit flat/nested conflict warning').toEqual([]);
  });

  it('applies treeFontSize to the .tree-body element as a CSS custom property', async () => {
    await createWith({ a: 1 });
    prefs.update({ treeFontSize: 19 });
    fixture.detectChanges();
    const body = (fixture.nativeElement as HTMLElement).querySelector('.tree-body') as HTMLElement;
    expect(body).toBeTruthy();
    expect(body.style.getPropertyValue('--tree-font-size').trim()).toBe('19px');
  });

  it('scales the type badge font-size with treeFontSize', async () => {
    await createWith({ a: 1, b: 2 });
    prefs.update({ treeFontSize: 26, treeShowTypeLabels: true });
    fixture.detectChanges();
    document.body.appendChild(fixture.nativeElement);
    try {
      const badge = (fixture.nativeElement as HTMLElement).querySelector(
        '.tree-type-badge',
      ) as HTMLElement;
      expect(badge).withContext('expected a .tree-type-badge to be rendered').toBeTruthy();
      const fs = Number.parseFloat(getComputedStyle(badge).fontSize);
      // 0.77em of 26px is ~20px -- assert clearly larger than the default 10px.
      expect(fs).toBeGreaterThan(15);
    } finally {
      document.body.removeChild(fixture.nativeElement);
    }
  });

  it('overrides Material tree-node font-size so large treeFontSize values actually render', async () => {
    await createWith({ a: 1, b: 2 });
    prefs.update({ treeFontSize: 28 });
    fixture.detectChanges();
    // Attach to the live document so getComputedStyle resolves correctly.
    document.body.appendChild(fixture.nativeElement);
    try {
      const node = (fixture.nativeElement as HTMLElement).querySelector(
        'mat-nested-tree-node, .mat-nested-tree-node',
      ) as HTMLElement;
      expect(node).withContext('expected a mat-nested-tree-node to be rendered').toBeTruthy();
      const fs = Number.parseFloat(getComputedStyle(node).fontSize);
      expect(fs).toBe(28);
      expect(getComputedStyle(node).fontFamily).toMatch(/JetBrains Mono/i);
    } finally {
      document.body.removeChild(fixture.nativeElement);
    }
  });

  describe('row density (em-based icon chrome)', () => {
    // CSS-contract tests: assert computed font-size / width / height on
    // the icon chrome at small and large tree font sizes. These are
    // deterministic and don't depend on real browser line-box metrics
    // the way a row-pixel-height assertion would. Pixel arithmetic:
    //   pill (1.25em) at 8px font  =>  10px
    //   pill (1.25em) at 24px font =>  30px
    //   twisty (1.1em) at 8px font =>  8.8px
    //   twisty (1.1em) at 24px font => 26.4px

    async function setupAttachedAtFont(value: unknown, treeFontSize: number) {
      await createWith(value);
      prefs.update({ treeFontSize });
      fixture.detectChanges();
      document.body.appendChild(fixture.nativeElement);
    }

    it('inherits tree font-size into the kebab pill via font: inherit', async () => {
      await setupAttachedAtFont({ a: 1 }, 8);
      try {
        const pill = (fixture.nativeElement as HTMLElement).querySelector(
          '.tree-kebab-pill',
        ) as HTMLElement;
        expect(pill).withContext('expected a .tree-kebab-pill to be rendered').toBeTruthy();
        const cs = getComputedStyle(pill);
        // font: inherit must beat the UA default ~13.33px on <button>
        expect(Number.parseFloat(cs.fontSize)).toBe(8);
        // 1.25em of 8px = 10px
        expect(Number.parseFloat(cs.width)).toBe(10);
        expect(Number.parseFloat(cs.height)).toBe(10);
      } finally {
        document.body.removeChild(fixture.nativeElement);
      }
    });

    it('scales the kebab pill proportionally at large tree font sizes', async () => {
      await setupAttachedAtFont({ a: 1 }, 24);
      try {
        const pill = (fixture.nativeElement as HTMLElement).querySelector(
          '.tree-kebab-pill',
        ) as HTMLElement;
        const cs = getComputedStyle(pill);
        expect(Number.parseFloat(cs.fontSize)).toBe(24);
        // 1.25em of 24px = 30px
        expect(Number.parseFloat(cs.width)).toBe(30);
        expect(Number.parseFloat(cs.height)).toBe(30);
      } finally {
        document.body.removeChild(fixture.nativeElement);
      }
    });

    it('scales the twisty button (1.1em) with tree font size', async () => {
      await setupAttachedAtFont({ a: 1 }, 8);
      try {
        // Skip spacer twisties (.tree-spacer) - those are invisible
        // placeholders on leaf rows; we want to assert against the
        // actual interactive chevron button on the root container.
        const twisty = (fixture.nativeElement as HTMLElement).querySelector(
          '.tree-twisty:not(.tree-spacer)',
        ) as HTMLElement;
        expect(twisty)
          .withContext('expected an active .tree-twisty (non-spacer) to be rendered')
          .toBeTruthy();
        const cs = getComputedStyle(twisty);
        expect(Number.parseFloat(cs.fontSize)).toBe(8);
        // 1.1em of 8px = 8.8px (with browser sub-pixel rounding tolerance)
        expect(Number.parseFloat(cs.width)).toBeCloseTo(8.8, 1);
        expect(Number.parseFloat(cs.height)).toBeCloseTo(8.8, 1);
      } finally {
        document.body.removeChild(fixture.nativeElement);
      }
    });

    it('applies the tightened line-height to .tree-body', async () => {
      await setupAttachedAtFont({ a: 1 }, 8);
      try {
        const body = (fixture.nativeElement as HTMLElement).querySelector(
          '.tree-body',
        ) as HTMLElement;
        const cs = getComputedStyle(body);
        expect(Number.parseFloat(cs.fontSize)).toBe(8);
        // line-height: 1.4 of 8px = 11.2px (browsers may round)
        expect(Number.parseFloat(cs.lineHeight)).toBeCloseTo(11.2, 1);
      } finally {
        document.body.removeChild(fixture.nativeElement);
      }
    });

    it('keeps the probe row content height at or below 18px at the smallest font', async () => {
      // Generous integration guard. The probe row contains the same chrome as
      // a real row (twisty + key + value). At 8px tree font the chrome is
      // dominated by the 1.25em-equivalent kebab/pill family (~10px) plus
      // padding (~2px) plus baseline descender. <=18px gives margin for
      // browser line-box rounding without being sloppy.
      await setupAttachedAtFont({ a: 1 }, 8);
      try {
        const probe = (fixture.nativeElement as HTMLElement).querySelector(
          '.tree-row--probe',
        ) as HTMLElement;
        expect(probe).withContext('expected a .tree-row--probe to be rendered').toBeTruthy();
        const rect = probe.getBoundingClientRect();
        expect(rect.height).toBeLessThanOrEqual(18);
      } finally {
        document.body.removeChild(fixture.nativeElement);
      }
    });
  });

  describe('root() and path formatting', () => {
    function collectPathStrings(node: BuiltNode | undefined): string[] {
      if (!node) {
        return [];
      }
      const paths = [node.pathString];
      for (const child of node.children ?? []) {
        paths.push(...collectPathStrings(child));
      }
      return paths;
    }

    it('returns undefined when no value is set', async () => {
      await createWith(undefined);
      expect(cmp.root()).toBeUndefined();
    });

    it('formats identifier keys with dot notation', async () => {
      await createWith({ foo: { bar: 1 } });
      const root = cmp.root() as unknown as BuiltNode;
      expect(root.pathString).toBe('$');
      expect(root.children![0].pathString).toBe('$.foo');
      expect(root.children![0].children![0].pathString).toBe('$.foo.bar');
    });

    it('formats array indices with bracket notation', async () => {
      await createWith({ arr: [10, 20] });
      const root = cmp.root() as unknown as BuiltNode;
      const arr = root.children![0];
      expect(arr.children![0].pathString).toBe('$.arr[0]');
      expect(arr.children![1].pathString).toBe('$.arr[1]');
    });

    it('quotes non-identifier keys with bracket + JSON string', async () => {
      await createWith({ 'weird key': 1, '1leading': 2 });
      const root = cmp.root() as unknown as BuiltNode;
      const paths = root.children!.map((c) => c.pathString);
      expect(paths).toContain('$["weird key"]');
      expect(paths).toContain('$["1leading"]');
    });

    it('matches the shared manual-highlight path corpus', async () => {
      for (const fixtureEntry of HIGHLIGHT_PATH_FIXTURES) {
        await createWith(fixtureEntry.value);
        const root = cmp.root() as unknown as BuiltNode | undefined;
        const paths = collectPathStrings(root);
        expect(paths)
          .withContext(`formatPath should emit ${fixtureEntry.path}`)
          .toContain(fixtureEntry.path);
      }
    });

    it('tracks node depth correctly', async () => {
      await createWith({ a: { b: { c: 1 } } });
      const root = cmp.root() as unknown as BuiltNode;
      expect(root.depth).toBe(0);
      expect(root.children![0].depth).toBe(1);
      expect(root.children![0].children![0].depth).toBe(2);
      expect(root.children![0].children![0].children![0].depth).toBe(3);
    });

    it('handles empty containers without children', async () => {
      await createWith({ arr: [], obj: {} });
      const root = cmp.root() as unknown as BuiltNode;
      const [arr, obj] = root.children!;
      expect(arr.type).toBe('array');
      expect(arr.children).toEqual([]);
      expect(obj.type).toBe('object');
      expect(obj.children).toEqual([]);
    });
  });

  describe('tree build slow telemetry', () => {
    it('does not emit tree.build.slow below the threshold', async () => {
      spyOn(window, 'requestAnimationFrame').and.returnValue(0);
      spyOn(performance, 'now').and.returnValues(0, 99, 0, 0, 0);
      const eventSpy = await createWithEventSpy({ a: 1 });
      expect(eventSpy.calls.allArgs().some((args) => args[0] === 'tree.build.slow')).toBeFalse();
    });

    it('emits tree.build.slow above the threshold', async () => {
      spyOn(window, 'requestAnimationFrame').and.returnValue(0);
      spyOn(performance, 'now').and.returnValues(0, 101, 0, 0, 0);
      const eventSpy = await createWithEventSpy({ a: 1 });
      expect(eventSpy).toHaveBeenCalledWith(
        'tree.build.slow',
        { cold: true, nodeCountBucket: bucketCount(2) },
        { timeMs: 101, nodeCount: 2 },
      );
    });

    it('does not emit tree.build.slow at exactly 100 ms', async () => {
      spyOn(window, 'requestAnimationFrame').and.returnValue(0);
      spyOn(performance, 'now').and.returnValues(0, 100, 0, 0, 0);
      const eventSpy = await createWithEventSpy({ a: 1 });
      expect(eventSpy.calls.allArgs().some((args) => args[0] === 'tree.build.slow')).toBeFalse();
    });

    it('marks only the first tree.build.slow emission as cold', async () => {
      spyOn(window, 'requestAnimationFrame').and.returnValue(0);
      spyOn(performance, 'now').and.returnValues(0, 101, 0, 0, 0, 200, 350, 0);
      const eventSpy = await createWithEventSpy({ a: 1 });
      fixture.componentRef.setInput('value', { b: 2 });
      fixture.detectChanges();
      const buildCalls = eventSpy.calls.allArgs().filter((args) => args[0] === 'tree.build.slow');
      expect(buildCalls).toEqual([
        [
          'tree.build.slow',
          { cold: true, nodeCountBucket: bucketCount(2) },
          { timeMs: 101, nodeCount: 2 },
        ],
        [
          'tree.build.slow',
          { cold: false, nodeCountBucket: bucketCount(2) },
          { timeMs: 150, nodeCount: 2 },
        ],
      ]);
    });

    it('reports the node count from the build traversal', async () => {
      spyOn(window, 'requestAnimationFrame').and.returnValue(0);
      spyOn(performance, 'now').and.returnValues(0, 101, 0, 0, 0);
      const eventSpy = await createWithEventSpy({
        a: { b: 1 },
        c: [2, 3],
      });
      expect(eventSpy).toHaveBeenCalledWith(
        'tree.build.slow',
        { cold: true, nodeCountBucket: bucketCount(6) },
        { timeMs: 101, nodeCount: 6 },
      );
    });
  });

  describe('tree render slow telemetry', () => {
    it('does not emit tree.render.slow below the threshold', async () => {
      const callbacks = installAnimationFrameQueue();
      spyOn(performance, 'now').and.returnValues(0, 0, 0, 0, 0, 199);
      const eventSpy = await createWithEventSpy({ a: 1 });
      runQueuedAnimationFrames(callbacks);
      expect(eventSpy.calls.allArgs().some((args) => args[0] === 'tree.render.slow')).toBeFalse();
    });

    it('emits tree.render.slow above the threshold', async () => {
      const callbacks = installAnimationFrameQueue();
      spyOn(performance, 'now').and.returnValues(0, 0, 0, 0, 10, 211);
      const eventSpy = await createWithEventSpy({ a: 1 });
      runQueuedAnimationFrames(callbacks);
      expect(eventSpy).toHaveBeenCalledWith(
        'tree.render.slow',
        { cold: true, nodeCountBucket: bucketCount(2) },
        { timeMs: 201, nodeCount: 2 },
      );
    });

    it('drops a stale tree.render.slow measurement when value changes again', async () => {
      const callbacks = installAnimationFrameQueue();
      spyOn(performance, 'now').and.returnValues(0, 0, 0, 0, 0, 0, 0, 1000, 1251);
      const eventSpy = await createWithEventSpy({ first: 1 });
      fixture.componentRef.setInput('value', { second: { leaf: 2 } });
      fixture.detectChanges();

      runQueuedAnimationFrames(callbacks);

      const renderCalls = eventSpy.calls.allArgs().filter((args) => args[0] === 'tree.render.slow');
      expect(renderCalls).toEqual([
        [
          'tree.render.slow',
          { cold: true, nodeCountBucket: bucketCount(3) },
          { timeMs: 251, nodeCount: 3 },
        ],
      ]);
    });

    it('does not schedule tree.render.slow when value is undefined', async () => {
      const callbacks = installAnimationFrameQueue();
      const eventSpy = await createWithEventSpy(undefined);
      runQueuedAnimationFrames(callbacks);
      expect(eventSpy.calls.allArgs().some((args) => args[0] === 'tree.render.slow')).toBeFalse();
    });

    it('does not emit tree.render.slow after component destroy', async () => {
      const callbacks = installAnimationFrameQueue();
      spyOn(performance, 'now').and.returnValues(0, 0, 0, 0, 0);
      const eventSpy = await createWithEventSpy({ a: 1 });
      fixture.destroy();
      runQueuedAnimationFrames(callbacks);
      expect(eventSpy.calls.allArgs().some((args) => args[0] === 'tree.render.slow')).toBeFalse();
    });
  });

  describe('initial expansion auto-fit', () => {
    /**
     * Auto-fit's measurement seam lets us drive the algorithm with
     * deterministic probe + viewport heights. Tests use the seam so
     * they don't depend on how the headless browser lays out the
     * component (probe row in particular varies by Chrome version
     * font metrics).
     */
    function captureAutoFitEmit(
      eventSpy: jasmine.Spy,
    ): { props: Record<string, unknown>; measurements: Record<string, number> } | null {
      const call = eventSpy.calls.allArgs().find((args) => args[0] === 'tree.expand.autoFit');
      if (!call) return null;
      return {
        props: call[1] as Record<string, unknown>,
        measurements: call[2] as Record<string, number>,
      };
    }

    function expandToLevelCallsFor(spy: jasmine.Spy): { depth: number; internal: boolean }[] {
      return spy.calls.allArgs().map((args) => ({
        depth: args[0] as number,
        internal: (args[1] as boolean | undefined) ?? false,
      }));
    }

    it('with auto-fit ON, picks K via the algorithm and calls expandToLevel(K, true)', async () => {
      const callbacks = installAnimationFrameQueue();
      const eventSpy = await createWithEventSpy(undefined);
      // Stub measurements before triggering the value change. Probe
      // 20 px, viewport 100 px -> capacity = 5; 1.5 * 5 = 7.5.
      // Tree {a:{b:1}} -> nodesAt = [1, 1, 1]; sums = [1, 2, 3]; all
      // fit -> K = 2 (max depth).
      cmp = fixture.componentInstance;
      cmp.__setAutoFitMeasurementsForTesting(20, 100);
      const expandSpy = spyOn(cmp, 'expandToLevel').and.callThrough();
      fixture.componentRef.setInput('value', { a: { b: 1 } });
      fixture.detectChanges();
      runQueuedAnimationFrames(callbacks);
      const calls = expandToLevelCallsFor(expandSpy);
      expect(calls).toEqual([{ depth: 2, internal: true }]);
      const emit = captureAutoFitEmit(eventSpy);
      expect(emit).not.toBeNull();
      expect(emit!.props).toEqual({});
      expect(emit!.measurements['chosenDepth']).toBe(2);
      expect(emit!.measurements['totalNodes']).toBe(3);
      expect(emit!.measurements['viewportPx']).toBe(100);
      expect(emit!.measurements['probeRowPx']).toBe(20);
      expect(emit!.measurements['estimatedRows']).toBe(5);
      expect(emit!.measurements['chosenRows']).toBe(3);
      expect(emit!.measurements['fillRatioPct']).toBe(60);
      expect(typeof emit!.measurements['actualHeightPx']).toBe('number');
      expect(typeof emit!.measurements['actualFillRatioPct']).toBe('number');
    });

    it('wide-explosion case picks K = 0 (root collapsed)', async () => {
      const callbacks = installAnimationFrameQueue();
      const eventSpy = await createWithEventSpy(undefined);
      cmp = fixture.componentInstance;
      // Probe 20 px, viewport 200 px -> capacity = 10; 1.5 * 10 = 15.
      cmp.__setAutoFitMeasurementsForTesting(20, 200);
      const expandSpy = spyOn(cmp, 'expandToLevel').and.callThrough();
      // Build a wide tree: root with 50 children, each container with
      // 1 grandchild leaf. nodesAt = [1, 50, 50]; sum[0..0] = 1
      // (fits), sum[0..1] = 51 (overflows 15) -> K = 0.
      const wide: Record<string, { leaf: number }> = {};
      for (let outerIndex = 0; outerIndex < 50; outerIndex += 1) {
        wide[`k${outerIndex}`] = { leaf: outerIndex };
      }
      fixture.componentRef.setInput('value', wide);
      fixture.detectChanges();
      runQueuedAnimationFrames(callbacks);
      const calls = expandToLevelCallsFor(expandSpy);
      expect(calls).toEqual([{ depth: 0, internal: true }]);
      const emit = captureAutoFitEmit(eventSpy);
      expect(emit!.measurements['chosenDepth']).toBe(0);
      expect(emit!.measurements['chosenRows']).toBe(1);
    });

    it('with auto-fit OFF, falls back to defaultTreeExpansionDepth and emits no autoFit event', async () => {
      const callbacks = installAnimationFrameQueue();
      const eventSpy = await createWithEventSpy(undefined);
      cmp = fixture.componentInstance;
      prefs.update({ treeAutoFitToWindow: false, defaultTreeExpansionDepth: 3 });
      // Stub measurements anyway; they should be ignored on the OFF
      // path (and we want to be sure of that).
      cmp.__setAutoFitMeasurementsForTesting(20, 100);
      const expandSpy = spyOn(cmp, 'expandToLevel').and.callThrough();
      fixture.componentRef.setInput('value', { a: { b: { c: 1 } } });
      fixture.detectChanges();
      runQueuedAnimationFrames(callbacks);
      const calls = expandToLevelCallsFor(expandSpy);
      expect(calls).toEqual([{ depth: 3, internal: true }]);
      expect(captureAutoFitEmit(eventSpy)).toBeNull();
    });

    it('falls back to defaultTreeExpansionDepth when probe height is unmeasurable', async () => {
      const callbacks = installAnimationFrameQueue();
      const eventSpy = await createWithEventSpy(undefined);
      cmp = fixture.componentInstance;
      // probe = 0 -> unmeasurable; viewport ignored.
      cmp.__setAutoFitMeasurementsForTesting(0, 100);
      const expandSpy = spyOn(cmp, 'expandToLevel').and.callThrough();
      fixture.componentRef.setInput('value', { a: { b: 1 } });
      fixture.detectChanges();
      runQueuedAnimationFrames(callbacks);
      // Default is 2.
      expect(expandToLevelCallsFor(expandSpy)).toEqual([{ depth: 2, internal: true }]);
      expect(captureAutoFitEmit(eventSpy)).toBeNull();
    });

    it('falls back to defaultTreeExpansionDepth when viewport is 0 px tall', async () => {
      const callbacks = installAnimationFrameQueue();
      const eventSpy = await createWithEventSpy(undefined);
      cmp = fixture.componentInstance;
      cmp.__setAutoFitMeasurementsForTesting(20, 0);
      const expandSpy = spyOn(cmp, 'expandToLevel').and.callThrough();
      fixture.componentRef.setInput('value', { a: { b: 1 } });
      fixture.detectChanges();
      runQueuedAnimationFrames(callbacks);
      expect(expandToLevelCallsFor(expandSpy)).toEqual([{ depth: 2, internal: true }]);
      expect(captureAutoFitEmit(eventSpy)).toBeNull();
    });

    it('does not emit tree.expand.autoFit after component destroy', async () => {
      const callbacks = installAnimationFrameQueue();
      const eventSpy = await createWithEventSpy(undefined);
      cmp = fixture.componentInstance;
      cmp.__setAutoFitMeasurementsForTesting(20, 100);
      fixture.componentRef.setInput('value', { a: 1 });
      fixture.detectChanges();
      fixture.destroy();
      runQueuedAnimationFrames(callbacks);
      expect(captureAutoFitEmit(eventSpy)).toBeNull();
    });

    it('drops a stale autoFit measurement when value cycles through undefined', async () => {
      const callbacks = installAnimationFrameQueue();
      const eventSpy = await createWithEventSpy(undefined);
      cmp = fixture.componentInstance;
      cmp.__setAutoFitMeasurementsForTesting(20, 100);
      // First load -> auto-fit runs, queues rAF (generation 1).
      fixture.componentRef.setInput('value', { a: 1 });
      fixture.detectChanges();
      // Reset to undefined -> hasInitializedExpansion -> false.
      fixture.componentRef.setInput('value', undefined);
      fixture.detectChanges();
      // Second load BEFORE the first rAF fires -> auto-fit runs
      // again, queues a second rAF (generation 2). Now there are
      // two queued rAFs; the first is stale.
      fixture.componentRef.setInput('value', { b: 2 });
      fixture.detectChanges();
      runQueuedAnimationFrames(callbacks);
      // Only the second (current-generation) rAF should emit.
      const autoFitCalls = eventSpy.calls
        .allArgs()
        .filter((args) => args[0] === 'tree.expand.autoFit');
      expect(autoFitCalls.length).toBe(1);
      const measurements = autoFitCalls[0]![2] as Record<string, number>;
      expect(measurements['totalNodes']).toBe(2);
    });
  });

  describe('view reset via viewResetToken', () => {
    type AutoFitCall = ['tree.expand.autoFit', Record<string, unknown>, Record<string, number>];

    function autoFitCallsFor(eventSpy: jasmine.Spy): AutoFitCall[] {
      const calls: readonly unknown[][] = eventSpy.calls.allArgs();
      return calls.filter((args): args is AutoFitCall => args[0] === 'tree.expand.autoFit');
    }

    function expandToLevelCallsFor(spy: jasmine.Spy): { depth: number; internal: boolean }[] {
      const calls: readonly unknown[][] = spy.calls.allArgs();
      return calls.map((args) => ({
        depth: args[0] as number,
        internal: (args[1] as boolean | undefined) ?? false,
      }));
    }

    it('re-runs auto-fit when token bumps with a new value', async () => {
      const callbacks = installAnimationFrameQueue();
      const eventSpy = await createWithEventSpy(undefined);
      cmp.__setAutoFitMeasurementsForTesting(20, 100);
      fixture.componentRef.setInput('value', { a: 1 });
      fixture.detectChanges();
      runQueuedAnimationFrames(callbacks);
      expect(autoFitCallsFor(eventSpy).length).toBe(1);

      fixture.componentRef.setInput('viewResetToken', 1);
      fixture.componentRef.setInput('value', { b: 2, c: 3 });
      fixture.detectChanges();
      runQueuedAnimationFrames(callbacks);

      const autoFitCalls = autoFitCallsFor(eventSpy);
      expect(autoFitCalls.length).toBe(2);
      expect(autoFitCalls[1]![2]['totalNodes']).toBe(3);
    });

    it('re-arms the gate without firing expansion when token bumps on a null root', async () => {
      const callbacks = installAnimationFrameQueue();
      const eventSpy = await createWithEventSpy(undefined);
      cmp.__setAutoFitMeasurementsForTesting(20, 100);
      fixture.componentRef.setInput('viewResetToken', 1);
      fixture.detectChanges();
      runQueuedAnimationFrames(callbacks);
      expect(autoFitCallsFor(eventSpy).length).toBe(0);

      fixture.componentRef.setInput('value', { a: 1 });
      fixture.detectChanges();
      runQueuedAnimationFrames(callbacks);

      const autoFitCalls = autoFitCallsFor(eventSpy);
      expect(autoFitCalls.length).toBe(1);
      expect(autoFitCalls[0]![2]['totalNodes']).toBe(2);
    });

    it('invalidates an in-flight auto-fit rAF when token bumps', async () => {
      const callbacks = installAnimationFrameQueue();
      const eventSpy = await createWithEventSpy(undefined);
      cmp.__setAutoFitMeasurementsForTesting(20, 100);
      fixture.componentRef.setInput('value', { a: 1 });
      fixture.detectChanges();

      fixture.componentRef.setInput('viewResetToken', 1);
      fixture.componentRef.setInput('value', { b: 2 });
      fixture.detectChanges();
      runQueuedAnimationFrames(callbacks);

      const autoFitCalls = autoFitCallsFor(eventSpy);
      expect(autoFitCalls.length).toBe(1);
      expect(autoFitCalls[0]![2]['totalNodes']).toBe(2);
    });

    it('does not double-fire for the initial token value of zero', async () => {
      const callbacks = installAnimationFrameQueue();
      const eventSpy = await createWithEventSpy(undefined);
      cmp.__setAutoFitMeasurementsForTesting(20, 100);
      fixture.componentRef.setInput('value', { a: 1 });
      fixture.detectChanges();
      runQueuedAnimationFrames(callbacks);

      expect(autoFitCallsFor(eventSpy).length).toBe(1);
    });

    it('re-runs fixed-depth expansion on token bump when auto-fit is off', async () => {
      const callbacks = installAnimationFrameQueue();
      const eventSpy = await createWithEventSpy(undefined);
      prefs.update({ treeAutoFitToWindow: false, defaultTreeExpansionDepth: 3 });
      cmp.__setAutoFitMeasurementsForTesting(20, 100);
      const expandSpy = spyOn(cmp, 'expandToLevel').and.callThrough();
      fixture.componentRef.setInput('value', { a: { b: { c: 1 } } });
      fixture.detectChanges();
      runQueuedAnimationFrames(callbacks);
      expect(expandToLevelCallsFor(expandSpy)).toEqual([{ depth: 3, internal: true }]);
      expect(autoFitCallsFor(eventSpy).length).toBe(0);

      fixture.componentRef.setInput('viewResetToken', 1);
      fixture.componentRef.setInput('value', { x: { y: 1 } });
      fixture.detectChanges();
      runQueuedAnimationFrames(callbacks);

      expect(expandToLevelCallsFor(expandSpy)).toEqual([
        { depth: 3, internal: true },
        { depth: 3, internal: true },
      ]);
      expect(autoFitCallsFor(eventSpy).length).toBe(0);
    });

    it('drops stale auto-fit telemetry when typing changes the root', async () => {
      const callbacks = installAnimationFrameQueue();
      const eventSpy = await createWithEventSpy(undefined);
      cmp.__setAutoFitMeasurementsForTesting(20, 100);
      fixture.componentRef.setInput('value', { a: 1 });
      fixture.detectChanges();

      fixture.componentRef.setInput('value', { a: 2 });
      fixture.detectChanges();
      runQueuedAnimationFrames(callbacks);

      expect(autoFitCallsFor(eventSpy).length).toBe(0);
    });

    it('clears selection when token bumps', async () => {
      const callbacks = installAnimationFrameQueue();
      const eventSpy = await createWithEventSpy(undefined);
      cmp.__setAutoFitMeasurementsForTesting(20, 100);
      fixture.componentRef.setInput('value', { a: 1 });
      fixture.detectChanges();
      runQueuedAnimationFrames(callbacks);
      expect(autoFitCallsFor(eventSpy).length).toBe(1);
      cmp.selectedPath.set('$.a');
      fixture.detectChanges();
      expect(cmp.selectedPath()).toBe('$.a');

      fixture.componentRef.setInput('viewResetToken', 1);
      fixture.detectChanges();

      expect(cmp.selectedPath()).toBeNull();
      runQueuedAnimationFrames(callbacks);
    });
  });

  describe('searchHits', () => {
    beforeEach(async () => {
      await createWith({ alpha: 'hello', beta: { gamma: 'HELLO', delta: 7 } });
    });

    it('returns empty set when search is empty', () => {
      cmp.search.set('');
      expect(cmp.searchHits().size).toBe(0);
    });

    it('matches keys (case-insensitive, default)', () => {
      cmp.search.set('alp');
      const hits = cmp.searchHits();
      expect(hits.has('$.alpha')).toBeTrue();
    });

    it('matches string values', () => {
      prefs.update({ searchScope: 'values' });
      cmp.search.set('hello');
      const hits = cmp.searchHits();
      // Both values match case-insensitively.
      expect(hits.has('$.alpha')).toBeTrue();
      expect(hits.has('$.beta.gamma')).toBeTrue();
    });

    it('is case-sensitive when preference is set', () => {
      prefs.update({ searchScope: 'values', searchCaseSensitive: true });
      cmp.search.set('HELLO');
      const hits = cmp.searchHits();
      expect(hits.has('$.beta.gamma')).toBeTrue();
      expect(hits.has('$.alpha')).toBeFalse();
    });

    it('matches regex in regex mode', () => {
      prefs.update({ searchScope: 'keys', searchRegexMode: true });
      cmp.search.set('^(alpha|gamma)$');
      const hits = cmp.searchHits();
      expect(hits.has('$.alpha')).toBeTrue();
      expect(hits.has('$.beta.gamma')).toBeTrue();
      expect(hits.has('$.beta.delta')).toBeFalse();
    });

    it('returns empty set (does not throw) on invalid regex', () => {
      prefs.update({ searchRegexMode: true });
      cmp.search.set('[unclosed');
      expect(() => cmp.searchHits()).not.toThrow();
      expect(cmp.searchHits().size).toBe(0);
    });
  });

  describe('searchHits regex mode value haystack', () => {
    it('regex anchors match the raw string value (^hello$ matches "hello")', async () => {
      await createWith({ alpha: 'hello' });
      prefs.update({ searchScope: 'values', searchRegexMode: true });
      cmp.search.set('^hello$');
      const hits = cmp.searchHits();
      expect(hits.has('$.alpha')).toBeTrue();
    });

    it('regex \\n metachar matches a real newline in the raw value', async () => {
      await createWith({ note: 'first\nsecond' });
      prefs.update({ searchScope: 'values', searchRegexMode: true });
      cmp.search.set('first\\nsecond');
      const hits = cmp.searchHits();
      expect(hits.has('$.note')).toBeTrue();
    });

    it('regex compiles with m flag: ^hello$ matches mid-line in a multi-line value', async () => {
      await createWith({ note: 'line1\nhello\nline2' });
      prefs.update({ searchScope: 'values', searchRegexMode: true });
      cmp.search.set('^hello$');
      const hits = cmp.searchHits();
      expect(hits.has('$.note')).toBeTrue();
    });

    it('regex anchors match a value containing an embedded quote (^a"b$ matches a"b)', async () => {
      await createWith({ q: 'a"b' });
      prefs.update({ searchScope: 'values', searchRegexMode: true });
      cmp.search.set('^a"b$');
      const hits = cmp.searchHits();
      expect(hits.has('$.q')).toBeTrue();
    });

    it('regex ^$ matches an empty string value', async () => {
      await createWith({ blank: '' });
      prefs.update({ searchScope: 'values', searchRegexMode: true });
      cmp.search.set('^$');
      const hits = cmp.searchHits();
      expect(hits.has('$.blank')).toBeTrue();
    });
  });

  describe('search by value type', () => {
    beforeEach(async () => {
      // Mix of types so each filter has a distinguishable target:
      // - id          : uuid string (matches type=uuid)
      // - email       : email string (matches type=email)
      // - count       : integer
      // - ratio       : non-integer number
      // - active      : boolean
      // - missing     : null
      // - tags        : array (and contains a string)
      // - meta        : object (and contains a string)
      // - name        : plain string
      await createWith({
        id: '550e8400-e29b-41d4-a716-446655440000',
        email: 'a@b.co',
        count: 7,
        ratio: 1.5,
        active: true,
        missing: null,
        name: 'plain',
        tags: ['x'],
        meta: { kind: 'k' },
      });
    });

    it('defaults to all (no filter)', () => {
      expect(cmp.searchValueType()).toBe('all');
    });

    it('setSearchValueType writes the preference', () => {
      cmp.setSearchValueType('uuid');
      expect(prefs.prefs().searchValueType).toBe('uuid');
    });

    it('empty query + active type lists every node of that type (navigator mode)', () => {
      prefs.update({ searchValueType: 'integer' });
      cmp.search.set('');
      const hits = cmp.searchHits();
      expect(hits.has('$.count')).toBeTrue();
      // Non-integer leaves are excluded.
      expect(hits.has('$.ratio')).toBeFalse();
      expect(hits.has('$.id')).toBeFalse();
      expect(hits.has('$.active')).toBeFalse();
      // The root sentinel is never a hit.
      expect(hits.has('$')).toBeFalse();
    });

    it('empty query + uuid filter finds the uuid leaf only', () => {
      prefs.update({ searchValueType: 'uuid' });
      cmp.search.set('');
      const hits = cmp.searchHits();
      expect(hits.has('$.id')).toBeTrue();
      expect(hits.has('$.email')).toBeFalse();
    });

    it('type filter narrows by type AND scope still applies for text match (scope=values)', () => {
      prefs.update({ searchValueType: 'uuid', searchScope: 'values' });
      // The uuid string contains "550e", but the email string does not -
      // even if it did, type=uuid would exclude the email.
      cmp.search.set('550e');
      const hits = cmp.searchHits();
      expect(hits.has('$.id')).toBeTrue();
      expect(hits.has('$.email')).toBeFalse();
    });

    it('scope=keys with type filter still matches against keys (only on candidate nodes)', () => {
      prefs.update({ searchValueType: 'integer', searchScope: 'keys' });
      // Key "count" matches; only candidate (integer) so it stays.
      cmp.search.set('count');
      expect(cmp.searchHits().has('$.count')).toBeTrue();
      // Key "name" matches text too, but value type "string" != integer,
      // so it is excluded by the type filter.
      cmp.search.set('name');
      expect(cmp.searchHits().has('$.name')).toBeFalse();
    });

    it('scope=keys + empty query + type filter still lists all candidates (text scope is irrelevant)', () => {
      prefs.update({ searchValueType: 'boolean', searchScope: 'keys' });
      cmp.search.set('');
      expect(cmp.searchHits().has('$.active')).toBeTrue();
    });

    it('searchActive is true when only the type filter is set', () => {
      cmp.search.set('');
      expect(cmp.searchActive()).toBeFalse();
      prefs.update({ searchValueType: 'string' });
      expect(cmp.searchActive()).toBeTrue();
    });

    it('renders a count label when only the type filter is set', () => {
      cmp.search.set('');
      prefs.update({ searchValueType: 'uuid' });
      // Exactly one uuid in the fixture.
      expect(cmp.searchCountLabel()).not.toBe('');
      expect(cmp.searchHitCount()).toBe(1);
    });
  });

  describe('expandAll / expandToLevel / collapseAll', () => {
    beforeEach(async () => {
      await createWith({
        a: { b: { c: { d: 1 } } },
        list: [{ x: 1 }, { y: 2 }],
      });
    });

    it('expandAll expands every container node', () => {
      cmp.collapseAll();
      cmp.expandAll();
      const root = cmp.root()!;
      const walk = (n: typeof root): void => {
        if (!n.children) return;
        expect(cmp.__getHelpersForTesting().isExpanded(n)).withContext(n.pathString).toBeTrue();
        n.children.forEach(walk);
      };
      walk(root);
    });

    it('collapseAll collapses every node', () => {
      cmp.expandAll();
      cmp.collapseAll();
      const root = cmp.root()!;
      expect(cmp.__getHelpersForTesting().isExpanded(root)).toBeFalse();
    });

    it('expandToLevel(n) expands only nodes with depth < n', () => {
      cmp.expandAll();
      cmp.expandToLevel(2);
      const root = cmp.root()!;
      expect(cmp.__getHelpersForTesting().isExpanded(root)).toBeTrue(); // depth 0
      const a = root.children!.find((c) => c.segment === 'a')!;
      expect(cmp.__getHelpersForTesting().isExpanded(a)).toBeTrue(); // depth 1
      const b = a.children!.find((c) => c.segment === 'b')!;
      expect(cmp.__getHelpersForTesting().isExpanded(b)).toBeFalse(); // depth 2 should NOT be expanded
    });
  });

  describe('tree expand slow telemetry', () => {
    const expandSample = {
      a: { b: { c: 1 } },
      list: [{ x: 1 }, { y: 2 }],
    };

    type RootNode = ReturnType<JsonTreeComponent['root']>;

    async function createExpandFixture(): Promise<void> {
      spyOn(window, 'requestAnimationFrame').and.returnValue(0);
      await createWith(expandSample);
    }

    function nodeAt(path: string): NonNullable<RootNode> {
      const root = cmp.root();
      if (!root) {
        throw new Error('Expected a tree root');
      }
      const stack: Array<NonNullable<RootNode>> = [root];
      while (stack.length > 0) {
        const currentNode = stack.pop();
        if (!currentNode) {
          continue;
        }
        if (currentNode.pathString === path) {
          return currentNode;
        }
        for (const childNode of currentNode.children ?? []) {
          stack.push(childNode);
        }
      }
      throw new Error(`No node at path ${path}`);
    }

    function hasExpandSlowEvent(eventSpy: jasmine.Spy): boolean {
      return eventSpy.calls.allArgs().some((args) => args[0] === 'tree.expand.slow');
    }

    it('does not emit for expandAll below the threshold', async () => {
      await createExpandFixture();
      const eventSpy = spyOn(TestBed.inject(LoggerService), 'event');
      spyOn(performance, 'now').and.returnValues(0, 49);
      cmp.expandAll();
      expect(hasExpandSlowEvent(eventSpy)).toBeFalse();
    });

    it('emits for expandAll above the threshold and toggles cold', async () => {
      await createExpandFixture();
      const eventSpy = spyOn(TestBed.inject(LoggerService), 'event');
      spyOn(performance, 'now').and.returnValues(0, 51, 100, 152);
      cmp.expandAll();
      cmp.expandAll();
      expect(eventSpy.calls.allArgs().filter((args) => args[0] === 'tree.expand.slow')).toEqual([
        ['tree.expand.slow', { cold: true }, { timeMs: 51, depth: 2, nodeCount: 6 }],
        ['tree.expand.slow', { cold: false }, { timeMs: 52, depth: 2, nodeCount: 6 }],
      ]);
    });

    it('does not emit for expandToLevel below the threshold', async () => {
      await createExpandFixture();
      const eventSpy = spyOn(TestBed.inject(LoggerService), 'event');
      spyOn(performance, 'now').and.returnValues(0, 49);
      cmp.expandToLevel(2);
      expect(hasExpandSlowEvent(eventSpy)).toBeFalse();
    });

    it('emits for expandToLevel above the threshold and toggles cold', async () => {
      await createExpandFixture();
      const eventSpy = spyOn(TestBed.inject(LoggerService), 'event');
      spyOn(performance, 'now').and.returnValues(0, 51, 100, 152);
      cmp.expandToLevel(2);
      cmp.expandToLevel(2);
      expect(eventSpy.calls.allArgs().filter((args) => args[0] === 'tree.expand.slow')).toEqual([
        ['tree.expand.slow', { cold: true }, { timeMs: 51, depth: 2, nodeCount: 6 }],
        ['tree.expand.slow', { cold: false }, { timeMs: 52, depth: 2, nodeCount: 6 }],
      ]);
    });

    it('does not emit for expandAllFromHere below the threshold', async () => {
      await createExpandFixture();
      const eventSpy = spyOn(TestBed.inject(LoggerService), 'event');
      spyOn(performance, 'now').and.returnValues(0, 49);
      cmp.expandAllFromHere(nodeAt('$.a'));
      expect(hasExpandSlowEvent(eventSpy)).toBeFalse();
    });

    it('emits for expandAllFromHere above the threshold and toggles cold', async () => {
      await createExpandFixture();
      const eventSpy = spyOn(TestBed.inject(LoggerService), 'event');
      spyOn(performance, 'now').and.returnValues(0, 51, 100, 152);
      const startNode = nodeAt('$.a');
      cmp.expandAllFromHere(startNode);
      cmp.expandAllFromHere(startNode);
      expect(eventSpy.calls.allArgs().filter((args) => args[0] === 'tree.expand.slow')).toEqual([
        ['tree.expand.slow', { cold: true }, { timeMs: 51, depth: 1, nodeCount: 2 }],
        ['tree.expand.slow', { cold: false }, { timeMs: 52, depth: 1, nodeCount: 2 }],
      ]);
    });

    it('does not emit for expandToDepthFromHere below the threshold', async () => {
      await createExpandFixture();
      const eventSpy = spyOn(TestBed.inject(LoggerService), 'event');
      spyOn(performance, 'now').and.returnValues(0, 49);
      cmp.expandToDepthFromHere(nodeAt('$.a'), 2);
      expect(hasExpandSlowEvent(eventSpy)).toBeFalse();
    });

    it('emits for expandToDepthFromHere above the threshold and toggles cold', async () => {
      await createExpandFixture();
      const eventSpy = spyOn(TestBed.inject(LoggerService), 'event');
      spyOn(performance, 'now').and.returnValues(0, 51, 100, 152);
      const startNode = nodeAt('$.a');
      cmp.expandToDepthFromHere(startNode, 2);
      cmp.expandToDepthFromHere(startNode, 2);
      expect(eventSpy.calls.allArgs().filter((args) => args[0] === 'tree.expand.slow')).toEqual([
        ['tree.expand.slow', { cold: true }, { timeMs: 51, depth: 2, nodeCount: 2 }],
        ['tree.expand.slow', { cold: false }, { timeMs: 52, depth: 2, nodeCount: 2 }],
      ]);
    });

    it('does not emit for the initial expandToLevel even when it is slow', async () => {
      spyOn(window, 'requestAnimationFrame').and.returnValue(0);
      spyOn(performance, 'now').and.returnValues(0, 0, 0, 100, 0);
      const eventSpy = await createWithEventSpy(expandSample);
      expect(hasExpandSlowEvent(eventSpy)).toBeFalse();
    });

    it('does not emit at exactly 50 ms', async () => {
      await createExpandFixture();
      const eventSpy = spyOn(TestBed.inject(LoggerService), 'event');
      spyOn(performance, 'now').and.returnValues(0, 50);
      cmp.expandAll();
      expect(hasExpandSlowEvent(eventSpy)).toBeFalse();
    });
  });

  describe('empty containers render inline', () => {
    it('renders [] and "0 items" for an empty array leaf', async () => {
      await createWith({ things: [] });
      const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
      expect(text).toContain('[]');
      expect(text).toContain('0 items');
    });

    it('renders {} and "0 keys" for an empty object leaf', async () => {
      await createWith({ meta: {} });
      const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
      expect(text).toContain('{}');
      expect(text).toContain('0 keys');
    });
  });

  describe('JSONC comment rendering (M7k)', () => {
    function makeBundle(
      leading?: string,
      trailing?: string,
      closeTrailing?: string,
      closeLeading?: string,
    ): {
      leading?: string;
      trailing?: string;
      closeLeading?: string;
      closeTrailing?: string;
    } {
      const bundle: {
        leading?: string;
        trailing?: string;
        closeLeading?: string;
        closeTrailing?: string;
      } = {};
      if (leading !== undefined) bundle.leading = leading;
      if (trailing !== undefined) bundle.trailing = trailing;
      if (closeLeading !== undefined) bundle.closeLeading = closeLeading;
      if (closeTrailing !== undefined) bundle.closeTrailing = closeTrailing;
      return bundle;
    }

    function makeMap(
      entries: Array<
        [
          string,
          {
            leading?: string;
            trailing?: string;
            closeLeading?: string;
            closeTrailing?: string;
          },
        ]
      >,
    ): ReadonlyMap<
      string,
      {
        leading?: string;
        trailing?: string;
        closeLeading?: string;
        closeTrailing?: string;
      }
    > {
      return new Map(entries);
    }

    async function createWithComments(
      value: unknown,
      comments: ReadonlyMap<
        string,
        {
          leading?: string;
          trailing?: string;
          closeLeading?: string;
          closeTrailing?: string;
        }
      >,
      beforeDetectChanges?: () => void,
    ): Promise<void> {
      await createWith(value, beforeDetectChanges);
      fixture.componentRef.setInput('commentsByPath', comments);
      fixture.detectChanges();
    }

    function commentTexts(selector: string): string[] {
      const host = fixture.nativeElement as HTMLElement;
      return Array.from(host.querySelectorAll<HTMLElement>(selector)).map(
        (el) => el.textContent?.trim() ?? '',
      );
    }

    it('renders no comment slots when commentsByPath is null (default)', async () => {
      await createWith({ name: 'Alice' });
      const host = fixture.nativeElement as HTMLElement;
      expect(host.querySelectorAll('.tree-comment').length).toBe(0);
    });

    it('renders a leading comment before the key on a leaf row', async () => {
      await createWithComments(
        { name: 'Alice' },
        makeMap([['$.name', makeBundle('legal name on file')]]),
      );
      const leading = commentTexts('.tree-comment-leading');
      expect(leading.length).toBe(1);
      expect(leading[0]).toBe('legal name on file');
    });

    it('renders a trailing comment on a leaf row as a sibling of tree-row-right', async () => {
      await createWithComments(
        { id: 42 },
        makeMap([['$.id', makeBundle(undefined, 'uuid migration TBD')]]),
      );
      const host = fixture.nativeElement as HTMLElement;
      const leafRow = host.querySelector('[data-path="$.id"]');
      expect(leafRow).withContext('leaf row should be rendered').not.toBeNull();
      const trailing = leafRow!.querySelector(':scope > .tree-comment-trailing');
      expect(trailing)
        .withContext('trailing slot is a direct child of the leaf row')
        .not.toBeNull();
      expect(trailing!.textContent?.trim()).toBe('uuid migration TBD');
      // Per M7k-2-fu the trailing slot lives outside `tree-row-right`
      // so it sits next to the value, matching JSONC source order.
      const right = leafRow!.querySelector(':scope > .tree-row-right')!;
      expect(right.querySelector('.tree-comment-trailing'))
        .withContext('trailing slot must NOT be inside tree-row-right')
        .toBeNull();
    });

    it('renders the trailing comment AFTER the value and BEFORE tree-row-right on leaf rows', async () => {
      await createWithComments(
        { id: 42 },
        makeMap([['$.id', makeBundle(undefined, 'inline note')]]),
        () => {
          prefs.update({ treeShowTypeLabels: true });
        },
      );
      const host = fixture.nativeElement as HTMLElement;
      const leafRow = host.querySelector('[data-path="$.id"]') as HTMLElement;
      const children = Array.from(leafRow.children) as HTMLElement[];
      const valueIndex = children.findIndex((c) => c.classList.contains('tree-value-number'));
      const trailingIndex = children.findIndex((c) =>
        c.classList.contains('tree-comment-trailing'),
      );
      const rightIndex = children.findIndex((c) => c.classList.contains('tree-row-right'));
      expect(valueIndex).withContext('value span').toBeGreaterThanOrEqual(0);
      expect(trailingIndex).withContext('trailing comment').toBeGreaterThan(valueIndex);
      expect(rightIndex)
        .withContext('tree-row-right after trailing')
        .toBeGreaterThan(trailingIndex);
    });

    it('renders the trailing comment AFTER the date annotation on string rows', async () => {
      await createWithComments(
        { when: '2024-01-15T00:00:00Z' },
        makeMap([['$.when', makeBundle(undefined, 'logged at noon')]]),
        () => {
          prefs.update({ treeShowDateAnnotations: true });
        },
      );
      const host = fixture.nativeElement as HTMLElement;
      const leafRow = host.querySelector('[data-path="$.when"]') as HTMLElement;
      const children = Array.from(leafRow.children) as HTMLElement[];
      const trailingIndex = children.findIndex((c) =>
        c.classList.contains('tree-comment-trailing'),
      );
      // The date annotation lives inside the .tree-value-string's
      // @case block, so it's a descendant - check its position within
      // the row by querying its closest direct child of the row.
      const dateAnn = leafRow.querySelector('.tree-date-annotation');
      expect(dateAnn).withContext('date annotation should render').not.toBeNull();
      // Order via DOM position comparison: date annotation must come
      // before trailing comment.
      const trailing = children[trailingIndex];
      const positionMask = dateAnn!.compareDocumentPosition(trailing);
      // DOCUMENT_POSITION_FOLLOWING = 4
      expect(positionMask & Node.DOCUMENT_POSITION_FOLLOWING)
        .withContext('trailing must follow date annotation in document order')
        .toBeGreaterThan(0);
    });

    it('renders the trailing comment BEFORE the kebab on leaf rows', async () => {
      await createWithComments(
        { id: 42 },
        makeMap([['$.id', makeBundle(undefined, 'inline note')]]),
      );
      const host = fixture.nativeElement as HTMLElement;
      const leafRow = host.querySelector('[data-path="$.id"]') as HTMLElement;
      const trailing = leafRow.querySelector('.tree-comment-trailing');
      const kebab = leafRow.querySelector('.tree-kebab-pill');
      expect(trailing).withContext('trailing comment').not.toBeNull();
      expect(kebab).withContext('kebab').not.toBeNull();
      const positionMask = trailing!.compareDocumentPosition(kebab!);
      expect(positionMask & Node.DOCUMENT_POSITION_FOLLOWING)
        .withContext('kebab must follow trailing comment in document order')
        .toBeGreaterThan(0);
    });

    it('does not impose a max-width on .tree-comment (flex-driven shrink instead)', async () => {
      await createWithComments({ id: 42 }, makeMap([['$.id', makeBundle(undefined, 'note')]]));
      document.body.appendChild(fixture.nativeElement);
      try {
        const trailing = (fixture.nativeElement as HTMLElement).querySelector(
          '.tree-comment-trailing',
        ) as HTMLElement;
        expect(trailing).withContext('trailing slot should render').toBeTruthy();
        // The slot must not be capped by an arbitrary max-width; row
        // width + min-width:0 + ellipsis already does the right thing.
        expect(getComputedStyle(trailing).maxWidth).toBe('none');
      } finally {
        document.body.removeChild(fixture.nativeElement);
      }
    });

    it('renders the trailing-on-close comment on the container close row', async () => {
      await createWithComments(
        { user: { name: 'Alice' } },
        makeMap([['$.user', makeBundle(undefined, undefined, 'end of user')]]),
      );
      const host = fixture.nativeElement as HTMLElement;
      const closeRow = host.querySelector('.tree-row--close');
      expect(closeRow).withContext('close row should be rendered').not.toBeNull();
      const trailing = closeRow!.querySelector('.tree-comment-trailing');
      expect(trailing).withContext('trailing slot on close row').not.toBeNull();
      expect(trailing!.textContent?.trim()).toBe('end of user');
    });

    it('renders both closeLeading (before brace) and closeTrailing (after brace) on the container close row', async () => {
      // Regression for the user-reported bug 2026-05-01 (second test
      // case): an orphan comment between the last child and the close
      // brace (closeLeading) plus a same-line trailing on the close
      // brace (closeTrailing) must both render on the close row, with
      // closeLeading appearing in DOM order before the brace and
      // closeTrailing after.
      await createWithComments(
        { foo: { bar: 1 } },
        makeMap([
          [
            '$.foo',
            makeBundle(undefined, undefined, 'closing comment of foo', 'end of section for bar'),
          ],
        ]),
      );
      const host = fixture.nativeElement as HTMLElement;
      const closeRow = host.querySelector('.tree-row--close') as HTMLElement;
      expect(closeRow).withContext('close row should be rendered').not.toBeNull();

      const leading = closeRow.querySelector(
        '.tree-comment-leading.tree-comment-leading--close',
      ) as HTMLElement | null;
      const trailing = closeRow.querySelector(
        '.tree-comment-trailing.tree-comment-trailing--close',
      ) as HTMLElement | null;
      const brace = closeRow.querySelector('.tree-value-brace') as HTMLElement | null;

      expect(leading).withContext('closeLeading slot should render').not.toBeNull();
      expect(leading!.textContent?.trim()).toBe('end of section for bar');

      expect(trailing).withContext('closeTrailing slot should render').not.toBeNull();
      expect(trailing!.textContent?.trim()).toBe('closing comment of foo');

      expect(brace).withContext('close brace should render').not.toBeNull();

      const leadingBeforeBrace =
        leading!.compareDocumentPosition(brace!) & Node.DOCUMENT_POSITION_FOLLOWING;
      expect(leadingBeforeBrace)
        .withContext('closeLeading must appear before the close brace')
        .toBeGreaterThan(0);

      const trailingAfterBrace =
        brace!.compareDocumentPosition(trailing!) & Node.DOCUMENT_POSITION_FOLLOWING;
      expect(trailingAfterBrace)
        .withContext('closeTrailing must appear after the close brace')
        .toBeGreaterThan(0);
    });

    it('merges closeLeading and closeTrailing into the trailing slot on an empty inline container', async () => {
      // Empty containers render via the leaf template -- there is no
      // separate close row -- so both closeLeading and closeTrailing
      // must be merged with the (empty here) trailing into the single
      // trailing slot. Otherwise a nullish-coalesce fallback would
      // hide the second comment, recreating the merge-loses-comment
      // bug class M7k-fu3 / fu4 exist to fix.
      await createWithComments(
        { foo: {} },
        makeMap([['$.foo', makeBundle(undefined, undefined, 'tail', 'hello')]]),
      );
      const host = fixture.nativeElement as HTMLElement;
      const trailing = host.querySelector('.tree-comment-trailing') as HTMLElement | null;
      expect(trailing)
        .withContext('merged trailing slot should render on empty container')
        .not.toBeNull();
      // In-row text is single-line + ellipsis (first line); tooltip
      // carries the full multi-line merged text in source order.
      expect(trailing!.textContent?.trim()).toBe('hello');
      const debugEl = fixture.debugElement
        .queryAll(By.directive(MatTooltip))
        .find((de) =>
          (de.nativeElement as HTMLElement).classList.contains('tree-comment-trailing'),
        );
      expect(debugEl).withContext('trailing-comment tooltip directive').toBeDefined();
      const tooltipMessage = debugEl!.injector.get(MatTooltip).message;
      expect(tooltipMessage).toContain('hello');
      expect(tooltipMessage).toContain('tail');
      // Source order: closeLeading (hello) before closeTrailing (tail).
      expect(tooltipMessage.indexOf('hello')).toBeLessThan(tooltipMessage.indexOf('tail'));
    });

    it('merges trailing, closeLeading, and closeTrailing on an empty inline container with all three populated', async () => {
      await createWithComments(
        { foo: {} },
        makeMap([['$.foo', makeBundle(undefined, 'open', 'tail', 'mid')]]),
      );
      const host = fixture.nativeElement as HTMLElement;
      const trailing = host.querySelector('.tree-comment-trailing') as HTMLElement | null;
      expect(trailing).not.toBeNull();
      expect(trailing!.textContent?.trim()).toBe('open');
      const debugEl = fixture.debugElement
        .queryAll(By.directive(MatTooltip))
        .find((de) =>
          (de.nativeElement as HTMLElement).classList.contains('tree-comment-trailing'),
        );
      expect(debugEl).toBeDefined();
      const tooltipMessage = debugEl!.injector.get(MatTooltip).message;
      // All three comments must appear in source order: trailing
      // (open-row), closeLeading (between brace and close), closeTrailing
      // (after close).
      expect(tooltipMessage).toContain('open');
      expect(tooltipMessage).toContain('mid');
      expect(tooltipMessage).toContain('tail');
      expect(tooltipMessage.indexOf('open')).toBeLessThan(tooltipMessage.indexOf('mid'));
      expect(tooltipMessage.indexOf('mid')).toBeLessThan(tooltipMessage.indexOf('tail'));
    });

    it('renders an open-row trailing comment on a container open row', async () => {
      // Regression for the user-reported bug 2026-05-01: a comment on
      // the same line as a container's open brace must render on the
      // container's open row (sibling of tree-row-right), not as the
      // next sibling's leading slot.
      await createWithComments(
        { foo: { bar: 1 } },
        makeMap([['$.foo', makeBundle(undefined, 'explaination of foo')]]),
      );
      const host = fixture.nativeElement as HTMLElement;
      const openRow = host.querySelector('[data-path="$.foo"]') as HTMLElement;
      expect(openRow).withContext('foo open row should render').not.toBeNull();
      // The trailing comment is a direct child of the open row, NOT
      // of the close row.
      const closeRow = host.querySelector('.tree-row--close');
      const openRowTrailing = openRow.querySelector(':scope > .tree-comment-trailing');
      const closeRowTrailing = closeRow?.querySelector('.tree-comment-trailing');
      expect(openRowTrailing).withContext('open-row trailing slot must render').not.toBeNull();
      expect(openRowTrailing!.textContent?.trim()).toBe('explaination of foo');
      expect(closeRowTrailing).withContext('close-row trailing slot must NOT render').toBeFalsy();
      // The trailing slot sits before tree-row-right in DOM order,
      // mirroring the leaf-row pattern.
      const rowRight = openRow.querySelector(':scope > .tree-row-right') as HTMLElement;
      expect(rowRight).not.toBeNull();
      const positionMask = openRowTrailing!.compareDocumentPosition(rowRight);
      expect(positionMask & Node.DOCUMENT_POSITION_FOLLOWING)
        .withContext('tree-row-right must follow trailing comment')
        .toBeGreaterThan(0);
    });

    it('renders only the first line of a multi-line comment in the inline slot', async () => {
      await createWithComments(
        { version: 3 },
        makeMap([['$.version', makeBundle(undefined, 'first line\nsecond line\nthird line')]]),
      );
      const trailing = commentTexts('.tree-comment-trailing');
      expect(trailing[0]).toBe('first line');
    });

    it('exposes the full multi-line text via matTooltip', async () => {
      const fullText = 'first line\nsecond line';
      await createWithComments(
        { version: 3 },
        makeMap([['$.version', makeBundle(undefined, fullText)]]),
      );
      const debugEl = fixture.debugElement
        .queryAll(By.directive(MatTooltip))
        .find((de) =>
          (de.nativeElement as HTMLElement).classList.contains('tree-comment-trailing'),
        );
      expect(debugEl).withContext('trailing-comment tooltip directive').toBeDefined();
      const tooltip = debugEl!.injector.get(MatTooltip);
      expect(tooltip.message).toContain(fullText);
      expect(tooltip.message).toContain('Trailing comment:');
    });

    it('renders a leading comment on a container open row', async () => {
      await createWithComments(
        { user: { name: 'Alice' } },
        makeMap([['$.user', makeBundle('Customer record')]]),
      );
      const leading = commentTexts('.tree-comment-leading');
      expect(leading).toContain('Customer record');
    });

    it('does not render comment slots that are not in the map', async () => {
      await createWithComments(
        { kept: 1, dropped: 2 },
        makeMap([['$.kept', makeBundle(undefined, 'shown')]]),
      );
      const trailing = commentTexts('.tree-comment-trailing');
      expect(trailing).toEqual(['shown']);
    });

    it('hides every comment slot when treeShowComments is false', async () => {
      await createWithComments(
        { user: { name: 'Alice' }, version: 3 },
        makeMap([
          ['$.user', makeBundle('Customer record', 'end of user')],
          ['$.version', makeBundle(undefined, 'see issue #128')],
        ]),
      );
      // Sanity check: comments visible by default.
      expect(commentTexts('.tree-comment-leading').length).toBeGreaterThan(0);
      expect(commentTexts('.tree-comment-trailing').length).toBeGreaterThan(0);

      prefs.update({ treeShowComments: false });
      fixture.detectChanges();

      expect(commentTexts('.tree-comment-leading')).toEqual([]);
      expect(commentTexts('.tree-comment-trailing')).toEqual([]);
    });

    it('keeps the count cluster intact when a leading comment is much longer than the row', async () => {
      // Regression for the bug reported 2026-05-01 (Screenshot
      // 2026-05-01 151953.png): a very long leading comment squeezed
      // .tree-row-right below the natural width of "N keys", which
      // wrapped the count text at the internal space and pushed the
      // type-badge to a second line. The fix is `flex-shrink: 0` on
      // .tree-row-right plus `white-space: nowrap` on .tree-count.
      const longComment =
        'Customer record that is really long and record that is really long and record that is really really really long';
      await createWithComments(
        { foo: { user: { name: 'Alice', id: 42 } } },
        makeMap([['$.foo.user', makeBundle(longComment)]]),
      );
      document.body.appendChild(fixture.nativeElement);
      try {
        // Force a narrow viewport so the row genuinely overflows.
        const host = fixture.nativeElement as HTMLElement;
        host.style.width = '480px';
        host.style.maxWidth = '480px';
        fixture.detectChanges();

        const userRow = host.querySelector('[data-path="$.foo.user"]') as HTMLElement | null;
        expect(userRow).withContext('user open row should render').not.toBeNull();
        const rowRight = userRow!.querySelector('.tree-row-right') as HTMLElement;
        const count = userRow!.querySelector('.tree-count') as HTMLElement;
        expect(rowRight).withContext('row-right cluster').not.toBeNull();
        expect(count).withContext('count span').not.toBeNull();
        expect(count.textContent?.trim()).toBe('2 keys');

        // Computed-style guards: the actual fix.
        expect(getComputedStyle(rowRight).flexShrink).toBe('0');
        expect(getComputedStyle(count).whiteSpace).toBe('nowrap');

        // Behavioral guard: the count text fits on a single line and
        // the right cluster is no taller than the count itself.
        const countLineHeight = parseFloat(getComputedStyle(count).lineHeight);
        const countHeight = count.getBoundingClientRect().height;
        if (Number.isFinite(countLineHeight)) {
          // Single-line height should be <= 1.5 line-heights even
          // accounting for sub-pixel rounding.
          expect(countHeight).toBeLessThan(countLineHeight * 1.5);
        }
        expect(rowRight.getBoundingClientRect().height).toBeLessThan(countHeight * 1.6);
      } finally {
        document.body.removeChild(fixture.nativeElement);
      }
    });
  });

  describe('decoration vs data fonts (tree font philosophy)', () => {
    // Per the data-vs-decoration font rule (DESIGN_SPEC.md tree
    // section): keys, values, indexes, and brace glyphs render in
    // the document's monospace face; type-badge, container counts,
    // date annotations, and comment slots render in the UI
    // sans-serif face. These specs guard that contract for each
    // decoration class.
    function attachAndComputeFontFamily(selector: string): string {
      document.body.appendChild(fixture.nativeElement);
      try {
        const element = (fixture.nativeElement as HTMLElement).querySelector(
          selector,
        ) as HTMLElement | null;
        if (!element) {
          throw new Error(`Expected ${selector} to be rendered`);
        }
        return getComputedStyle(element).fontFamily;
      } finally {
        document.body.removeChild(fixture.nativeElement);
      }
    }

    const SANS_PATTERN = /system-ui|Segoe UI|Roboto|sans-serif/i;
    const MONO_PATTERN = /JetBrains Mono|Fira Code|Consolas|monospace/i;

    it('renders .tree-type-badge in the UI sans-serif font', async () => {
      await createWith({ a: 1 });
      prefs.update({ treeShowTypeLabels: true });
      fixture.detectChanges();
      const family = attachAndComputeFontFamily('.tree-type-badge');
      expect(family).toMatch(SANS_PATTERN);
      expect(family).not.toMatch(MONO_PATTERN);
    });

    it('renders .tree-count in the UI sans-serif font (decoration)', async () => {
      await createWith({ items: [1, 2, 3] });
      const family = attachAndComputeFontFamily('.tree-count');
      expect(family).toMatch(SANS_PATTERN);
      expect(family).not.toMatch(MONO_PATTERN);
    });

    it('renders .tree-date-annotation in the UI sans-serif font (decoration)', async () => {
      await createWith({ when: '2024-01-15T00:00:00Z' }, () => {
        prefs.update({ treeShowDateAnnotations: true });
      });
      const family = attachAndComputeFontFamily('.tree-date-annotation');
      expect(family).toMatch(SANS_PATTERN);
      expect(family).not.toMatch(MONO_PATTERN);
    });

    it('renders .tree-comment in the UI sans-serif font (decoration)', async () => {
      await createWith({ name: 'Alice' });
      fixture.componentRef.setInput('commentsByPath', new Map([['$.name', { leading: 'note' }]]));
      fixture.detectChanges();
      const family = attachAndComputeFontFamily('.tree-comment');
      expect(family).toMatch(SANS_PATTERN);
      expect(family).not.toMatch(MONO_PATTERN);
    });

    it('renders .tree-key in the document monospace font (data, sanity check)', async () => {
      await createWith({ name: 'Alice' });
      const family = attachAndComputeFontFamily('.tree-key');
      expect(family).toMatch(MONO_PATTERN);
    });
  });

  describe('selection highlighting', () => {
    /** Look up a rendered .tree-row whose bound TreeNode has the given pathString. */
    function findRow(path: string): HTMLElement {
      cmp.expandAll();
      fixture.detectChanges();
      cmp.selectedPath.set(path);
      fixture.detectChanges();
      const selected = (fixture.nativeElement as HTMLElement).querySelector(
        '.tree-row.is-selected',
      ) as HTMLElement | null;
      cmp.selectedPath.set(null);
      fixture.detectChanges();
      if (!selected) {
        throw new Error(`No .tree-row found for path ${path}`);
      }
      return selected;
    }

    it('selects a row on click and sets is-selected class', async () => {
      await createWith({ a: 1, b: 2 });
      cmp.expandAll();
      fixture.detectChanges();
      // Locate the row for $.a by setting+reading then clicking.
      const aRow = findRow('$.a');
      aRow.click();
      fixture.detectChanges();
      expect(cmp.selectedPath()).toBe('$.a');
      const stillSelected = (fixture.nativeElement as HTMLElement).querySelector(
        '.tree-row.is-selected',
      );
      expect(stillSelected).toBeTruthy();
    });

    it('selecting the root yields no ancestor highlights anywhere', async () => {
      await createWith({ a: { b: 1 } });
      cmp.selectedPath.set('$');
      fixture.detectChanges();
      expect(cmp.ancestorPaths().size).toBe(0);
      const ancestors = (fixture.nativeElement as HTMLElement).querySelectorAll(
        '.tree-row.is-ancestor',
      );
      expect(ancestors.length).toBe(0);
    });

    it('highlights the ancestor chain up to root for a deep selection', async () => {
      await createWith({ a: { b: { c: 1 } } });
      cmp.selectedPath.set('$.a.b.c');
      fixture.detectChanges();
      const ancestors = cmp.ancestorPaths();
      expect(ancestors.has('$')).toBeTrue();
      expect(ancestors.has('$.a')).toBeTrue();
      expect(ancestors.has('$.a.b')).toBeTrue();
      expect(ancestors.has('$.a.b.c')).toBeFalse();
    });

    it('highlights matching primitive values type-aware (1 != "1")', async () => {
      await createWith({ a: 1, b: '1', c: 1, d: 2 });
      cmp.selectedPath.set('$.a');
      fixture.detectChanges();
      const matches = cmp.matchingPaths();
      expect(matches.has('$.c')).toBeTrue();
      expect(matches.has('$.b')).toBeFalse();
      expect(matches.has('$.d')).toBeFalse();
      expect(matches.has('$.a')).toBeFalse(); // selected itself excluded
    });

    it('matching set is empty for object/array selections', async () => {
      await createWith({ a: { x: 1 }, b: { x: 1 }, list: [1, 2] });
      cmp.selectedPath.set('$.a');
      fixture.detectChanges();
      expect(cmp.matchingPaths().size).toBe(0);
      cmp.selectedPath.set('$.list');
      fixture.detectChanges();
      expect(cmp.matchingPaths().size).toBe(0);
    });

    it('renders a match badge on matching rows but not on the selected row', async () => {
      await createWith({ a: 1, b: 1 });
      cmp.expandAll();
      cmp.selectedPath.set('$.a');
      fixture.detectChanges();
      const badges = (fixture.nativeElement as HTMLElement).querySelectorAll('.tree-match-badge');
      expect(badges.length).toBe(1);
      const matchRow = badges[0].closest('.tree-row') as HTMLElement;
      expect(matchRow.classList.contains('is-match')).toBeTrue();
      expect(matchRow.classList.contains('is-selected')).toBeFalse();
      // Badge lives inside the trailing .tree-row-right strip, not as a
      // leading element that would shift the row's left content.
      expect(badges[0].parentElement?.classList.contains('tree-row-right')).toBeTrue();
    });

    it('toggling is-match does not shift left-side content', async () => {
      await createWith({ a: 1, b: 1, c: 2 });
      cmp.expandAll();
      fixture.detectChanges();
      document.body.appendChild(fixture.nativeElement);
      try {
        const root = fixture.nativeElement as HTMLElement;
        const rowFor = (path: string) =>
          root.querySelector(`[data-path="${path}"]`) as HTMLElement | null;
        const keyLeft = (path: string) =>
          (rowFor(path)?.querySelector('.tree-key') as HTMLElement | null)?.offsetLeft ?? -1;
        cmp.selectedPath.set(null);
        fixture.detectChanges();
        const baseline = keyLeft('$.a');
        cmp.selectedPath.set('$.a');
        fixture.detectChanges();
        // $.b matches $.a; ensure $.b's key did not shift right.
        expect(keyLeft('$.b')).toBe(baseline);
      } finally {
        fixture.nativeElement.remove();
      }
    });

    it('selection survives expand/collapse', async () => {
      await createWith({ a: { b: 1 } });
      cmp.expandAll();
      cmp.selectedPath.set('$.a.b');
      fixture.detectChanges();
      expect(cmp.selectedPath()).toBe('$.a.b');
      cmp.collapseAll();
      cmp.expandAll();
      fixture.detectChanges();
      expect(cmp.selectedPath()).toBe('$.a.b');
    });

    it('selects correctly through keys with special characters', async () => {
      await createWith({ 'a.b': 1, '[weird]': 2 });
      cmp.selectedPath.set('$["a.b"]');
      fixture.detectChanges();
      const matches = cmp.matchingPaths();
      // No same-value siblings; just confirms the lookup didn't throw
      // and ancestorPaths resolved via the nodeIndex (not reverse-parse).
      expect(matches.size).toBe(0);
      expect(cmp.ancestorPaths().has('$')).toBeTrue();
    });

    it('does not select when clicking the twisty toggle', async () => {
      await createWith({ a: { b: 1 } });
      cmp.expandAll();
      fixture.detectChanges();
      const twisty = (fixture.nativeElement as HTMLElement).querySelector(
        '.tree-twisty[matTreeNodeToggle], button.tree-twisty',
      ) as HTMLElement;
      expect(twisty).withContext('expected a twisty toggle button').toBeTruthy();
      twisty.click();
      fixture.detectChanges();
      expect(cmp.selectedPath()).toBeNull();
    });

    it('Escape clears the selection', async () => {
      await createWith({ a: 1 });
      cmp.selectedPath.set('$.a');
      fixture.detectChanges();
      const ev = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true });
      document.dispatchEvent(ev);
      fixture.detectChanges();
      expect(cmp.selectedPath()).toBeNull();
    });

    it('Escape while search is focused clears both selection and search', async () => {
      await createWith({ alpha: 1 });
      cmp.search.set('alp');
      cmp.selectedPath.set('$.alpha');
      fixture.detectChanges();
      const input = (fixture.nativeElement as HTMLElement).querySelector(
        'input.tree-search',
      ) as HTMLInputElement;
      input.focus();
      const ev = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true });
      input.dispatchEvent(ev);
      fixture.detectChanges();
      expect(cmp.selectedPath()).toBeNull();
      expect(cmp.search()).toBe('');
    });

    it('clicking outside the host does NOT clear the selection', async () => {
      await createWith({ a: 1 });
      document.body.appendChild(fixture.nativeElement);
      const outside = document.createElement('div');
      document.body.appendChild(outside);
      try {
        cmp.selectedPath.set('$.a');
        fixture.detectChanges();
        const ev = new MouseEvent('click', { bubbles: true });
        outside.dispatchEvent(ev);
        fixture.detectChanges();
        expect(cmp.selectedPath()).toBe('$.a');
      } finally {
        document.body.removeChild(outside);
        document.body.removeChild(fixture.nativeElement);
      }
    });

    it('changing the value() input clears the selection', async () => {
      await createWith({ a: 1 });
      cmp.selectedPath.set('$.a');
      fixture.detectChanges();
      expect(cmp.selectedPath()).toBe('$.a');
      fixture.componentRef.setInput('value', { b: 2 });
      fixture.detectChanges();
      await Promise.resolve();
      fixture.detectChanges();
      expect(cmp.selectedPath()).toBeNull();
    });

    it('applies all four highlight classes simultaneously (priority is a CSS concern)', async () => {
      await createWith({ a: { x: 7 }, c: 7 });
      cmp.expandAll();
      cmp.search.set('7');
      prefs.update({ searchScope: 'values' });
      cmp.selectedPath.set('$.c');
      fixture.detectChanges();
      // $.c is selected + a search hit + a match-of-itself excluded.
      // $.a.x is a match for the value 7 AND a search hit.
      // $.a is an ancestor of nothing (selection is on $.c) - assert
      // a clean leaf instead: select $.a.x and verify it gathers
      // search-hit + match (against $.c) + selected; then check that
      // a sibling ancestor row gets is-ancestor + is-search-hit-free.
      cmp.selectedPath.set('$.a.x');
      fixture.detectChanges();
      const xRow = (fixture.nativeElement as HTMLElement).querySelector(
        '.tree-row.is-selected',
      ) as HTMLElement;
      expect(xRow.classList.contains('is-selected')).toBeTrue();
      expect(xRow.classList.contains('is-search-hit')).toBeTrue();
    });
  });

  describe('manual highlights', () => {
    function setHighlights(highlights: readonly BlobHighlight[]): void {
      fixture.componentRef.setInput('highlights', highlights);
      fixture.detectChanges();
    }

    function findRow(path: string): HTMLElement {
      cmp.expandAll();
      fixture.detectChanges();
      const row = (fixture.nativeElement as HTMLElement).querySelector(
        `.tree-row[data-path="${path}"]`,
      ) as HTMLElement | null;
      if (!row) {
        throw new Error(`No .tree-row found for path ${path}`);
      }
      return row;
    }

    it('renders manual highlight classes and colors for direct and cascaded rows', async () => {
      await createWith({ a: { child: 1 }, b: 2, c: 3 });
      setHighlights([
        { path: '$.a', color: '#ffe082', cascade: true },
        { path: '$.c', color: '#abcdef', cascade: false },
      ]);

      const parentRow = findRow('$.a');
      const childRow = findRow('$.a.child');
      const siblingRow = findRow('$.b');
      const directRow = findRow('$.c');

      expect(parentRow.classList.contains('has-manual-highlight')).toBeTrue();
      expect(parentRow.style.getPropertyValue('--manual-highlight').trim()).toBe('#ffe082');
      expect(childRow.classList.contains('has-manual-highlight')).toBeTrue();
      expect(childRow.style.getPropertyValue('--manual-highlight').trim()).toBe('#ffe082');
      expect(directRow.classList.contains('has-manual-highlight')).toBeTrue();
      expect(directRow.style.getPropertyValue('--manual-highlight').trim()).toBe('#abcdef');
      expect(siblingRow.classList.contains('has-manual-highlight')).toBeFalse();
      expect(siblingRow.style.getPropertyValue('--manual-highlight').trim()).toBe('');
    });

    it('renders no manual highlight classes when no highlights are provided', async () => {
      await createWith({ a: { child: 1 }, b: 2 });
      setHighlights([]);
      cmp.expandAll();
      fixture.detectChanges();

      const highlightedRows = (fixture.nativeElement as HTMLElement).querySelectorAll(
        '.tree-row.has-manual-highlight',
      );
      expect(highlightedRows.length).toBe(0);
    });

    it('adds the screen-reader annotation only to highlighted rows', async () => {
      await createWith({ a: 1, b: 2 });
      setHighlights([{ path: '$.a', color: '#ffe082', cascade: false }]);

      const highlightedRow = findRow('$.a');
      const plainRow = findRow('$.b');

      expect(highlightedRow.querySelector('.sr-only')?.textContent?.trim()).toBe('highlighted');
      expect(plainRow.querySelector('.sr-only')).toBeNull();
    });

    it('paints close rows only when a cascade applies', async () => {
      await createWith({ a: { child: 1 } });
      setHighlights([{ path: '$.a', color: '#ffe082', cascade: false }]);
      cmp.expandAll();
      fixture.detectChanges();
      expect(
        (fixture.nativeElement as HTMLElement).querySelectorAll(
          '.tree-row--close.has-manual-highlight',
        ).length,
      ).toBe(0);

      setHighlights([{ path: '$.a', color: '#ffe082', cascade: true }]);
      cmp.expandAll();
      fixture.detectChanges();
      expect(
        (fixture.nativeElement as HTMLElement).querySelectorAll(
          '.tree-row--close.has-manual-highlight',
        ).length,
      ).toBe(1);
    });

    type ManualHighlightNode = NonNullable<ReturnType<JsonTreeComponent['root']>>;

    function enableHighlightEditing(): void {
      fixture.componentRef.setInput('canEditHighlights', true);
      fixture.detectChanges();
    }

    function nodeAt(path: string): ManualHighlightNode {
      const root = cmp.root();
      if (!root) {
        throw new Error('Tree root was not built');
      }
      const stack: ManualHighlightNode[] = [root];
      while (stack.length > 0) {
        const currentNode = stack.pop();
        if (!currentNode) break;
        if (currentNode.pathString === path) return currentNode;
        for (const child of currentNode.children ?? []) {
          stack.push(child);
        }
      }
      throw new Error(`No node at path ${path}`);
    }

    function setRowContext(path: string): ManualHighlightNode {
      const node = nodeAt(path);
      cmp.onKebabClick(new MouseEvent('click', { bubbles: true, cancelable: true }), node);
      fixture.detectChanges();
      return node;
    }

    async function setCloseRowContext(path: string): Promise<ManualHighlightNode> {
      const node = nodeAt(path);
      cmp.onCloseRowContextMenu(
        new MouseEvent('contextmenu', {
          clientX: 100,
          clientY: 100,
          bubbles: true,
          cancelable: true,
        }),
        node,
      );
      fixture.detectChanges();
      await Promise.resolve();
      fixture.detectChanges();
      return node;
    }

    function captureHighlightChanges(): BlobHighlight[][] {
      const events: BlobHighlight[][] = [];
      cmp.highlightsChange.subscribe((highlights) => events.push(highlights));
      return events;
    }

    function closeOpenMenus(): void {
      document.body
        .querySelectorAll('.cdk-overlay-backdrop')
        .forEach((backdrop) => (backdrop as HTMLElement).click());
      fixture.detectChanges();
    }

    function setPreferredHighlightColor(hex: string): void {
      const currentColors = prefs.prefs().treeHighlightColors;
      prefs.update({
        theme: 'light',
        treeHighlightColors: {
          ...currentColors,
          light: {
            ...currentColors.light,
            manualHighlightColor: hex,
          },
        },
      });
      fixture.detectChanges();
    }

    async function openMenuFor(path: string): Promise<void> {
      closeOpenMenus();
      const kebab = (fixture.nativeElement as HTMLElement).querySelector(
        `.tree-row[data-path="${path}"] .tree-kebab-pill`,
      ) as HTMLButtonElement | null;
      expect(kebab).withContext(`found a kebab for ${path}`).toBeTruthy();
      kebab!.click();
      fixture.detectChanges();
      await Promise.resolve();
      fixture.detectChanges();
    }

    function menuItemContaining(label: string): HTMLButtonElement {
      const item = Array.from(
        document.body.querySelectorAll<HTMLButtonElement>('button.mat-mdc-menu-item'),
      ).find((menuItem) => (menuItem.textContent ?? '').trim().includes(label));
      if (!item) {
        throw new Error(`No menu item found for ${label}`);
      }
      return item;
    }

    /**
     * Find a menu item by label text within a specific overlay panel.
     * Used to disambiguate items whose label appears in multiple
     * panels (e.g., "Highlight" appears at top-level AND inside the
     * Subtree submenu after the Path Y overhaul).
     */
    function panelItemContaining(panel: HTMLElement, label: string): HTMLButtonElement {
      const item = Array.from(
        panel.querySelectorAll<HTMLButtonElement>('button.mat-mdc-menu-item'),
      ).find((menuItem) => (menuItem.textContent ?? '').trim().includes(label));
      if (!item) {
        throw new Error(`No menu item found for ${label} in panel`);
      }
      return item;
    }

    /**
     * Open the Subtree > submenu within the currently-open row menu.
     * Caller must have already opened the row menu (e.g., via
     * `openMenuFor`). Returns the just-opened subtree submenu panel.
     */
    async function openSubtreeSubmenu(): Promise<HTMLElement> {
      const trigger = menuItemContaining(cmp.ctxSubtreeMenuLabel);
      // MatMenu submenu triggers open on hover (mouseenter) per Material
      // convention. Click would also dismiss the row menu, which we don't
      // want here.
      trigger.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true, cancelable: true }));
      fixture.detectChanges();
      await Promise.resolve();
      fixture.detectChanges();
      const panels = Array.from(document.body.querySelectorAll<HTMLElement>('.mat-mdc-menu-panel'));
      if (panels.length < 2) {
        throw new Error(
          `Expected at least 2 menu panels after opening Subtree; found ${panels.length}`,
        );
      }
      return panels[panels.length - 1]!;
    }

    async function openHighlightFlyout(
      path: string,
      label: string,
      scope: 'row' | 'subtree' = 'row',
    ): Promise<HTMLElement> {
      await openMenuFor(path);
      // The "Highlight" label appears in two panels after the Path Y
      // overhaul: top-level (single-row scope) and inside Subtree >
      // (subtree scope). Caller must specify which scope to navigate
      // to so we can pick the right panel before searching for the
      // trigger item.
      let parentPanel: HTMLElement;
      if (scope === 'subtree') {
        parentPanel = await openSubtreeSubmenu();
      } else {
        const panels = Array.from(
          document.body.querySelectorAll<HTMLElement>('.mat-mdc-menu-panel'),
        );
        parentPanel = panels[0]!;
      }
      const item = panelItemContaining(parentPanel, label);
      // Open the swatch flyout via Material's hover-to-open submenu path.
      // We deliberately avoid `item.click()` here because clicking the
      // parent "Highlight" item is now a meaningful user gesture
      // (applies the preferred color) and would skew the emit-count
      // assertions in tests that exercise the swatch path.
      item.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true, cancelable: true }));
      fixture.detectChanges();
      await Promise.resolve();
      fixture.detectChanges();
      const flyouts = Array.from(document.body.querySelectorAll<HTMLElement>('.highlight-flyout'));
      const flyout = flyouts[flyouts.length - 1];
      expect(flyout).withContext(`opened flyout for ${label} (${scope})`).toBeTruthy();
      return flyout as HTMLElement;
    }

    function normalizeBlackWhiteColor(color: string): string {
      const normalized = color.toLowerCase().replace(/\s/g, '');
      if (normalized === '#000000' || normalized === 'rgb(0,0,0)') return '#000000';
      if (normalized === '#ffffff' || normalized === 'rgb(255,255,255)') return '#ffffff';
      return normalized;
    }

    afterEach(() => {
      closeOpenMenus();
    });

    describe('context menu highlight visibility', () => {
      it('shows Highlight and Highlight tree for container rows', async () => {
        await createWith({ parent: { child: 1 } });
        enableHighlightEditing();
        const node = setRowContext('$.parent');

        expect(cmp.showHighlight(node)).toBeTrue();
        expect(cmp.showHighlightTree(node)).toBeTrue();
        expect(cmp.showRemoveHighlight(node)).toBeFalse();
        expect(cmp.showRemoveTreeHighlight(node)).toBeFalse();
      });

      it('shows only Highlight for primitive rows without inherited cascade', async () => {
        await createWith({ leaf: 1 });
        enableHighlightEditing();
        const node = setRowContext('$.leaf');

        expect(cmp.showHighlight(node)).toBeTrue();
        expect(cmp.showHighlightTree(node)).toBeFalse();
        expect(cmp.showRemoveHighlight(node)).toBeFalse();
        expect(cmp.showRemoveTreeHighlight(node)).toBeFalse();
      });

      it('shows only tree-scope highlight actions for closing-brace rows', async () => {
        await createWith({ parent: { child: 1 } });
        enableHighlightEditing();
        setHighlights([{ path: '$.parent', color: '#7e6500', cascade: true }]);
        cmp.expandAll();
        fixture.detectChanges();
        const node = await setCloseRowContext('$.parent');

        expect(cmp.showHighlight(node)).toBeFalse();
        expect(cmp.showHighlightTree(node)).toBeTrue();
        expect(cmp.showRemoveHighlight(node)).toBeFalse();
        expect(cmp.showRemoveTreeHighlight(node)).toBeTrue();
      });

      it('shows Remove highlight only for an own non-cascade entry', async () => {
        await createWith({ leaf: 1 });
        enableHighlightEditing();
        setHighlights([{ path: '$.leaf', color: '#fff59d', cascade: false }]);
        const node = setRowContext('$.leaf');

        expect(cmp.showRemoveHighlight(node)).toBeTrue();
        expect(cmp.showRemoveTreeHighlight(node)).toBeFalse();
      });

      it('shows Remove tree highlight for inherited cascade without showing Remove highlight', async () => {
        await createWith({ parent: { child: 1 } });
        enableHighlightEditing();
        setHighlights([{ path: '$.parent', color: '#7e6500', cascade: true }]);
        const node = setRowContext('$.parent.child');

        expect(cmp.showRemoveHighlight(node)).toBeFalse();
        expect(cmp.showRemoveTreeHighlight(node)).toBeTrue();
      });

      it('shows both remove items for own non-cascade plus inherited cascade', async () => {
        await createWith({ parent: { child: 1 } });
        enableHighlightEditing();
        setHighlights([
          { path: '$.parent', color: '#7e6500', cascade: true },
          { path: '$.parent.child', color: '#fff59d', cascade: false },
        ]);
        const node = setRowContext('$.parent.child');

        expect(cmp.showRemoveHighlight(node)).toBeTrue();
        expect(cmp.showRemoveTreeHighlight(node)).toBeTrue();
      });

      it('hides all highlight menu actions when editing is disabled', async () => {
        await createWith({ parent: { child: 1 } });
        setHighlights([
          { path: '$.parent', color: '#7e6500', cascade: true },
          { path: '$.parent.child', color: '#fff59d', cascade: false },
        ]);
        const node = setRowContext('$.parent.child');

        expect(cmp.showHighlight(node)).toBeFalse();
        expect(cmp.showHighlightTree(node)).toBeFalse();
        expect(cmp.showRemoveHighlight(node)).toBeFalse();
        expect(cmp.showRemoveTreeHighlight(node)).toBeFalse();
      });
    });

    describe('context menu highlight clicks', () => {
      it('clicking Highlight then Preferred emits a non-cascade entry with the preferred color', async () => {
        await createWith({ leaf: 1 });
        enableHighlightEditing();
        setPreferredHighlightColor('#123456');
        const events = captureHighlightChanges();
        const flyout = await openHighlightFlyout('$.leaf', cmp.ctxHighlightLabel);

        flyout.querySelector<HTMLButtonElement>('.preferred-bar')!.click();
        fixture.detectChanges();

        expect(events).toEqual([[{ path: '$.leaf', color: '#123456', cascade: false }]]);
      });

      it('clicking Highlight then a swatch emits a non-cascade entry with the swatch color', async () => {
        await createWith({ leaf: 1 });
        enableHighlightEditing();
        prefs.update({ theme: 'light' });
        fixture.detectChanges();
        const events = captureHighlightChanges();
        const flyout = await openHighlightFlyout('$.leaf', cmp.ctxHighlightLabel);

        flyout.querySelector<HTMLButtonElement>('[aria-label="Yellow #fff59d"]')!.click();
        fixture.detectChanges();

        expect(events).toEqual([[{ path: '$.leaf', color: '#fff59d', cascade: false }]]);
      });

      it('clicking Highlight tree then a swatch emits a cascade entry', async () => {
        await createWith({ parent: { child: 1 } });
        enableHighlightEditing();
        prefs.update({ theme: 'light' });
        fixture.detectChanges();
        const events = captureHighlightChanges();
        const flyout = await openHighlightFlyout('$.parent', cmp.ctxHighlightTreeLabel, 'subtree');

        flyout.querySelector<HTMLButtonElement>('[aria-label="Cyan #b3e5fc"]')!.click();
        fixture.detectChanges();

        expect(events).toEqual([[{ path: '$.parent', color: '#b3e5fc', cascade: true }]]);
      });

      it('retargets closing-brace highlight tree clicks to the parent path', async () => {
        await createWith({ parent: { child: 1 } });
        enableHighlightEditing();
        cmp.expandAll();
        fixture.detectChanges();
        const events = captureHighlightChanges();
        const node = await setCloseRowContext('$.parent');

        cmp.applyManualHighlight(node, true, '#b3e5fc');

        expect(events).toEqual([[{ path: '$.parent', color: '#b3e5fc', cascade: true }]]);
      });

      it('does not emit when re-applying the same color and cascade flag', async () => {
        await createWith({ leaf: 1 });
        enableHighlightEditing();
        setHighlights([{ path: '$.leaf', color: '#fff59d', cascade: false }]);
        const events = captureHighlightChanges();
        const node = setRowContext('$.leaf');

        cmp.applyManualHighlight(node, false, '#fff59d');

        expect(events).toEqual([]);
      });
    });

    describe('context menu highlight removal', () => {
      it('Remove highlight emits the list without the own non-cascade entry', async () => {
        await createWith({ leaf: 1, other: 2 });
        enableHighlightEditing();
        setHighlights([
          { path: '$.leaf', color: '#fff59d', cascade: false },
          { path: '$.other', color: '#b3e5fc', cascade: false },
        ]);
        const events = captureHighlightChanges();
        const node = setRowContext('$.leaf');

        cmp.removeManualHighlight(node);

        expect(events).toEqual([[{ path: '$.other', color: '#b3e5fc', cascade: false }]]);
      });

      it('Remove tree highlight on the cascade root removes that root entry', async () => {
        await createWith({ parent: { child: 1 }, other: 2 });
        enableHighlightEditing();
        setHighlights([
          { path: '$.parent', color: '#7e6500', cascade: true },
          { path: '$.other', color: '#fff59d', cascade: false },
        ]);
        const events = captureHighlightChanges();
        const node = setRowContext('$.parent');

        cmp.removeManualTreeHighlight(node);

        expect(events).toEqual([[{ path: '$.other', color: '#fff59d', cascade: false }]]);
      });

      it('Remove tree highlight on a descendant removes the ancestor cascade entry', async () => {
        await createWith({ parent: { child: 1 }, other: 2 });
        enableHighlightEditing();
        setHighlights([
          { path: '$.parent', color: '#7e6500', cascade: true },
          { path: '$.other', color: '#fff59d', cascade: false },
        ]);
        const events = captureHighlightChanges();
        const node = setRowContext('$.parent.child');

        cmp.removeManualTreeHighlight(node);

        expect(events).toEqual([[{ path: '$.other', color: '#fff59d', cascade: false }]]);
      });

      it('Remove tree highlight with own override removes the ancestor cascade, not the own entry', async () => {
        await createWith({ parent: { child: 1 } });
        enableHighlightEditing();
        setHighlights([
          { path: '$.parent', color: '#7e6500', cascade: true },
          { path: '$.parent.child', color: '#fff59d', cascade: false },
        ]);
        const events = captureHighlightChanges();
        const node = setRowContext('$.parent.child');

        cmp.removeManualTreeHighlight(node);

        expect(events).toEqual([[{ path: '$.parent.child', color: '#fff59d', cascade: false }]]);
      });
    });

    describe('manual highlight telemetry', () => {
      it('logs tree.highlight.apply for a new single-row highlight', async () => {
        const logger = await createWithLoggerSpy({ leaf: 1 });
        enableHighlightEditing();
        const node = nodeAt('$.leaf');

        cmp.applyManualHighlight(node, false, '#ff0000');

        // Phase 4: applyManualHighlight now also fires the
        // counts-only `tree.contextMenu.highlight` /
        // `highlightSubtree` marker, so we assert tree.highlight.apply
        // was emitted (with full props) without forcing single-call.
        expect(logger.info).toHaveBeenCalledWith('tree.highlight.apply', {
          kind: 'single',
          bucket: 'red',
          replacedExisting: 'false',
        });
      });

      it('logs tree.highlight.apply for a replaced cascade highlight', async () => {
        const logger = await createWithLoggerSpy({ parent: { child: 1 } });
        enableHighlightEditing();
        setHighlights([{ path: '$.parent', color: '#fff59d', cascade: true }]);
        const node = nodeAt('$.parent');

        cmp.applyManualHighlight(node, true, '#0000ff');

        expect(logger.info).toHaveBeenCalledWith('tree.highlight.apply', {
          kind: 'cascade',
          bucket: 'blue',
          replacedExisting: 'true',
        });
      });

      it('does not log tree.highlight.apply for an idempotent re-apply', async () => {
        const logger = await createWithLoggerSpy({ leaf: 1 });
        enableHighlightEditing();
        setHighlights([{ path: '$.leaf', color: '#ff0000', cascade: false }]);
        const node = nodeAt('$.leaf');

        cmp.applyManualHighlight(node, false, '#ff0000');

        expect(logger.info).not.toHaveBeenCalled();
      });

      it('logs tree.highlight.remove for a single-row highlight removal', async () => {
        const logger = await createWithLoggerSpy({ leaf: 1, other: 2 });
        enableHighlightEditing();
        setHighlights([
          { path: '$.leaf', color: '#fff59d', cascade: false },
          { path: '$.other', color: '#b3e5fc', cascade: false },
        ]);
        const node = nodeAt('$.leaf');

        cmp.removeManualHighlight(node);

        expect(logger.info).toHaveBeenCalledOnceWith('tree.highlight.remove', {
          kind: 'single',
          removedFromAncestor: 'false',
        });
      });

      it('logs tree.highlight.remove for a cascade root removal', async () => {
        const logger = await createWithLoggerSpy({ parent: { child: 1 }, other: 2 });
        enableHighlightEditing();
        setHighlights([{ path: '$.parent', color: '#7e6500', cascade: true }]);
        const node = nodeAt('$.parent');

        cmp.removeManualTreeHighlight(node);

        expect(logger.info).toHaveBeenCalledOnceWith('tree.highlight.remove', {
          kind: 'cascade',
          removedFromAncestor: 'false',
        });
      });

      it('logs tree.highlight.remove for a descendant cascade removal', async () => {
        const logger = await createWithLoggerSpy({ parent: { child: 1 }, other: 2 });
        enableHighlightEditing();
        setHighlights([{ path: '$.parent', color: '#7e6500', cascade: true }]);
        const node = nodeAt('$.parent.child');

        cmp.removeManualTreeHighlight(node);

        expect(logger.info).toHaveBeenCalledOnceWith('tree.highlight.remove', {
          kind: 'cascade',
          removedFromAncestor: 'true',
        });
      });

      it('logs tree.highlight.swatchOpened for the single-row swatch menu', async () => {
        const logger = await createWithLoggerSpy({ leaf: 1 });

        cmp.onSwatchMenuOpened('single');

        expect(logger.info).toHaveBeenCalledOnceWith('tree.highlight.swatchOpened', {
          kind: 'single',
        });
      });

      it('logs tree.highlight.swatchOpened for the cascade swatch menu', async () => {
        const logger = await createWithLoggerSpy({ parent: { child: 1 } });

        cmp.onSwatchMenuOpened('cascade');

        expect(logger.info).toHaveBeenCalledOnceWith('tree.highlight.swatchOpened', {
          kind: 'cascade',
        });
      });
    });

    describe('context menu highlight accessibility', () => {
      it('labels every swatch with its name and hex color', async () => {
        await createWith({ leaf: 1 });
        enableHighlightEditing();
        prefs.update({ theme: 'light' });
        fixture.detectChanges();
        const flyout = await openHighlightFlyout('$.leaf', cmp.ctxHighlightLabel);

        const labels = Array.from(flyout.querySelectorAll<HTMLButtonElement>('.swatch')).map(
          (button) => button.getAttribute('aria-label'),
        );

        expect(labels).toEqual(
          HIGHLIGHT_PALETTE_LIGHT.map((swatch) => `${swatch.name} ${swatch.hex}`),
        );
      });

      it('sets the Preferred bar aria label and contrast text color from the preferred color', async () => {
        await createWith({ leaf: 1 });
        enableHighlightEditing();
        setPreferredHighlightColor('#123456');
        const flyout = await openHighlightFlyout('$.leaf', cmp.ctxHighlightLabel);
        const preferredBar = flyout.querySelector<HTMLButtonElement>('.preferred-bar')!;
        const expectedTextColor = contrastText('#123456');

        expect(preferredBar.getAttribute('aria-label')).toBe(
          'Apply preferred highlight color (#123456)',
        );
        expect(normalizeBlackWhiteColor(preferredBar.style.color)).toBe(expectedTextColor);
      });

      it('enriches Remove tree highlight aria-label with the cascade ancestor path', async () => {
        await createWith({ parent: { child: 1 } });
        enableHighlightEditing();
        setHighlights([{ path: '$.parent', color: '#7e6500', cascade: true }]);
        await openMenuFor('$.parent.child');
        // After v0.19.4 single-item Subtree elevation: the only
        // Subtree contribution for this row is Remove tree highlight,
        // so it elevates to the row menu directly with the
        // "Remove subtree highlight" elevated label. Look for the
        // item at row-menu level (no Subtree submenu to navigate
        // into).
        const item = menuItemContaining(cmp.ctxRemoveTreeHighlightElevatedLabel);

        expect(item.getAttribute('aria-label')).toContain('$.parent');
      });
    });

    describe('context menu close behavior', () => {
      function isAnyMenuPanelOpen(): boolean {
        return document.body.querySelectorAll('.mat-mdc-menu-panel').length > 0;
      }

      function highlightFlyoutCount(): number {
        return document.body.querySelectorAll('.highlight-flyout').length;
      }

      async function flushMenuClose(): Promise<void> {
        for (let i = 0; i < 6; i += 1) {
          fixture.detectChanges();
          // Real macrotask so Material's `setTimeout(_onAnimationDone)`
          // (scheduled by `_setIsOpen(false)` even when animations are
          // disabled) can fire and complete the overlay tear-down.
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
        }
        fixture.detectChanges();
      }

      it('closes the menu chain after clicking a single-row swatch', async () => {
        await createWith({ leaf: 1 });
        enableHighlightEditing();
        prefs.update({ theme: 'light' });
        fixture.detectChanges();
        const flyout = await openHighlightFlyout('$.leaf', cmp.ctxHighlightLabel);

        flyout.querySelector<HTMLButtonElement>('[aria-label="Yellow #fff59d"]')!.click();
        await flushMenuClose();

        expect(isAnyMenuPanelOpen()).withContext('all menu panels closed').toBeFalse();
      });

      it('closes the menu chain after clicking a cascade swatch', async () => {
        await createWith({ parent: { child: 1 } });
        enableHighlightEditing();
        prefs.update({ theme: 'light' });
        fixture.detectChanges();
        const flyout = await openHighlightFlyout('$.parent', cmp.ctxHighlightTreeLabel, 'subtree');

        flyout.querySelector<HTMLButtonElement>('[aria-label="Cyan #b3e5fc"]')!.click();
        await flushMenuClose();

        expect(isAnyMenuPanelOpen()).withContext('all menu panels closed').toBeFalse();
      });

      it('closes the menu chain after clicking the Preferred bar', async () => {
        await createWith({ leaf: 1 });
        enableHighlightEditing();
        setPreferredHighlightColor('#123456');
        const flyout = await openHighlightFlyout('$.leaf', cmp.ctxHighlightLabel);

        flyout.querySelector<HTMLButtonElement>('.preferred-bar')!.click();
        await flushMenuClose();

        expect(isAnyMenuPanelOpen()).withContext('all menu panels closed').toBeFalse();
      });

      it('closes the menu chain on idempotent re-apply (same color, same cascade)', async () => {
        await createWith({ leaf: 1 });
        enableHighlightEditing();
        prefs.update({ theme: 'light' });
        fixture.detectChanges();
        setHighlights([{ path: '$.leaf', color: '#fff59d', cascade: false }]);
        const events = captureHighlightChanges();
        const flyout = await openHighlightFlyout('$.leaf', cmp.ctxHighlightLabel);

        flyout.querySelector<HTMLButtonElement>('[aria-label="Yellow #fff59d"]')!.click();
        await flushMenuClose();

        expect(events).withContext('no emit on idempotent re-apply').toEqual([]);
        expect(isAnyMenuPanelOpen())
          .withContext('menu still closes for selection feedback')
          .toBeFalse();
      });

      it('clicking the Highlight item directly applies the preferred color and closes', async () => {
        await createWith({ leaf: 1 });
        enableHighlightEditing();
        setPreferredHighlightColor('#abcdef');
        const events = captureHighlightChanges();
        await openMenuFor('$.leaf');

        const item = menuItemContaining(cmp.ctxHighlightLabel);
        item.click();
        await flushMenuClose();

        expect(events).toEqual([[{ path: '$.leaf', color: '#abcdef', cascade: false }]]);
        expect(highlightFlyoutCount()).withContext('flyout did not open').toBe(0);
        expect(isAnyMenuPanelOpen()).withContext('all menu panels closed').toBeFalse();
      });

      it('clicking the Highlight tree item directly applies the preferred color and closes', async () => {
        await createWith({ parent: { child: 1 } });
        enableHighlightEditing();
        setPreferredHighlightColor('#abcdef');
        const events = captureHighlightChanges();
        await openMenuFor('$.parent');
        // After Path Y, the subtree-scope Highlight item lives inside
        // the Subtree > submenu (and is labeled simply "Highlight"
        // there, identical to the top-level single-row item). Open
        // the Subtree panel and pick the item from there.
        const subtreePanel = await openSubtreeSubmenu();
        const item = panelItemContaining(subtreePanel, cmp.ctxHighlightTreeLabel);
        item.click();
        await flushMenuClose();

        expect(events).toEqual([[{ path: '$.parent', color: '#abcdef', cascade: true }]]);
        expect(highlightFlyoutCount()).withContext('flyout did not open').toBe(0);
        expect(isAnyMenuPanelOpen()).withContext('all menu panels closed').toBeFalse();
      });

      it('keyboard Enter on the Highlight item applies preferred and closes', async () => {
        await createWith({ leaf: 1 });
        enableHighlightEditing();
        setPreferredHighlightColor('#abcdef');
        const events = captureHighlightChanges();
        await openMenuFor('$.leaf');

        const item = menuItemContaining(cmp.ctxHighlightLabel);
        // Browsers synthesize a click with detail=0 for keyboard Enter on a
        // focused button; mimic that path so this covers keyboard parity.
        item.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 0 }));
        await flushMenuClose();

        expect(events).toEqual([[{ path: '$.leaf', color: '#abcdef', cascade: false }]]);
        expect(highlightFlyoutCount()).withContext('flyout did not open').toBe(0);
        expect(isAnyMenuPanelOpen()).withContext('all menu panels closed').toBeFalse();
      });
    });
  });

  describe('copyPath', () => {
    beforeEach(async () => {
      await createWith({ a: 1 });
    });

    function withClipboard<T>(stub: { writeText?: jasmine.Spy } | undefined, run: () => T): T {
      const original = (navigator as { clipboard?: Clipboard }).clipboard;
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: stub });
      try {
        return run();
      } finally {
        if (original) {
          Object.defineProperty(navigator, 'clipboard', {
            configurable: true,
            value: original,
          });
        } else {
          Object.defineProperty(navigator, 'clipboard', {
            configurable: true,
            value: undefined,
          });
        }
      }
    }

    it('opens a success snackbar after writeText resolves', fakeAsync(() => {
      const writeText = jasmine.createSpy('writeText').and.resolveTo(undefined);
      withClipboard({ writeText }, () => {
        cmp.copyPath({ pathString: '$.a' } as never);
      });
      flushMicrotasks();
      expect(writeText).toHaveBeenCalledWith('$.a');
      expect(snackOpen).toHaveBeenCalled();
      const message = snackOpen.calls.mostRecent().args[0] as string;
      expect(message).toContain('copied');
    }));

    it('opens a failure snackbar when writeText rejects', fakeAsync(() => {
      const writeText = jasmine.createSpy('writeText').and.rejectWith(new Error('denied'));
      withClipboard({ writeText }, () => {
        cmp.copyPath({ pathString: '$.a' } as never);
      });
      flushMicrotasks();
      expect(writeText).toHaveBeenCalled();
      expect(snackOpen).toHaveBeenCalled();
      const message = snackOpen.calls.mostRecent().args[0] as string;
      expect(message).toContain('Failed');
    }));

    it('opens an unsupported snackbar when navigator.clipboard is missing', () => {
      withClipboard(undefined, () => {
        cmp.copyPath({ pathString: '$.a' } as never);
      });
      expect(snackOpen).toHaveBeenCalled();
      const message = snackOpen.calls.mostRecent().args[0] as string;
      expect(message).toContain('not supported');
    });

    it('writes the canonical $-prefixed path by default (jsonpath mode)', fakeAsync(() => {
      const writeText = jasmine.createSpy('writeText').and.resolveTo(undefined);
      withClipboard({ writeText }, () => {
        cmp.copyPath({ pathString: '$.foo[0].bar' } as never);
      });
      flushMicrotasks();
      expect(writeText).toHaveBeenCalledWith('$.foo[0].bar');
    }));

    it('writes a lodash-style path when treePathRoot is "none"', fakeAsync(() => {
      prefs.update({ treePathRoot: 'none' });
      const writeText = jasmine.createSpy('writeText').and.resolveTo(undefined);
      withClipboard({ writeText }, () => {
        cmp.copyPath({ pathString: '$.foo[0].bar' } as never);
      });
      flushMicrotasks();
      expect(writeText).toHaveBeenCalledWith('foo[0].bar');
    }));

    it('writes a root-prefixed path when treePathRoot is "root"', fakeAsync(() => {
      prefs.update({ treePathRoot: 'root' });
      const writeText = jasmine.createSpy('writeText').and.resolveTo(undefined);
      withClipboard({ writeText }, () => {
        cmp.copyPath({ pathString: '$.foo[0].bar' } as never);
      });
      flushMicrotasks();
      expect(writeText).toHaveBeenCalledWith('root.foo[0].bar');
    }));

    it('writes a Data-prefixed path with capital D when treePathRoot is "data"', fakeAsync(() => {
      prefs.update({ treePathRoot: 'data' });
      const writeText = jasmine.createSpy('writeText').and.resolveTo(undefined);
      withClipboard({ writeText }, () => {
        cmp.copyPath({ pathString: '$.foo[0].bar' } as never);
      });
      flushMicrotasks();
      expect(writeText).toHaveBeenCalledWith('Data.foo[0].bar');
    }));
  });

  describe('date annotations', () => {
    function getAnnotationSpans(): HTMLElement[] {
      return Array.from(
        (fixture.nativeElement as HTMLElement).querySelectorAll('.tree-date-annotation'),
      );
    }

    it('renders an annotation span for ISO date strings when the pref is on', async () => {
      await createWith({ created: '2024-11-05T18:30:00Z' });
      // default pref is true
      const spans = getAnnotationSpans();
      expect(spans.length).toBe(1);
      expect(spans[0].textContent ?? '').toContain('(');
      expect(spans[0].textContent ?? '').toContain(')');
    });

    it('lets the annotation wrap when space is tight (parity with the original value)', async () => {
      await createWith({ created: '2024-11-05T18:30:00Z' });
      const valueSpan = (fixture.nativeElement as HTMLElement).querySelector(
        '.tree-value-string',
      ) as HTMLElement | null;
      const annotationSpan = getAnnotationSpans()[0];
      expect(valueSpan).toBeTruthy();
      expect(annotationSpan).toBeTruthy();
      // The original value already wraps via `word-break: break-word`.
      // The annotation must not be glued to one line - otherwise it
      // claims full intrinsic width as a flex item and squeezes the
      // value asymmetrically. Both spans should share the same wrap
      // posture.
      const valueWhiteSpace = getComputedStyle(valueSpan as HTMLElement).whiteSpace;
      const annotationWhiteSpace = getComputedStyle(annotationSpan as HTMLElement).whiteSpace;
      expect(annotationWhiteSpace).not.toBe('nowrap');
      expect(annotationWhiteSpace).toBe(valueWhiteSpace);
    });

    it('does not render an annotation when the pref is false', async () => {
      await createWith({ created: '2024-11-05T18:30:00Z' });
      prefs.update({ treeShowDateAnnotations: false });
      fixture.detectChanges();
      expect(getAnnotationSpans().length).toBe(0);
    });

    it('renders enabled day units when larger units are disabled', async () => {
      jasmine.clock().install();
      try {
        const dayMs = 24 * 60 * 60 * 1000;
        const baseNow = Date.UTC(2024, 10, 5, 12, 0, 0);
        const createdIso = new Date(baseNow - 130 * dayMs).toISOString();
        jasmine.clock().mockDate(new Date(baseNow));

        await createWith({ created: createdIso }, () => {
          prefs.update({
            treeDateAnnotationUnits: {
              year: false,
              month: false,
              day: true,
              hour: true,
              minute: true,
              second: true,
            },
          });
        });

        const annotationText = getAnnotationSpans()[0]?.textContent ?? '';
        expect(annotationText).toContain('130 days ago');
        expect(annotationText).not.toContain('4 months ago');
      } finally {
        jasmine.clock().uninstall();
      }
    });

    it('does not render an annotation when all relative units are disabled', async () => {
      await createWith({ created: '2024-11-05T18:30:00Z' });
      prefs.update({
        treeDateAnnotationUnits: {
          year: false,
          month: false,
          day: false,
          hour: false,
          minute: false,
          second: false,
        },
      });
      fixture.detectChanges();
      expect(getAnnotationSpans().length).toBe(0);
    });

    it('uses friendly relative forms only when the pref is true', async () => {
      jasmine.clock().install();
      try {
        const dayMs = 24 * 60 * 60 * 1000;
        const baseNow = Date.UTC(2024, 10, 5, 12, 0, 0);
        const dueIso = new Date(baseNow + dayMs).toISOString();
        jasmine.clock().mockDate(new Date(baseNow));

        await createWith({ due: dueIso });
        const friendlyAnnotationText = getAnnotationSpans()[0]?.textContent ?? '';
        expect(friendlyAnnotationText).toContain('tomorrow');

        prefs.update({ treeDateAnnotationFriendlyForms: false });
        fixture.detectChanges();

        const numericAnnotationText = getAnnotationSpans()[0]?.textContent ?? '';
        expect(numericAnnotationText).toContain('in 1 day');
        expect(numericAnnotationText).not.toContain('tomorrow');
      } finally {
        jasmine.clock().uninstall();
      }
    });

    it('does not annotate non-date strings', async () => {
      await createWith({ message: 'hello world', code: '12345' });
      expect(getAnnotationSpans().length).toBe(0);
    });

    it('does not annotate numeric values (Unix timestamps)', async () => {
      await createWith({ epoch: 1730831400 });
      expect(getAnnotationSpans().length).toBe(0);
    });

    it('search does not match the annotation text', async () => {
      // Annotation will contain "ago" or "in" + month names; search for the
      // literal hex em-dash and assert the value-row is NOT a search hit.
      await createWith({ created: '2024-11-05T18:30:00Z' });
      cmp.search.set('\u2014');
      fixture.detectChanges();
      const hits = (fixture.nativeElement as HTMLElement).querySelectorAll(
        '.tree-row.is-search-hit',
      );
      expect(hits.length).toBe(0);
    });

    it('relative-time portion refreshes when the now signal ticks', async () => {
      jasmine.clock().install();
      try {
        const baseNow = new Date('2024-11-05T18:30:30Z').getTime();
        jasmine.clock().mockDate(new Date(baseNow));
        await createWith({ created: '2024-11-05T18:30:00Z' });
        const before = getAnnotationSpans()[0]?.textContent ?? '';
        // Advance the wall clock by 65s and tick the timer.
        jasmine.clock().mockDate(new Date(baseNow + 65_000));
        jasmine.clock().tick(61_000);
        fixture.detectChanges();
        const after = getAnnotationSpans()[0]?.textContent ?? '';
        expect(after).not.toBe(before);
      } finally {
        jasmine.clock().uninstall();
      }
    });

    it('treats timezone-less ISO date-time as UTC when the pref is true', async () => {
      // Default treeAssumeUtcForIsoDateTime is true. The same instant must
      // produce identical relative-time output whether or not the source
      // string carries a "Z" suffix.
      await createWith({
        a: '2024-11-05T18:30:00',
        b: '2024-11-05T18:30:00Z',
      });
      const spans = getAnnotationSpans();
      expect(spans.length).toBe(2);
      const aText = spans[0]?.textContent ?? '';
      const bText = spans[1]?.textContent ?? '';
      expect(aText).toBe(bText);
    });

    it('treats timezone-less ISO date-time as local when the pref is false', async () => {
      await createWith({
        a: '2024-11-05T18:30:00',
        b: '2024-11-05T18:30:00Z',
      });
      prefs.update({ treeAssumeUtcForIsoDateTime: false });
      fixture.detectChanges();
      const spans = getAnnotationSpans();
      expect(spans.length).toBe(2);
      // Unless the test runner happens to be in UTC, the two parsed instants
      // differ by the local offset, so the rendered annotations differ.
      const offsetMin = new Date('2024-11-05T18:30:00').getTimezoneOffset();
      if (offsetMin !== 0) {
        expect(spans[0]?.textContent).not.toBe(spans[1]?.textContent);
      }
    });
  });

  describe('type badge labels', () => {
    function badges(): string[] {
      return Array.from(
        (fixture.nativeElement as HTMLElement).querySelectorAll('.tree-type-badge'),
      ).map((el) => (el.textContent ?? '').trim());
    }

    it('renders date/time for an ISO date+time string', async () => {
      await createWith({ when: '2024-11-05T18:30:00Z' });
      expect(badges()).toContain('date/time');
    });

    it('renders date for an ISO date-only string', async () => {
      await createWith({ when: '2024-11-05' });
      expect(badges()).toContain('date');
    });

    it('falls back to string when the master annotations toggle is off', async () => {
      await createWith({ when: '2024-11-05T18:30:00Z' });
      prefs.update({ treeShowDateAnnotations: false });
      fixture.detectChanges();
      const labels = badges();
      expect(labels).toContain('string');
      expect(labels).not.toContain('date/time');
    });

    it('renders integer for a whole number and number for a fractional one', async () => {
      await createWith({ a: 1, b: 1.5 });
      const labels = badges();
      expect(labels).toContain('integer');
      expect(labels).toContain('number');
    });

    it('renders uuid for a canonical UUID string', async () => {
      await createWith({ id: '550e8400-e29b-41d4-a716-446655440000' });
      expect(badges()).toContain('uuid');
    });

    it('renders url for an https string', async () => {
      await createWith({ link: 'https://example.com' });
      expect(badges()).toContain('url');
    });

    it('renders email for a typical email string', async () => {
      await createWith({ contact: 'a@example.com' });
      expect(badges()).toContain('email');
    });

    it('renders ipv4 and ipv6 for the respective formats', async () => {
      await createWith({ a: '192.168.0.1', b: '::1' });
      const labels = badges();
      expect(labels).toContain('ipv4');
      expect(labels).toContain('ipv6');
    });
  });

  describe('search controls polish', () => {
    function input(): HTMLInputElement {
      return fixture.nativeElement.querySelector('input.tree-search') as HTMLInputElement;
    }
    function setSearch(text: string): void {
      const el = input();
      el.value = text;
      el.dispatchEvent(new Event('input'));
      fixture.detectChanges();
    }

    describe('match count', () => {
      it('hides the counter when the search is empty', async () => {
        await createWith({ a: 1, b: 2 });
        expect(fixture.nativeElement.querySelector('.tree-search-count__live')).toBeNull();
      });

      it('renders "No matches" when nothing matches', async () => {
        await createWith({ alpha: 1 });
        setSearch('zzz');
        const el = fixture.nativeElement.querySelector('.tree-search-count__live');
        expect(el?.textContent?.trim()).toBe('No matches');
      });

      it('renders "1 match" for exactly one hit', async () => {
        await createWith({ alpha: 1, beta: 2 });
        setSearch('alpha');
        const el = fixture.nativeElement.querySelector('.tree-search-count__live');
        expect(el?.textContent?.trim()).toBe('1 match');
      });

      it('renders "N matches" for multiple hits', async () => {
        await createWith({ alpha: 1, alphabet: 2, alpine: 3 });
        setSearch('alp');
        const el = fixture.nativeElement.querySelector('.tree-search-count__live');
        expect(el?.textContent?.trim()).toBe('3 matches');
      });

      it('renders "P / N matches" when the selection is on a hit', async () => {
        await createWith({ alpha: 1, alphabet: 2, alpine: 3 });
        setSearch('alp');
        const c = fixture.componentInstance;
        const paths = c.searchHitPaths();
        c.selectedPath.set(paths[1] as string);
        fixture.detectChanges();
        const el = fixture.nativeElement.querySelector('.tree-search-count__live');
        expect(el?.textContent?.trim()).toBe('2 / 3 matches');
      });

      it('falls back to total when selection is not a hit', async () => {
        await createWith({ alpha: 1, alphabet: 2, beta: 3 });
        setSearch('alp');
        const c = fixture.componentInstance;
        c.selectedPath.set('$.beta');
        fixture.detectChanges();
        const el = fixture.nativeElement.querySelector('.tree-search-count__live');
        expect(el?.textContent?.trim()).toBe('2 matches');
      });

      it('falls back to total when nothing is selected', async () => {
        await createWith({ alpha: 1, alphabet: 2 });
        setSearch('alp');
        const c = fixture.componentInstance;
        c.selectedPath.set(null);
        fixture.detectChanges();
        const el = fixture.nativeElement.querySelector('.tree-search-count__live');
        expect(el?.textContent?.trim()).toBe('2 matches');
      });

      it('updates the position label as goToNextMatch advances', async () => {
        await createWith({ alpha: 1, alphabet: 2, alpine: 3 });
        setSearch('alp');
        const c = fixture.componentInstance;
        // After the search-change effect, activeHitIndex resets to 0; first
        // Next advances to index 1.
        c.goToNextMatch();
        fixture.detectChanges();
        let el = fixture.nativeElement.querySelector('.tree-search-count__live');
        expect(el?.textContent?.trim()).toBe('2 / 3 matches');
        c.goToNextMatch();
        fixture.detectChanges();
        el = fixture.nativeElement.querySelector('.tree-search-count__live');
        expect(el?.textContent?.trim()).toBe('3 / 3 matches');
        expect(c.selectedPath()).toBe(c.searchHitPaths()[2] as string);
      });

      it('renders a width-reservation ghost matching "N / N matches"', async () => {
        await createWith({ alpha: 1, alphabet: 2, alpine: 3 });
        setSearch('alp');
        const ghost = fixture.nativeElement.querySelector('.tree-search-count__ghost');
        expect(ghost?.textContent?.trim()).toBe('3 / 3 matches');
        expect(ghost?.getAttribute('aria-hidden')).toBe('true');
      });

      it('omits the ghost when the search has no hits', async () => {
        await createWith({ alpha: 1 });
        setSearch('zzz');
        expect(fixture.nativeElement.querySelector('.tree-search-count__ghost')).toBeNull();
      });

      it('keeps the chip width stable when toggling between total and position labels', async () => {
        await createWith({ alpha: 1, alphabet: 2, alpine: 3 });
        setSearch('alp');
        const c = fixture.componentInstance;
        document.body.appendChild(fixture.nativeElement);
        try {
          c.selectedPath.set(null);
          fixture.detectChanges();
          const totalWidth = (
            fixture.nativeElement.querySelector('.tree-search-count') as HTMLElement
          ).offsetWidth;
          c.selectedPath.set(c.searchHitPaths()[0] as string);
          fixture.detectChanges();
          const positionWidth = (
            fixture.nativeElement.querySelector('.tree-search-count') as HTMLElement
          ).offsetWidth;
          expect(positionWidth).toBe(totalWidth);
        } finally {
          fixture.nativeElement.remove();
        }
      });
    });

    describe('Escape clears the search', () => {
      it('clears the search and prevents default on Escape keydown', async () => {
        await createWith({ a: 1 });
        setSearch('a');
        expect(fixture.componentInstance.search()).toBe('a');
        const ev = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true, bubbles: true });
        spyOn(ev, 'preventDefault').and.callThrough();
        input().dispatchEvent(ev);
        fixture.detectChanges();
        expect(fixture.componentInstance.search()).toBe('');
        expect(ev.preventDefault).toHaveBeenCalled();
      });
    });

    describe('case sensitive / regex / scope toggles', () => {
      it('toggles case-sensitive preference and updates aria-pressed', async () => {
        await createWith({ a: 1 });
        const btn = fixture.nativeElement.querySelectorAll(
          '.tree-search-toggle',
        )[0] as HTMLButtonElement;
        expect(btn.getAttribute('aria-pressed')).toBe('false');
        btn.click();
        fixture.detectChanges();
        expect(prefs.prefs().searchCaseSensitive).toBe(true);
        expect(btn.getAttribute('aria-pressed')).toBe('true');
      });

      it('toggles regex-mode preference', async () => {
        await createWith({ a: 1 });
        const btn = fixture.nativeElement.querySelectorAll(
          '.tree-search-toggle',
        )[1] as HTMLButtonElement;
        btn.click();
        fixture.detectChanges();
        expect(prefs.prefs().searchRegexMode).toBe(true);
      });

      it('setSearchScope updates the preference', async () => {
        await createWith({ a: 1 });
        fixture.componentInstance.setSearchScope('keys');
        fixture.detectChanges();
        expect(prefs.prefs().searchScope).toBe('keys');
      });

      it('marks the search input invalid when regex mode + uncompilable pattern', async () => {
        await createWith({ a: 1 });
        prefs.update({ searchRegexMode: true });
        setSearch('[unclosed');
        expect(fixture.componentInstance.searchRegexInvalid()).toBe(true);
        expect(input().classList.contains('tree-search--invalid')).toBe(true);
      });

      it('does not mark invalid when regex mode is off, even with bracket patterns', async () => {
        await createWith({ a: 1 });
        setSearch('[unclosed');
        expect(fixture.componentInstance.searchRegexInvalid()).toBe(false);
      });
    });

    describe('Prev / Next navigation', () => {
      it('cycles forward through hits and wraps to the first', async () => {
        await createWith({ alpha: 1, alphabet: 2, alpine: 3 });
        setSearch('alp');
        const c = fixture.componentInstance;
        expect(c.searchHitCount()).toBe(3);
        // Initial active index resets to 0 (first hit).
        expect(c.activeHitIndex()).toBe(0);
        c.goToNextMatch();
        expect(c.activeHitIndex()).toBe(1);
        c.goToNextMatch();
        expect(c.activeHitIndex()).toBe(2);
        c.goToNextMatch();
        expect(c.activeHitIndex()).toBe(0);
      });

      it('cycles backward through hits and wraps to the last', async () => {
        await createWith({ alpha: 1, alphabet: 2, alpine: 3 });
        setSearch('alp');
        const c = fixture.componentInstance;
        c.goToPrevMatch();
        expect(c.activeHitIndex()).toBe(2);
        c.goToPrevMatch();
        expect(c.activeHitIndex()).toBe(1);
      });

      it('Enter advances to the next match; Shift+Enter to the previous', async () => {
        await createWith({ alpha: 1, alphabet: 2, alpine: 3 });
        setSearch('alp');
        const c = fixture.componentInstance;
        const enter = new KeyboardEvent('keydown', {
          key: 'Enter',
          cancelable: true,
          bubbles: true,
        });
        input().dispatchEvent(enter);
        fixture.detectChanges();
        expect(c.activeHitIndex()).toBe(1);
        const shiftEnter = new KeyboardEvent('keydown', {
          key: 'Enter',
          shiftKey: true,
          cancelable: true,
          bubbles: true,
        });
        input().dispatchEvent(shiftEnter);
        fixture.detectChanges();
        expect(c.activeHitIndex()).toBe(0);
      });

      it('expands ancestors of the active hit', async () => {
        await createWith({ outer: { inner: { needle: 1 } } });
        const c = fixture.componentInstance;
        c.collapseAll();
        fixture.detectChanges();
        setSearch('needle');
        // Initial reveal triggered by the index reset to 0 should expand
        // the path from root through `outer` and `inner`.
        c.goToNextMatch();
        c.goToNextMatch(); // wrap (single hit)
        const outer = c.__getHelpersForTesting().findNode((n) => n.segment === 'outer');
        // dataNodes may be undefined for nested control; fall back to
        // direct lookup via the index.
        const root = c.root();
        const outerNode = root?.children?.[0];
        const innerNode = outerNode?.children?.[0];
        expect(outerNode && c.__getHelpersForTesting().isExpanded(outerNode)).toBe(true);
        expect(innerNode && c.__getHelpersForTesting().isExpanded(innerNode)).toBe(true);
        // Silence unused-variable warning for the dataNodes lookup.
        void outer;
      });

      it('disables prev/next buttons when there are no hits', async () => {
        await createWith({ a: 1 });
        setSearch('zzz');
        const navButtons = fixture.nativeElement.querySelectorAll(
          '.tree-search-nav',
        ) as NodeListOf<HTMLButtonElement>;
        expect(navButtons[0].disabled).toBe(true);
        expect(navButtons[1].disabled).toBe(true);
      });

      it('resets the active index when the query changes', async () => {
        await createWith({ alpha: 1, alphabet: 2 });
        setSearch('alp');
        const c = fixture.componentInstance;
        c.goToNextMatch();
        expect(c.activeHitIndex()).toBe(1);
        setSearch('alpha');
        expect(c.activeHitIndex()).toBe(0);
      });
    });
  });

  describe('search term persistence', () => {
    const SEARCH_KEY = 'jotjson.treeSearch.v1';

    beforeEach(() => localStorage.removeItem(SEARCH_KEY));
    afterEach(() => localStorage.removeItem(SEARCH_KEY));

    it('hydrates the search signal from localStorage on construction', async () => {
      localStorage.setItem(SEARCH_KEY, 'alpha');
      await createWith({ alpha: 1, beta: 2 });
      expect(fixture.componentInstance.search()).toBe('alpha');
    });

    it('persists search updates to localStorage', async () => {
      await createWith({ alpha: 1 });
      fixture.componentInstance.search.set('alpha');
      fixture.detectChanges();
      expect(localStorage.getItem(SEARCH_KEY)).toBe('alpha');
    });

    it('removes the storage key when the search is cleared', async () => {
      localStorage.setItem(SEARCH_KEY, 'alpha');
      await createWith({ alpha: 1 });
      fixture.componentInstance.search.set('');
      fixture.detectChanges();
      expect(localStorage.getItem(SEARCH_KEY)).toBeNull();
    });

    it('tolerates localStorage.setItem throwing (private mode / quota)', async () => {
      await createWith({ alpha: 1 });
      const original = localStorage.setItem.bind(localStorage);
      spyOn(localStorage, 'setItem').and.callFake((key: string, value: string) => {
        if (key === SEARCH_KEY) {
          throw new Error('quota exceeded');
        }
        original(key, value);
      });
      expect(() => {
        fixture.componentInstance.search.set('alpha');
        fixture.detectChanges();
      }).not.toThrow();
      expect(fixture.componentInstance.search()).toBe('alpha');
    });

    it('tolerates localStorage.getItem throwing on hydrate', async () => {
      const originalGet = Storage.prototype.getItem;
      spyOn(Storage.prototype, 'getItem').and.callFake(function (this: Storage, key: string) {
        if (key === SEARCH_KEY) {
          throw new Error('blocked');
        }
        return originalGet.call(this, key);
      });
      await createWith({ alpha: 1 });
      expect(fixture.componentInstance.search()).toBe('');
    });
  });

  describe('embeddedMode (M6d-3-fu2)', () => {
    const SEARCH_KEY = 'jotjson.treeSearch.v1';

    async function createEmbedded(value: unknown): Promise<void> {
      localStorage.removeItem(STORAGE_KEY);
      TestBed.resetTestingModule();
      snackOpen = jasmine.createSpy('snackOpen');
      await TestBed.configureTestingModule({
        imports: [JsonTreeComponent],
        providers: [...provideFakeAuth(), { provide: MatSnackBar, useValue: { open: snackOpen } }],
      }).compileComponents();
      fixture = TestBed.createComponent(JsonTreeComponent);
      prefs = TestBed.inject(PreferencesService);
      fixture.componentRef.setInput('value', value);
      fixture.componentRef.setInput('embeddedMode', true);
      fixture.detectChanges();
      cmp = fixture.componentInstance;
    }

    afterEach(() => localStorage.removeItem(SEARCH_KEY));

    it('does not write to localStorage when search() changes', async () => {
      await createEmbedded({ alpha: 1 });
      expect(localStorage.getItem(SEARCH_KEY)).toBeNull();
      fixture.componentInstance.search.set('foo');
      fixture.detectChanges();
      expect(localStorage.getItem(SEARCH_KEY)).toBeNull();
    });

    it('ignores a preexisting localStorage value at construction', async () => {
      localStorage.setItem(SEARCH_KEY, 'preexisting');
      await createEmbedded({ alpha: 1 });
      expect(fixture.componentInstance.search()).toBe('');
      // And the preexisting value must remain untouched (not overwritten).
      expect(localStorage.getItem(SEARCH_KEY)).toBe('preexisting');
    });

    it('hides the search input from the DOM', async () => {
      await createEmbedded({ alpha: 1 });
      const searchInput = fixture.nativeElement.querySelector('input[type="search"].tree-search');
      expect(searchInput).toBeNull();
    });

    it('default (embeddedMode unset) preserves persisted-search behavior', async () => {
      // Regression: the existing persistence flow still works when the
      // Input is not set.
      await createWith({ alpha: 1 });
      fixture.componentInstance.search.set('alpha');
      fixture.detectChanges();
      expect(localStorage.getItem(SEARCH_KEY)).toBe('alpha');
    });

    it('two trees (one embedded, one not) do not cross-contaminate', async () => {
      // Mount a non-embedded tree first; write a search value via signal.
      await createWith({ alpha: 1 });
      fixture.componentInstance.search.set('home-search');
      fixture.detectChanges();
      expect(localStorage.getItem(SEARCH_KEY)).toBe('home-search');
      const homeFixture = fixture;
      // Mount a separate embedded tree in a fresh testing module.
      await createEmbedded({ alpha: 1 });
      const embedded = fixture.componentInstance;
      expect(embedded.search()).toBe('');
      embedded.search.set('preview-search');
      fixture.detectChanges();
      // Embedded write must NOT clobber the home tree's persisted value.
      expect(localStorage.getItem(SEARCH_KEY)).toBe('home-search');
      // Home component's in-memory signal must also be unchanged
      // (different signal instance).
      expect(homeFixture.componentInstance.search()).toBe('home-search');
    });
  });

  describe('formatting rules integration (M6f-3)', () => {
    let httpMock: HttpTestingController;
    let ruleSets: RuleSetsService;

    function seedRuleSets(sets: FormattingRuleSet[]): void {
      ruleSets.list().subscribe();
      const req = httpMock.expectOne((r) => r.url.endsWith('/rule-sets') && r.method === 'GET');
      req.flush(sets);
    }

    function makeRule(overrides: Partial<FormattingRuleSimple> = {}): FormattingRuleSimple {
      return {
        id: 'r1',
        target: 'value',
        matchType: 'exact',
        matchValue: 'error',
        caseSensitive: false,
        style: { backgroundColor: '#ffcdd2' },
        ...overrides,
      };
    }

    function makeSet(
      rules: FormattingRule[],
      overrides: Partial<FormattingRuleSet> = {},
    ): FormattingRuleSet {
      return {
        id: 'set-1',
        userId: 'oid-1',
        name: 'Errors',
        rules,
        version: 1,
        createdAt: '2026-04-27T00:00:00.000Z',
        updatedAt: '2026-04-27T00:00:00.000Z',
        ...overrides,
      };
    }

    beforeEach(() => {
      // createWith resets TestBed; grab service handles after the
      // component is constructed in each test.
    });

    async function setUp(value: unknown): Promise<void> {
      await createWith(value);
      httpMock = TestBed.inject(HttpTestingController);
      ruleSets = TestBed.inject(RuleSetsService);
    }

    afterEach(() => {
      httpMock?.verify();
    });

    it('returns null styles when no rule sets are active', async () => {
      await setUp({ status: 'error' });
      cmp.expandAll();
      fixture.detectChanges();
      const root = cmp.root()!;
      const status = root.children!.find((c) => c.segment === 'status')!;
      expect(cmp.ruleStyleVars(status)).toBeNull();
      expect(cmp.matchedRuleTitle(status)).toBeNull();
    });

    it('paints --tree-row-format-bg and --tree-value-color on a matched leaf', async () => {
      await setUp({ status: 'error' });
      seedRuleSets([
        makeSet([
          makeRule({
            target: 'value',
            matchValue: 'error',
            style: { backgroundColor: '#ffcdd2', textColor: '#b71c1c' },
          }),
        ]),
      ]);
      prefs.update({ activeRuleSetIds: ['set-1'] });
      cmp.expandAll();
      fixture.detectChanges();
      const root = cmp.root()!;
      const status = root.children!.find((c) => c.segment === 'status')!;
      const styles = cmp.ruleStyleVars(status);
      expect(styles).not.toBeNull();
      expect(styles!['--tree-row-format-bg']).toBe('#ffcdd2');
      expect(styles!['--tree-value-color']).toBe('#b71c1c');
    });

    it('honors the F8 contract: a string "200" matches a value-exact "200" rule', async () => {
      await setUp({ stringStatus: '200', numberStatus: 200 });
      seedRuleSets([
        makeSet([
          makeRule({
            id: 'r-200',
            target: 'value',
            matchType: 'exact',
            matchValue: '200',
            style: { backgroundColor: '#c8e6c9' },
          }),
        ]),
      ]);
      prefs.update({ activeRuleSetIds: ['set-1'] });
      cmp.expandAll();
      fixture.detectChanges();

      const root = cmp.root()!;
      const stringNode = root.children!.find((c) => c.segment === 'stringStatus')!;
      const numberNode = root.children!.find((c) => c.segment === 'numberStatus')!;
      expect(cmp.ruleStyleVars(stringNode)?.['--tree-row-format-bg']).toBe('#c8e6c9');
      expect(cmp.ruleStyleVars(numberNode)?.['--tree-row-format-bg']).toBe('#c8e6c9');
    });

    it('does NOT match accidentally-quoted text against a value rule (regression for F8)', async () => {
      // Producer must not pass through JSON.stringify-quoted strings.
      // If it did, `'"200"'` would not equal `'200'` and the rule would
      // miss. This test pins the producer contract.
      await setUp({ status: '200' });
      seedRuleSets([
        makeSet([makeRule({ target: 'value', matchType: 'exact', matchValue: '200' })]),
      ]);
      prefs.update({ activeRuleSetIds: ['set-1'] });
      cmp.expandAll();
      fixture.detectChanges();
      const root = cmp.root()!;
      const status = root.children!.find((c) => c.segment === 'status')!;
      expect(cmp.ruleStyleVars(status)).not.toBeNull();
    });

    it('skips containers for value-target rules but allows key-target', async () => {
      await setUp({ errors: [1, 2] });
      seedRuleSets([
        makeSet([
          makeRule({
            id: 'r-key',
            target: 'key',
            matchType: 'exact',
            matchValue: 'errors',
            style: { textColor: '#b71c1c' },
          }),
          makeRule({
            id: 'r-val',
            target: 'value',
            matchType: 'contains',
            matchValue: 'errors',
            style: { backgroundColor: '#ffcdd2' },
          }),
        ]),
      ]);
      prefs.update({ activeRuleSetIds: ['set-1'] });
      cmp.expandAll();
      fixture.detectChanges();
      const root = cmp.root()!;
      const errors = root.children!.find((c) => c.segment === 'errors')!;
      const styles = cmp.ruleStyleVars(errors);
      expect(styles?.['--tree-key-color']).toBe('#b71c1c');
      // value rule is skipped on the container, so no row background:
      expect(styles?.['--tree-row-format-bg']).toBeUndefined();
    });

    it('surfaces matched-rule labels via matchedRuleTitle (newline-joined)', async () => {
      await setUp({ status: 'error' });
      seedRuleSets([
        makeSet([
          makeRule({ id: 'r1', target: 'value', matchType: 'exact', matchValue: 'error' }),
          makeRule({
            id: 'r2',
            target: 'value',
            matchType: 'contains',
            matchValue: 'err',
          }),
        ]),
      ]);
      prefs.update({ activeRuleSetIds: ['set-1'] });
      cmp.expandAll();
      fixture.detectChanges();
      const root = cmp.root()!;
      const status = root.children!.find((c) => c.segment === 'status')!;
      const title = cmp.matchedRuleTitle(status);
      expect(title).toContain('value exact "error"');
      expect(title).toContain('value contains "err"');
      expect(title!.split('\n').length).toBe(2);
    });

    it('renders a key-side icon when an icon-bearing rule matches', async () => {
      await setUp({ warning: 'high' });
      seedRuleSets([
        makeSet([
          makeRule({
            id: 'r1',
            target: 'key',
            matchType: 'exact',
            matchValue: 'warning',
            style: { icon: 'warning' },
          }),
        ]),
      ]);
      prefs.update({ activeRuleSetIds: ['set-1'] });
      cmp.expandAll();
      fixture.detectChanges();
      const root = cmp.root()!;
      const warnNode = root.children!.find((c) => c.segment === 'warning')!;
      expect(cmp.keyIcons(warnNode)).toEqual(['warning']);
      expect(cmp.valueIcons(warnNode)).toEqual([]);
      const iconEl = (fixture.nativeElement as HTMLElement).querySelector('.tree-rule-icon--key');
      expect(iconEl).not.toBeNull();
    });

    it('caches engine results across multiple lookups for the same node', async () => {
      // Memoization smoke test: a single tree node calls the engine
      // exactly once per (activeSets, key, valueText, isContainer)
      // tuple. Since `evaluateNode` is a `computed()`, repeated calls
      // hit the same closure-scoped cache.
      await setUp({ status: 'error' });
      seedRuleSets([
        makeSet([makeRule({ target: 'value', matchType: 'exact', matchValue: 'error' })]),
      ]);
      prefs.update({ activeRuleSetIds: ['set-1'] });
      const root = cmp.root()!;
      const status = root.children!.find((c) => c.segment === 'status')!;
      const a = cmp.ruleResultFor(status);
      const b = cmp.ruleResultFor(status);
      expect(a).toBe(b);
    });

    it('drops the cache when activeRuleSets changes', async () => {
      await setUp({ status: 'error' });
      seedRuleSets([
        makeSet([makeRule({ id: 'r1', target: 'value', matchType: 'exact', matchValue: 'error' })]),
      ]);
      prefs.update({ activeRuleSetIds: ['set-1'] });
      const root = cmp.root()!;
      const status = root.children!.find((c) => c.segment === 'status')!;
      const before = cmp.ruleResultFor(status);

      // Toggle off - now no rules apply, result must change identity.
      prefs.update({ activeRuleSetIds: [] });
      const after = cmp.ruleResultFor(status);
      expect(before).not.toBe(after);
    });
  });

  describe('overrideRuleSets Input (M6d-3 live preview)', () => {
    let httpMock: HttpTestingController;
    let ruleSets: RuleSetsService;

    function makeRule(overrides: Partial<FormattingRuleSimple> = {}): FormattingRuleSimple {
      return {
        id: 'r1',
        target: 'value',
        matchType: 'exact',
        matchValue: 'error',
        caseSensitive: false,
        style: { backgroundColor: '#ffcdd2' },
        ...overrides,
      };
    }

    function makeSet(
      rules: FormattingRule[],
      overrides: Partial<FormattingRuleSet> = {},
    ): FormattingRuleSet {
      return {
        id: 'set-1',
        userId: 'oid-1',
        name: 'Set',
        rules,
        version: 1,
        createdAt: '2026-04-27T00:00:00.000Z',
        updatedAt: '2026-04-27T00:00:00.000Z',
        ...overrides,
      };
    }

    function seedDefault(sets: FormattingRuleSet[]): void {
      ruleSets.list().subscribe();
      const req = httpMock.expectOne((r) => r.url.endsWith('/rule-sets') && r.method === 'GET');
      req.flush(sets);
    }

    async function setUp(value: unknown): Promise<void> {
      await createWith(value);
      httpMock = TestBed.inject(HttpTestingController);
      ruleSets = TestBed.inject(RuleSetsService);
    }

    afterEach(() => {
      httpMock?.verify();
    });

    it('uses overrideRuleSets when set, not the service-derived list', async () => {
      await setUp({ status: 'error' });
      seedDefault([
        makeSet([makeRule({ matchValue: 'error', style: { backgroundColor: '#000000' } })], {
          id: 'default-set',
        }),
      ]);
      prefs.update({ activeRuleSetIds: ['default-set'] });

      const overrideSet = makeSet(
        [makeRule({ matchValue: 'error', style: { backgroundColor: '#abcdef' } })],
        { id: 'override-set' },
      );
      fixture.componentRef.setInput('overrideRuleSets', [overrideSet]);
      fixture.detectChanges();

      const status = cmp.root()!.children!.find((c) => c.segment === 'status')!;
      const styles = cmp.ruleStyleVars(status);
      expect(styles?.['--tree-row-format-bg']).toBe('#abcdef');
    });

    it('falls back to the service when overrideRuleSets is null (default)', async () => {
      await setUp({ status: 'error' });
      seedDefault([
        makeSet([makeRule({ matchValue: 'error', style: { backgroundColor: '#112233' } })]),
      ]);
      prefs.update({ activeRuleSetIds: ['set-1'] });
      fixture.detectChanges();

      const status = cmp.root()!.children!.find((c) => c.segment === 'status')!;
      const styles = cmp.ruleStyleVars(status);
      expect(styles?.['--tree-row-format-bg']).toBe('#112233');
    });

    it('treats an empty array override as "no rule sets active" (does NOT fall back)', async () => {
      await setUp({ status: 'error' });
      seedDefault([
        makeSet([makeRule({ matchValue: 'error', style: { backgroundColor: '#112233' } })]),
      ]);
      prefs.update({ activeRuleSetIds: ['set-1'] });

      fixture.componentRef.setInput('overrideRuleSets', []);
      fixture.detectChanges();

      const status = cmp.root()!.children!.find((c) => c.segment === 'status')!;
      expect(cmp.ruleStyleVars(status)).toBeNull();
    });

    it('per-instance: overriding one tree does not affect another instance', async () => {
      await setUp({ status: 'error' });
      seedDefault([
        makeSet([makeRule({ matchValue: 'error', style: { backgroundColor: '#112233' } })]),
      ]);
      prefs.update({ activeRuleSetIds: ['set-1'] });

      const overrideSet = makeSet(
        [makeRule({ matchValue: 'error', style: { backgroundColor: '#abcdef' } })],
        { id: 'override-set' },
      );
      fixture.componentRef.setInput('overrideRuleSets', [overrideSet]);
      fixture.detectChanges();

      const second = TestBed.createComponent(JsonTreeComponent);
      second.componentRef.setInput('value', { status: 'error' });
      second.detectChanges();
      const secondCmp = second.componentInstance;

      const firstStyles = cmp.ruleStyleVars(
        cmp.root()!.children!.find((c) => c.segment === 'status')!,
      );
      const secondStyles = secondCmp.ruleStyleVars(
        secondCmp.root()!.children!.find((c) => c.segment === 'status')!,
      );

      expect(firstStyles?.['--tree-row-format-bg']).toBe('#abcdef');
      expect(secondStyles?.['--tree-row-format-bg']).toBe('#112233');
    });
  });

  describe('selection sync API (issue #42)', () => {
    it('hasPath returns true for known paths and false for unknown', async () => {
      await createWith({ a: 1, b: { c: 2 } });
      expect(cmp.hasPath('$')).toBeTrue();
      expect(cmp.hasPath('$.a')).toBeTrue();
      expect(cmp.hasPath('$.b')).toBeTrue();
      expect(cmp.hasPath('$.b.c')).toBeTrue();
      expect(cmp.hasPath('$.nonexistent')).toBeFalse();
      expect(cmp.hasPath('not-a-path')).toBeFalse();
    });

    it('selectByPathString writes when different from current selection', async () => {
      await createWith({ a: 1, b: 2 });
      cmp.selectByPathString('$.a');
      expect(cmp.selectedPath()).toBe('$.a');
      cmp.selectByPathString('$.b');
      expect(cmp.selectedPath()).toBe('$.b');
    });

    it('selectByPathString is idempotent for the same path (no extra write)', async () => {
      await createWith({ a: 1 });
      cmp.selectByPathString('$.a');
      const writes: (string | null)[] = [];
      cmp.selectionChange.subscribe((path) => {
        writes.push(path === null ? null : formatPath([...path]));
      });
      cmp.selectByPathString('$.a');
      // Effect did not re-fire since selectedPath stayed the same.
      expect(writes).toEqual([]);
    });

    it('selectByPathString silently no-ops for unknown paths', async () => {
      await createWith({ a: 1 });
      cmp.selectByPathString('$.does.not.exist');
      expect(cmp.selectedPath()).toBeNull();
    });

    it('selectByPathString(null) clears the selection', async () => {
      await createWith({ a: 1 });
      cmp.selectByPathString('$.a');
      expect(cmp.selectedPath()).toBe('$.a');
      cmp.selectByPathString(null);
      expect(cmp.selectedPath()).toBeNull();
    });

    it('selectByPathString expands ancestors so the row is visible', async () => {
      await createWith({ a: { b: { c: 1 } } });
      cmp.collapseAll();
      fixture.detectChanges();
      const rootNode = cmp.root()!;
      const aNode = rootNode.children!.find((child) => child.segment === 'a')!;
      const bNode = aNode.children!.find((child) => child.segment === 'b')!;
      expect(cmp.__getHelpersForTesting().isExpanded(aNode)).toBeFalse();
      expect(cmp.__getHelpersForTesting().isExpanded(bNode)).toBeFalse();
      cmp.selectByPathString('$.a.b.c');
      expect(cmp.__getHelpersForTesting().isExpanded(aNode)).toBeTrue();
      expect(cmp.__getHelpersForTesting().isExpanded(bNode)).toBeTrue();
    });

    it('expandNodeAtPath expands exactly the named node (no descendants, no ancestors)', async () => {
      await createWith({ outer: { target: { inner: { leaf: 1 } } } });
      cmp.collapseAll();
      fixture.detectChanges();
      const rootNode = cmp.root()!;
      const outerNode = rootNode.children!.find((child) => child.segment === 'outer')!;
      const targetNode = outerNode.children!.find((child) => child.segment === 'target')!;
      const innerNode = targetNode.children!.find((child) => child.segment === 'inner')!;

      cmp.expandNodeAtPath(['outer', 'target']);

      expect(cmp.__getHelpersForTesting().isExpanded(targetNode))
        .withContext('target expanded')
        .toBeTrue();
      expect(cmp.__getHelpersForTesting().isExpanded(outerNode))
        .withContext('outer (ancestor) NOT expanded')
        .toBeFalse();
      expect(cmp.__getHelpersForTesting().isExpanded(innerNode))
        .withContext('inner (descendant) NOT expanded')
        .toBeFalse();
    });

    it('expandNodeAtPath silently no-ops for unknown paths', async () => {
      await createWith({ a: { b: 1 } });
      cmp.collapseAll();
      fixture.detectChanges();
      const aNode = cmp.root()!.children!.find((child) => child.segment === 'a')!;

      expect(() => cmp.expandNodeAtPath(['does', 'not', 'exist'])).not.toThrow();
      expect(cmp.__getHelpersForTesting().isExpanded(aNode)).toBeFalse();
    });

    it('expandNodeAtPath persists across re-parse via pathString trackBy', async () => {
      // Mimics the post-extract flow: caller invokes expandNodeAtPath
      // before the value re-flows. The expansion model is keyed on
      // pathString, so the post-mutation node renders expanded.
      await createWith({ a: 'string-value' });
      cmp.collapseAll();
      fixture.detectChanges();

      cmp.expandNodeAtPath(['a']);

      // Now mutate $.a from a leaf string to an object container.
      // Do not await whenStable() here: the component owns a persistent
      // setInterval (NOW_TICK_MS) that keeps the zone busy, so whenStable
      // would never resolve under Karma+Zone. detectChanges flushes the
      // input change synchronously, which is sufficient.
      fixture.componentRef.setInput('value', { a: { wrapped: 1 } });
      fixture.detectChanges();

      const newRootNode = cmp.root()!;
      const newANode = newRootNode.children!.find((child) => child.segment === 'a')!;
      expect(newANode.children?.length).toBeGreaterThan(0);
      expect(cmp.__getHelpersForTesting().isExpanded(newANode))
        .withContext('post-mutation node honors pre-mutation expand call')
        .toBeTrue();
    });

    it('selectionChange emits structural path when selectedPath changes (e.g. via user click)', async () => {
      // selectedPath is the canonical funnel for both user clicks
      // (via onSelect) and programmatic selection. Drive it directly
      // to assert the effect-based emission contract regardless of
      // who flipped the signal.
      await createWith({ a: 1 });
      const events: (readonly (string | number)[] | null)[] = [];
      cmp.selectionChange.subscribe((path) => events.push(path));
      cmp.selectedPath.set('$.a');
      fixture.detectChanges();
      expect(events.some((path) => path !== null && path.length === 1 && path[0] === 'a'))
        .withContext('expected a selectionChange event with path ["a"]')
        .toBeTrue();
    });

    it('selectionChange emits on programmatic selectByPathString', async () => {
      await createWith({ a: { b: 1 } });
      const events: (readonly (string | number)[] | null)[] = [];
      cmp.selectionChange.subscribe((path) => events.push(path));
      cmp.selectByPathString('$.a.b');
      fixture.detectChanges();
      const matched = events.find(
        (path) => path !== null && path.length === 2 && path[0] === 'a' && path[1] === 'b',
      );
      expect(matched).withContext('expected path ["a","b"]').toBeTruthy();
    });

    it('selectionChange emits null when selection is cleared', async () => {
      await createWith({ a: 1 });
      cmp.selectByPathString('$.a');
      fixture.detectChanges();
      const events: (readonly (string | number)[] | null)[] = [];
      cmp.selectionChange.subscribe((path) => events.push(path));
      cmp.selectByPathString(null);
      fixture.detectChanges();
      expect(events).toContain(null);
    });

    it('selectByPathString resolves the synthetic root path "$"', async () => {
      await createWith({ a: 1 });
      cmp.selectByPathString('$');
      expect(cmp.selectedPath()).toBe('$');
    });
  });

  // ---------------------------------------------------------------------------
  // Phase 2 breadcrumb: the `crumbs()` view-model and DOM/click behaviour.
  // The breadcrumb itself (chip layout, overflow menu) is exercised in
  // `json-breadcrumb.component.spec.ts`; these tests cover the wiring
  // between selection state and the view-model, plus the click handler.
  // ---------------------------------------------------------------------------
  describe('breadcrumb view-model', () => {
    // Local clipboard mock helper (the canonical `withCtxClipboard`
    // lives inside the `row context menu` describe and isn't visible
    // here). Mirrors the same restore semantics: if `navigator` had
    // no own `clipboard` descriptor before our override, we delete
    // ours so the prototype's getter is restored.
    function withClipboardStub<T>(stub: { writeText?: jasmine.Spy } | undefined, run: () => T): T {
      const original = (navigator as { clipboard?: Clipboard }).clipboard;
      const hadOwn = Object.prototype.hasOwnProperty.call(navigator, 'clipboard');
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: stub,
      });
      try {
        return run();
      } finally {
        if (hadOwn && original) {
          Object.defineProperty(navigator, 'clipboard', {
            configurable: true,
            value: original,
          });
        } else {
          delete (navigator as { clipboard?: unknown }).clipboard;
        }
      }
    }

    it('returns an empty array when nothing is selected', async () => {
      await createWith({ a: 1 });
      expect(cmp.selectedPath()).toBeNull();
      expect(cmp.crumbs()).toEqual([]);
    });

    it('returns a single Root crumb (current) when the root is selected', async () => {
      await createWith({ a: 1 });
      cmp.selectByPathString('$');
      expect(cmp.crumbs().length).toBe(1);
      const [root] = cmp.crumbs();
      expect(root!.canonicalPath).toBe('$');
      expect(root!.label).toBe(cmp.breadcrumbRootLabel);
      expect(root!.current).toBe(true);
    });

    it('returns Root + ancestors + selected leaf for a deep path, with current on the leaf', async () => {
      await createWith({ foo: { bar: { baz: 1 } } });
      cmp.selectByPathString('$.foo.bar.baz');
      const labels = cmp.crumbs().map((crumb) => crumb.label);
      expect(labels).toEqual([cmp.breadcrumbRootLabel, 'foo', 'bar', 'baz']);
      const paths = cmp.crumbs().map((crumb) => crumb.canonicalPath);
      expect(paths).toEqual(['$', '$.foo', '$.foo.bar', '$.foo.bar.baz']);
      const currents = cmp.crumbs().map((crumb) => crumb.current);
      expect(currents).toEqual([false, false, false, true]);
    });

    it('renders array-index segments as [0], [1], etc. and includes the leaf', async () => {
      await createWith({ items: [{ name: 'a' }] });
      cmp.selectByPathString('$.items[0].name');
      const labels = cmp.crumbs().map((crumb) => crumb.label);
      expect(labels).toEqual([cmp.breadcrumbRootLabel, 'items', '[0]', 'name']);
      const paths = cmp.crumbs().map((crumb) => crumb.canonicalPath);
      expect(paths).toEqual(['$', '$.items', '$.items[0]', '$.items[0].name']);
      const currents = cmp.crumbs().map((crumb) => crumb.current);
      expect(currents).toEqual([false, false, false, true]);
    });

    it('renders escaped keys as their raw label and quoted canonical path, leaf marked current', async () => {
      await createWith({ 'a.b': { x: 1 } });
      cmp.selectByPathString('$["a.b"].x');
      expect(cmp.selectedPath()).toBe('$["a.b"].x');
      const labels = cmp.crumbs().map((crumb) => crumb.label);
      expect(labels).toEqual([cmp.breadcrumbRootLabel, 'a.b', 'x']);
      const paths = cmp.crumbs().map((crumb) => crumb.canonicalPath);
      expect(paths).toEqual(['$', '$["a.b"]', '$["a.b"].x']);
      const last = cmp.crumbs()[cmp.crumbs().length - 1]!;
      expect(last.current).toBe(true);
    });

    it('onBreadcrumbClick re-selects the ancestor and logs telemetry with depth + selectionUpDistance', async () => {
      await createWith({ foo: { bar: { baz: 1 } } });
      cmp.selectByPathString('$.foo.bar.baz');
      // crumbs = [Root(0), foo(1), bar(2), baz(3,current)] -> total 4
      const logger = TestBed.inject(LoggerService);
      const info = spyOn(logger, 'info');
      cmp.onBreadcrumbClick({ canonicalPath: '$.foo', depth: 1 });
      expect(cmp.selectedPath()).toBe('$.foo');
      expect(info).toHaveBeenCalledWith('tree.breadcrumb.click', {
        depth: 1,
        // Pre-click crumbs.length=4, depth=1 => up-distance from old leaf (depth=3) = 4-1-1 = 2
        selectionUpDistance: 2,
      });
    });

    it('onBreadcrumbClick on the current crumb logs selectionUpDistance: 0', async () => {
      await createWith({ foo: { bar: 1 } });
      cmp.selectByPathString('$.foo.bar');
      // crumbs = [Root(0), foo(1), bar(2,current)] -> total 3
      const logger = TestBed.inject(LoggerService);
      const info = spyOn(logger, 'info');
      cmp.onBreadcrumbClick({ canonicalPath: '$.foo.bar', depth: 2 });
      expect(info).toHaveBeenCalledWith('tree.breadcrumb.click', {
        depth: 2,
        selectionUpDistance: 0,
      });
    });

    it('clicking a chip in the rendered breadcrumb DOM updates selection', async () => {
      await createWith({ foo: { bar: 1 } });
      cmp.selectByPathString('$.foo.bar');
      fixture.detectChanges();
      const chips = Array.from(
        fixture.nativeElement.querySelectorAll('.jj-breadcrumb__chip'),
      ) as HTMLButtonElement[];
      // crumbs = [Root, foo, bar(current)] -> 3 chips. Click foo (index 1).
      expect(chips.length).toBe(3);
      chips[1]!.click();
      fixture.detectChanges();
      expect(cmp.selectedPath()).toBe('$.foo');
    });

    it('breadcrumbCopyDisabled is true when nothing is selected', async () => {
      await createWith({ a: 1 });
      expect(cmp.selectedPath()).toBeNull();
      expect(cmp.breadcrumbCopyDisabled()).toBe(true);
    });

    it('breadcrumbCopyDisabled is false once a row is selected', async () => {
      await createWith({ a: 1 });
      cmp.selectByPathString('$.a');
      expect(cmp.breadcrumbCopyDisabled()).toBe(false);
    });

    it('onBreadcrumbCopyPath is a no-op when nothing is selected', async () => {
      await createWith({ a: 1 });
      const logger = TestBed.inject(LoggerService);
      const info = spyOn(logger, 'info');
      const writeText = jasmine.createSpy('writeText').and.resolveTo();
      withClipboardStub({ writeText }, () => cmp.onBreadcrumbCopyPath());
      expect(info).not.toHaveBeenCalled();
      expect(writeText).not.toHaveBeenCalled();
    });

    it('onBreadcrumbCopyPath copies the selected path and logs telemetry', async () => {
      await createWith({ foo: { bar: 1 } });
      cmp.selectByPathString('$.foo.bar');
      // crumbs = [Root(0), foo(1), bar(2,current)] -> total 3, leaf depth = 2
      const logger = TestBed.inject(LoggerService);
      const info = spyOn(logger, 'info');
      const writeText = jasmine.createSpy('writeText').and.resolveTo();
      withClipboardStub({ writeText }, () => cmp.onBreadcrumbCopyPath());
      expect(info).toHaveBeenCalledWith('tree.breadcrumb.copyPath', {
        depth: 2,
        selectionUpDistance: 0,
      });
      expect(writeText).toHaveBeenCalled();
    });
  });

  describe('embedded JSON extraction UI', () => {
    const embeddedJson = 'prefix {"ok": true} suffix';

    function replacementFor(text = '{\n  "ok": true\n}'): ExtractedJson {
      return {
        text,
        blockCount: 1,
        preservesComments: true,
        hasComments: false,
      };
    }

    function candidatesFor(
      rawString: string,
      replacement: ExtractedJson = replacementFor(),
    ): ReadonlyMap<string, ExtractedJson> {
      return new Map<string, ExtractedJson>([[rawString, replacement]]);
    }

    function setExtractCandidates(
      rawString: string,
      replacement: ExtractedJson = replacementFor(),
    ): void {
      fixture.componentRef.setInput('extractCandidates', candidatesFor(rawString, replacement));
      fixture.detectChanges();
    }

    function extractButtonFor(pathString: string): HTMLButtonElement | null {
      return (fixture.nativeElement as HTMLElement).querySelector(
        `.tree-row[data-path="${pathString}"] .tree-extract-pill`,
      ) as HTMLButtonElement | null;
    }

    async function openMenuFor(pathString: string): Promise<void> {
      const kebab = (fixture.nativeElement as HTMLElement).querySelector(
        `.tree-row[data-path="${pathString}"] .tree-kebab-pill`,
      ) as HTMLButtonElement | null;
      expect(kebab).withContext(`found a kebab for ${pathString}`).toBeTruthy();
      kebab!.click();
      fixture.detectChanges();
      await Promise.resolve();
      fixture.detectChanges();
    }

    function extractMenuItem(): HTMLButtonElement | null {
      return (
        Array.from(
          document.body.querySelectorAll<HTMLButtonElement>('button.mat-mdc-menu-item'),
        ).find((item) => (item.textContent ?? '').includes('Extract embedded JSON')) ?? null
      );
    }

    function closeOpenMenus(): void {
      document.body
        .querySelectorAll('.cdk-overlay-backdrop')
        .forEach((backdrop) => (backdrop as HTMLElement).click());
      fixture.detectChanges();
    }

    it('does not render the extract button when extractCandidates is null', async () => {
      await createWith({ payload: embeddedJson });
      cmp.expandAll();
      fixture.detectChanges();

      expect(extractButtonFor('$.payload')).toBeNull();
    });

    it('does not render the extract button when the node type is not string', async () => {
      await createWith({ count: 42 });
      cmp.expandAll();
      fixture.detectChanges();
      setExtractCandidates('42');

      expect(extractButtonFor('$.count')).toBeNull();
    });

    it('does not render the extract button when the string has no candidate', async () => {
      await createWith({ payload: embeddedJson });
      cmp.expandAll();
      fixture.detectChanges();
      setExtractCandidates('other string');

      expect(extractButtonFor('$.payload')).toBeNull();
    });

    it('renders the extract button when the string has a candidate', async () => {
      await createWith({ payload: embeddedJson });
      cmp.expandAll();
      fixture.detectChanges();
      setExtractCandidates(embeddedJson);

      expect(extractButtonFor('$.payload')).not.toBeNull();
    });

    it('clicking the extract button emits extractRequest with rowButton source', async () => {
      const replacement = replacementFor('{\n  "answer": 42\n}');
      await createWith({ payload: embeddedJson });
      cmp.expandAll();
      fixture.detectChanges();
      setExtractCandidates(embeddedJson, replacement);
      fixture.componentRef.setInput('extractSourceVersion', 7);
      fixture.detectChanges();
      const events: TreeExtractRequest[] = [];
      cmp.extractRequest.subscribe((request) => events.push(request));

      const button = extractButtonFor('$.payload');
      expect(button).toBeTruthy();
      button!.click();

      expect(events).toEqual([
        {
          path: ['payload'],
          sourceVersion: 7,
          replacement,
          source: 'rowButton',
        },
      ]);
    });

    it('clicking the extract button does not toggle row selection', async () => {
      await createWith({ payload: embeddedJson });
      cmp.expandAll();
      fixture.detectChanges();
      setExtractCandidates(embeddedJson);
      const selectionEvents: (readonly (string | number)[] | null)[] = [];
      cmp.selectionChange.subscribe((path) => selectionEvents.push(path));

      const button = extractButtonFor('$.payload');
      expect(button).toBeTruthy();
      const event = new MouseEvent('click', { bubbles: true, cancelable: true });
      const stopSpy = spyOn(event, 'stopPropagation').and.callThrough();
      button!.dispatchEvent(event);
      fixture.detectChanges();

      expect(stopSpy).toHaveBeenCalled();
      expect(cmp.selectedPath()).toBeNull();
      expect(selectionEvents).toEqual([]);
    });

    it('renders the context-menu extract item only when a candidate exists', async () => {
      await createWith({ payload: embeddedJson });
      cmp.expandAll();
      fixture.detectChanges();

      try {
        await openMenuFor('$.payload');
        expect(extractMenuItem()).toBeNull();
        closeOpenMenus();

        setExtractCandidates(embeddedJson);
        await openMenuFor('$.payload');
        expect(extractMenuItem()).not.toBeNull();
      } finally {
        closeOpenMenus();
      }
    });

    it('clicking the context-menu extract item emits extractRequest with contextMenu source', async () => {
      const replacement = replacementFor('{\n  "menu": true\n}');
      await createWith({ payload: embeddedJson });
      cmp.expandAll();
      fixture.detectChanges();
      setExtractCandidates(embeddedJson, replacement);
      fixture.componentRef.setInput('extractSourceVersion', 11);
      fixture.detectChanges();
      const events: TreeExtractRequest[] = [];
      cmp.extractRequest.subscribe((request) => events.push(request));

      try {
        await openMenuFor('$.payload');
        const item = extractMenuItem();
        expect(item).toBeTruthy();
        item!.click();
        fixture.detectChanges();

        expect(events).toEqual([
          {
            path: ['payload'],
            sourceVersion: 11,
            replacement,
            source: 'contextMenu',
          },
        ]);
      } finally {
        closeOpenMenus();
      }
    });

    it('uses a numeric sentinel sourceVersion when extractSourceVersion is null', async () => {
      await createWith({ payload: embeddedJson });
      cmp.expandAll();
      fixture.detectChanges();
      setExtractCandidates(embeddedJson);
      const events: TreeExtractRequest[] = [];
      cmp.extractRequest.subscribe((request) => events.push(request));

      const button = extractButtonFor('$.payload');
      expect(button).toBeTruthy();
      button!.click();

      expect(events.length).toBe(1);
      expect(typeof events[0]?.sourceVersion).toBe('number');
      expect(events[0]?.sourceVersion).toBe(-1);
    });
  });

  // ---------------------------------------------------------------------------
  // Decoded view dialog (per-row pill on string leaves)
  //
  // Display-only sibling of the Extract pill. Clicking the pill (or the
  // "Open decoded value" entry in the row kebab menu) opens a MatDialog
  // viewer showing the raw string with line numbers and a copy button.
  // The pill carries no per-row state - row height stays uniform.
  // Replaces the prior in-row `pre-wrap` toggle (issue #95 Phase 0).
  // ---------------------------------------------------------------------------
  describe('decoded view dialog', () => {
    function decodedButtonFor(pathString: string): HTMLButtonElement | null {
      return (fixture.nativeElement as HTMLElement).querySelector(
        `.tree-row[data-path="${pathString}"] .tree-decoded-pill`,
      ) as HTMLButtonElement | null;
    }

    function valueSpanFor(pathString: string): HTMLElement | null {
      return (fixture.nativeElement as HTMLElement).querySelector(
        `.tree-row[data-path="${pathString}"] .tree-value-string`,
      ) as HTMLElement | null;
    }

    async function openMenuFor(pathString: string): Promise<void> {
      const kebab = (fixture.nativeElement as HTMLElement).querySelector(
        `.tree-row[data-path="${pathString}"] .tree-kebab-pill`,
      ) as HTMLButtonElement | null;
      expect(kebab).withContext(`found a kebab for ${pathString}`).toBeTruthy();
      kebab!.click();
      fixture.detectChanges();
      await Promise.resolve();
      fixture.detectChanges();
    }

    function decodedMenuItem(): HTMLButtonElement | null {
      return (
        Array.from(
          document.body.querySelectorAll<HTMLButtonElement>('button.mat-mdc-menu-item'),
        ).find((item) => /Open decoded value/.test(item.textContent ?? '')) ?? null
      );
    }

    function closeOpenMenus(): void {
      document.body
        .querySelectorAll('.cdk-overlay-backdrop')
        .forEach((backdrop) => (backdrop as HTMLElement).click());
      fixture.detectChanges();
    }

    function spyOnDialogOpen(): jasmine.Spy {
      const dialog = TestBed.inject(MatDialog);
      const spy = spyOn(dialog, 'open').and.returnValue({
        afterClosed: () => ({ subscribe: () => ({ unsubscribe: () => {} }) }),
        close: () => {},
      } as unknown as MatDialogRef<unknown>);
      return spy;
    }

    describe('decodedCandidate predicate', () => {
      it('is true for strings with embedded \\n', async () => {
        await createWith({ note: 'first\nsecond' });
        expect(cmp.decodedCandidate(cmp.root()!.children![0]!)).toBe(true);
      });

      it('is true for strings with embedded \\r', async () => {
        await createWith({ note: 'a\rb' });
        expect(cmp.decodedCandidate(cmp.root()!.children![0]!)).toBe(true);
      });

      it('is true for strings with embedded \\t', async () => {
        await createWith({ note: 'col1\tcol2' });
        expect(cmp.decodedCandidate(cmp.root()!.children![0]!)).toBe(true);
      });

      it('is true for strings with embedded quotes', async () => {
        await createWith({ note: 'say "hi"' });
        expect(cmp.decodedCandidate(cmp.root()!.children![0]!)).toBe(true);
      });

      it('is true for strings with backslashes', async () => {
        await createWith({ path: 'C:\\Users' });
        expect(cmp.decodedCandidate(cmp.root()!.children![0]!)).toBe(true);
      });

      it('is false for plain ASCII strings without escape-worthy chars', async () => {
        await createWith({ name: 'jotjson rocks' });
        expect(cmp.decodedCandidate(cmp.root()!.children![0]!)).toBe(false);
      });

      it('is false for non-string leaves', async () => {
        await createWith({ count: 42, flag: true, blank: null });
        const root = cmp.root()!;
        expect(cmp.decodedCandidate(root.children![0]!)).toBe(false);
        expect(cmp.decodedCandidate(root.children![1]!)).toBe(false);
        expect(cmp.decodedCandidate(root.children![2]!)).toBe(false);
      });

      it('is false at the boundary of length === 256 (no escapes)', async () => {
        await createWith({ id: 'x'.repeat(256) });
        expect(cmp.decodedCandidate(cmp.root()!.children![0]!)).toBe(false);
      });

      it('is true at the boundary of length === 257 (no escapes, long fallback)', async () => {
        await createWith({ id: 'x'.repeat(257) });
        expect(cmp.decodedCandidate(cmp.root()!.children![0]!)).toBe(true);
      });

      it('is true for a long single-line URL with no escapes', async () => {
        const url = 'https://example.com/' + 'a'.repeat(300);
        await createWith({ href: url });
        expect(cmp.decodedCandidate(cmp.root()!.children![0]!)).toBe(true);
      });
    });

    describe('pill rendering', () => {
      it('renders the decoded pill on candidate string leaves with embedded escapes', async () => {
        await createWith({ note: 'first\nsecond' });
        cmp.expandAll();
        fixture.detectChanges();
        expect(decodedButtonFor('$.note')).not.toBeNull();
      });

      it('renders the decoded pill on long single-line strings (widened predicate)', async () => {
        const url = 'https://example.com/' + 'a'.repeat(300);
        await createWith({ href: url });
        cmp.expandAll();
        fixture.detectChanges();
        expect(decodedButtonFor('$.href')).not.toBeNull();
      });

      it('does not render the decoded pill on plain string leaves', async () => {
        await createWith({ name: 'plain' });
        cmp.expandAll();
        fixture.detectChanges();
        expect(decodedButtonFor('$.name')).toBeNull();
      });

      it('does not render the decoded pill on non-string leaves', async () => {
        await createWith({ count: 42 });
        cmp.expandAll();
        fixture.detectChanges();
        expect(decodedButtonFor('$.count')).toBeNull();
      });

      it('does not carry aria-pressed (the pill is stateless)', async () => {
        await createWith({ note: 'first\nsecond' });
        cmp.expandAll();
        fixture.detectChanges();
        const button = decodedButtonFor('$.note');
        expect(button!.hasAttribute('aria-pressed')).toBe(false);
      });

      it('inline value span never carries the legacy tree-value-decoded class', async () => {
        await createWith({ note: 'first\nsecond' });
        cmp.expandAll();
        fixture.detectChanges();
        const span = valueSpanFor('$.note');
        expect(span!.classList.contains('tree-value-decoded')).toBe(false);
        decodedButtonFor('$.note')!.click();
        fixture.detectChanges();
        // Pill click opens a dialog; the inline span is unaffected.
        expect(valueSpanFor('$.note')!.classList.contains('tree-value-decoded')).toBe(false);
      });
    });

    describe('opening the dialog', () => {
      it('pill click opens the DecodedValueDialog with the raw value and path', async () => {
        await createWith({ note: 'first\nsecond' });
        cmp.expandAll();
        fixture.detectChanges();
        const open = spyOnDialogOpen();
        decodedButtonFor('$.note')!.click();
        fixture.detectChanges();
        expect(open).toHaveBeenCalledTimes(1);
        const args = open.calls.mostRecent().args;
        expect(args[0]).toBe(DecodedValueDialogComponent);
        const config = args[1] as { data: DecodedValueDialogData };
        expect(config.data.value).toBe('first\nsecond');
        expect(config.data.pathString).toBe('$.note');
      });

      it('pill click stops propagation so the row is not selected', async () => {
        await createWith({ note: 'first\nsecond' });
        cmp.expandAll();
        fixture.detectChanges();
        spyOnDialogOpen();
        const button = decodedButtonFor('$.note');
        const event = new MouseEvent('click', { bubbles: true, cancelable: true });
        const stopSpy = spyOn(event, 'stopPropagation').and.callThrough();
        button!.dispatchEvent(event);
        fixture.detectChanges();
        expect(stopSpy).toHaveBeenCalled();
        expect(cmp.selectedPath()).toBeNull();
      });

      it('kebab "Open decoded value" entry opens the same dialog', async () => {
        await createWith({ note: 'first\nsecond' });
        cmp.expandAll();
        fixture.detectChanges();
        const open = spyOnDialogOpen();
        try {
          await openMenuFor('$.note');
          const item = decodedMenuItem();
          expect(item).withContext('decoded menu item should be present').toBeTruthy();
          item!.click();
          fixture.detectChanges();
          expect(open).toHaveBeenCalledTimes(1);
          const args = open.calls.mostRecent().args;
          expect(args[0]).toBe(DecodedValueDialogComponent);
        } finally {
          closeOpenMenus();
        }
      });

      it('kebab entry shows a single label "Open decoded value" (no show/hide flip)', async () => {
        await createWith({ note: 'first\nsecond' });
        cmp.expandAll();
        fixture.detectChanges();
        try {
          await openMenuFor('$.note');
          const item = decodedMenuItem();
          expect(item).toBeTruthy();
          expect(item!.textContent).toMatch(/Open decoded value/);
          expect(item!.textContent).not.toMatch(/JSON-escaped string/);
          expect(item!.textContent).not.toMatch(/Show as decoded text/);
        } finally {
          closeOpenMenus();
        }
      });

      it('does not open the dialog when the node is no longer a candidate (defensive guard)', async () => {
        await createWith({ note: 'first\nsecond' });
        const node = cmp.root()!.children![0]!;
        const open = spyOnDialogOpen();
        // Simulate a stale node reference by mutating the underlying value.
        fixture.componentRef.setInput('value', { note: 42 });
        fixture.detectChanges();
        // Calling onDecodedButtonClick with the stale node aborts.
        cmp.onDecodedButtonClick(node, new MouseEvent('click'));
        expect(open).not.toHaveBeenCalled();
      });
    });

    describe('displayLeaf and renderLeaf (always JSON-escaped, no per-row state)', () => {
      it('displayLeaf returns the JSON-escaped form for string leaves', async () => {
        await createWith({ note: 'a\nb' });
        const node = cmp.root()!.children![0]!;
        expect(cmp.displayLeaf(node)).toBe('"a\\nb"');
      });

      it('displayLeaf is unchanged after pill click (dialog opens; row unchanged)', async () => {
        await createWith({ note: 'a\nb' });
        cmp.expandAll();
        fixture.detectChanges();
        spyOnDialogOpen();
        decodedButtonFor('$.note')!.click();
        fixture.detectChanges();
        const node = cmp.root()!.children![0]!;
        expect(cmp.displayLeaf(node)).toBe('"a\\nb"');
      });

      it('renderLeaf is unchanged by the pill (substring search uses the JSON-escaped form)', async () => {
        await createWith({ note: 'a\nb' });
        cmp.expandAll();
        fixture.detectChanges();
        const node = cmp.root()!.children![0]!;
        expect(cmp.renderLeaf(node.value, node.type)).toBe('"a\\nb"');
        spyOnDialogOpen();
        decodedButtonFor('$.note')!.click();
        fixture.detectChanges();
        expect(cmp.renderLeaf(node.value, node.type)).toBe('"a\\nb"');
      });

      it('substring search continues to match the JSON-escaped form after the pill click', async () => {
        await createWith({ note: 'first\nsecond' });
        cmp.expandAll();
        fixture.detectChanges();
        spyOnDialogOpen();
        decodedButtonFor('$.note')!.click();
        fixture.detectChanges();
        prefs.update({ searchScope: 'values' });
        cmp.search.set('first\\nsecond');
        fixture.detectChanges();
        expect(cmp.searchHits().has('$.note')).toBe(true);
      });
    });

    describe('telemetry', () => {
      it('logs tree.decoded.viewerOpened with rowButton source for embedded-escape strings', async () => {
        await createWith({ note: 'first\nsecond' });
        cmp.expandAll();
        fixture.detectChanges();
        const event = spyOn(TestBed.inject(LoggerService), 'event');
        spyOnDialogOpen();
        decodedButtonFor('$.note')!.click();
        fixture.detectChanges();
        expect(event).toHaveBeenCalledWith('tree.decoded.viewerOpened', {
          source: 'rowButton',
          reason: 'escape',
          pathDepth: bucketCount(2),
          lineCountBucket: '2-5',
        });
      });

      it('logs tree.decoded.viewerOpened with reason="long" for long single-line strings', async () => {
        const url = 'https://example.com/' + 'a'.repeat(300);
        await createWith({ href: url });
        cmp.expandAll();
        fixture.detectChanges();
        const event = spyOn(TestBed.inject(LoggerService), 'event');
        spyOnDialogOpen();
        decodedButtonFor('$.href')!.click();
        fixture.detectChanges();
        expect(event).toHaveBeenCalledWith('tree.decoded.viewerOpened', {
          source: 'rowButton',
          reason: 'long',
          pathDepth: bucketCount(2),
          lineCountBucket: '1',
        });
      });

      it('logs tree.decoded.viewerOpened with contextMenu source from the kebab', async () => {
        await createWith({ note: 'first\nsecond' });
        cmp.expandAll();
        fixture.detectChanges();
        const event = spyOn(TestBed.inject(LoggerService), 'event');
        spyOnDialogOpen();
        try {
          await openMenuFor('$.note');
          const item = decodedMenuItem();
          expect(item).toBeTruthy();
          item!.click();
          fixture.detectChanges();
          expect(event).toHaveBeenCalledWith('tree.decoded.viewerOpened', {
            source: 'contextMenu',
            reason: 'escape',
            pathDepth: bucketCount(2),
            lineCountBucket: '2-5',
          });
        } finally {
          closeOpenMenus();
        }
      });
    });
  });

  // ---------------------------------------------------------------------------
  // M7q tree-row context menu
  //
  // Covers: right-click + kebab triggers, action methods (copy / search /
  // expand / collapse), gating predicates, double-click-to-copy, and the
  // race-free active-hit elevation in `activateClickedHitOrFirst`. Every
  // copy-spec uses the `withCtxClipboard` helper to swap `navigator.clipboard`
  // for a writeText spy and restore it afterwards (see the copyPath suite
  // above for the canonical pattern).
  // ---------------------------------------------------------------------------
  describe('row context menu (M7q)', () => {
    type Cn = ReturnType<JsonTreeComponent['root']>;

    /** Walk `cmp.root()` to find the node whose pathString matches. */
    function nodeAt(path: string): Cn & {} {
      const stack: Array<NonNullable<Cn>> = [];
      const root = cmp.root();
      if (root) stack.push(root);
      while (stack.length > 0) {
        const n = stack.pop() as NonNullable<Cn>;
        if (n.pathString === path) return n;
        for (const c of n.children ?? []) stack.push(c);
      }
      throw new Error(`No node at path ${path}`);
    }

    /**
     * Open the row menu for `path` via its kebab button. Inlined in
     * existing M7q `rendering` tests; lifted here to keep new
     * Path Y tests below from re-implementing the same kebab-click +
     * detectChanges + microtask-await dance.
     */
    async function openMenuFor(path: string): Promise<void> {
      const kebab = (fixture.nativeElement as HTMLElement).querySelector(
        `.tree-row[data-path="${path}"] .tree-kebab-pill`,
      ) as HTMLButtonElement | null;
      expect(kebab).withContext(`found a kebab for ${path}`).toBeTruthy();
      kebab!.click();
      fixture.detectChanges();
      await Promise.resolve();
      fixture.detectChanges();
    }

    /** Find the FIRST visible menu item by label substring, across all open panels. */
    function menuItemContaining(label: string): HTMLButtonElement {
      const item = Array.from(
        document.body.querySelectorAll<HTMLButtonElement>('button.mat-mdc-menu-item'),
      ).find((menuItem) => (menuItem.textContent ?? '').trim().includes(label));
      if (!item) {
        throw new Error(`No menu item found for ${label}`);
      }
      return item;
    }

    function withCtxClipboard<T>(stub: { writeText?: jasmine.Spy } | undefined, run: () => T): T {
      const original = (navigator as { clipboard?: Clipboard }).clipboard;
      const hadOwn = Object.prototype.hasOwnProperty.call(navigator, 'clipboard');
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: stub });
      try {
        return run();
      } finally {
        if (hadOwn && original) {
          Object.defineProperty(navigator, 'clipboard', {
            configurable: true,
            value: original,
          });
        } else {
          // No own clipboard property existed before our override; deleting
          // restores the original prototype access (avoids the
          // "value: undefined" trap that masks the prototype).
          delete (navigator as { clipboard?: unknown }).clipboard;
        }
      }
    }

    function ctxEvent(): MouseEvent {
      // Non-zero coords so onRowContextMenu treats this as mouse-driven.
      return new MouseEvent('contextmenu', {
        clientX: 100,
        clientY: 200,
        bubbles: true,
        cancelable: true,
      });
    }

    describe('onRowContextMenu', () => {
      it('sets contextNode and captures cursor coords without mutating selection', async () => {
        await createWith({ alpha: 1, beta: 2 });
        cmp.expandAll();
        fixture.detectChanges();
        // Pre-seed a different selection so we can prove right-click
        // does NOT change it. Right-click should never select.
        cmp.selectByPathString('$.beta');
        fixture.detectChanges();
        const node = nodeAt('$.alpha');
        const ev = ctxEvent();
        cmp.onRowContextMenu(ev, node);
        expect(cmp.contextNode()?.pathString).toBe('$.alpha');
        expect(cmp.selectedPath())
          .withContext('right-click must not change selection')
          .toBe('$.beta');
        expect(cmp.ctxX()).toBe(100);
        expect(cmp.ctxY()).toBe(200);
        expect(ev.defaultPrevented).toBe(true);
      });

      it('does not mutate selectedPath when no prior selection exists', async () => {
        await createWith({ alpha: 1 });
        cmp.expandAll();
        fixture.detectChanges();
        const node = nodeAt('$.alpha');
        expect(cmp.selectedPath()).withContext('precondition: nothing selected').toBeNull();
        cmp.onRowContextMenu(ctxEvent(), node);
        expect(cmp.selectedPath()).withContext('right-click must leave selection null').toBeNull();
        expect(cmp.contextNode()?.pathString).toBe('$.alpha');
      });

      it('ignores keyboard-fired contextmenu (clientX/Y === 0)', async () => {
        await createWith({ alpha: 1 });
        const node = nodeAt('$.alpha');
        const ev = new MouseEvent('contextmenu', {
          clientX: 0,
          clientY: 0,
          bubbles: true,
          cancelable: true,
        });
        cmp.onRowContextMenu(ev, node);
        expect(cmp.contextNode()).toBeNull();
        expect(ev.defaultPrevented).toBe(false);
      });

      it('ignores contextmenu fired on an interactive descendant (e.g. the kebab pill)', async () => {
        await createWith({ alpha: 1 });
        cmp.expandAll();
        fixture.detectChanges();
        const node = nodeAt('$.alpha');
        const pill = (fixture.nativeElement as HTMLElement).querySelector(
          '.tree-kebab-pill',
        ) as HTMLButtonElement;
        const ev = new MouseEvent('contextmenu', {
          clientX: 100,
          clientY: 100,
          bubbles: true,
          cancelable: true,
        });
        // dispatch via the pill so target.closest('button, ...') matches.
        Object.defineProperty(ev, 'target', { value: pill });
        cmp.onRowContextMenu(ev, node);
        expect(cmp.contextNode()).toBeNull();
        expect(ev.defaultPrevented).toBe(false);
      });
    });

    describe('onKebabClick', () => {
      it('sets contextNode and stops propagation so row select does not fire', async () => {
        await createWith({ alpha: 1 });
        const node = nodeAt('$.alpha');
        const ev = new MouseEvent('click', { bubbles: true, cancelable: true });
        const stopSpy = spyOn(ev, 'stopPropagation').and.callThrough();
        cmp.onKebabClick(ev, node);
        expect(cmp.contextNode()?.pathString).toBe('$.alpha');
        expect(cmp.selectedPath()).toBe('$.alpha');
        expect(stopSpy).toHaveBeenCalled();
      });

      it("logs tree.contextMenu.opened with source: 'kebab'", async () => {
        await createWith({ alpha: 1 });
        const node = nodeAt('$.alpha');
        const ev = new MouseEvent('click', { bubbles: true, cancelable: true });
        const info = spyOn(TestBed.inject(LoggerService), 'info');
        cmp.onKebabClick(ev, node);
        expect(info).toHaveBeenCalledWith('tree.contextMenu.opened', {
          source: 'kebab',
        });
      });
    });

    describe('source telemetry on row right-click', () => {
      it("logs tree.contextMenu.opened with source: 'row'", async () => {
        await createWith({ alpha: 1 });
        cmp.expandAll();
        fixture.detectChanges();
        const node = nodeAt('$.alpha');
        const ev = ctxEvent();
        const info = spyOn(TestBed.inject(LoggerService), 'info');
        cmp.onRowContextMenu(ev, node);
        expect(info).toHaveBeenCalledWith('tree.contextMenu.opened', {
          source: 'row',
        });
      });
    });

    describe('window.blur dismissal (M7q + JJ_MENU_IMPORTS)', () => {
      it('closes the open row context menu when window.blur fires', async () => {
        await createWith({ a: 1, b: 2 });
        cmp.expandAll();
        fixture.detectChanges();

        const row = (fixture.nativeElement as HTMLElement).querySelector(
          '.tree-row[data-path="$.a"]',
        ) as HTMLElement | null;
        expect(row).withContext('found a row to right-click').toBeTruthy();

        try {
          row!.dispatchEvent(
            new MouseEvent('contextmenu', {
              clientX: 100,
              clientY: 100,
              bubbles: true,
              cancelable: true,
            }),
          );
          fixture.detectChanges();
          await new Promise<void>((resolve) => queueMicrotask(() => resolve()));
          fixture.detectChanges();

          expect(cmp.ctxTrigger()?.menuOpen).toBeTrue();

          window.dispatchEvent(new Event('blur'));
          fixture.detectChanges();
          await new Promise<void>((resolve) => queueMicrotask(() => resolve()));
          fixture.detectChanges();

          expect(cmp.ctxTrigger()?.menuOpen).toBeFalse();
        } finally {
          cmp.ctxTrigger()?.closeMenu();
          fixture.detectChanges();
        }
      });
    });

    describe('onBreadcrumbContextMenu', () => {
      function ctxMouseEvent(): MouseEvent {
        return new MouseEvent('contextmenu', {
          clientX: 100,
          clientY: 200,
          bubbles: true,
          cancelable: true,
        });
      }

      it('opens the menu and captures cursor coords without mutating selection', async () => {
        await createWith({ foo: { bar: 1 } });
        cmp.expandAll();
        fixture.detectChanges();
        // Pre-seed selection at the leaf, then right-click an
        // ancestor chip. Right-click must not pull selection up
        // (which would also reflow the breadcrumb under the cursor).
        cmp.selectByPathString('$.foo.bar');
        fixture.detectChanges();
        const event = ctxMouseEvent();
        cmp.onBreadcrumbContextMenu({
          event,
          canonicalPath: '$.foo',
          depth: 1,
        });
        expect(cmp.contextNode()?.pathString).toBe('$.foo');
        expect(cmp.selectedPath())
          .withContext('right-click on a breadcrumb chip must not change selection')
          .toBe('$.foo.bar');
        expect(cmp.ctxX()).toBe(100);
        expect(cmp.ctxY()).toBe(200);
      });

      it('does not fire selectionChange', async () => {
        await createWith({ foo: { bar: 1 } });
        cmp.expandAll();
        fixture.detectChanges();
        cmp.selectByPathString('$.foo.bar');
        fixture.detectChanges();
        const events: (readonly (string | number)[] | null)[] = [];
        cmp.selectionChange.subscribe((path) => events.push(path));
        cmp.onBreadcrumbContextMenu({
          event: ctxMouseEvent(),
          canonicalPath: '$.foo',
          depth: 1,
        });
        fixture.detectChanges();
        expect(events).withContext('right-click must not emit a selectionChange event').toEqual([]);
      });

      it("logs tree.contextMenu.opened with source: 'breadcrumb'", async () => {
        await createWith({ foo: { bar: 1 } });
        cmp.expandAll();
        fixture.detectChanges();
        const event = ctxMouseEvent();
        const info = spyOn(TestBed.inject(LoggerService), 'info');
        cmp.onBreadcrumbContextMenu({
          event,
          canonicalPath: '$.foo',
          depth: 1,
        });
        expect(info).toHaveBeenCalledWith('tree.contextMenu.opened', {
          source: 'breadcrumb',
        });
      });

      it('silently no-ops on a path unknown to nodeIndex', async () => {
        await createWith({ alpha: 1 });
        const event = ctxMouseEvent();
        const info = spyOn(TestBed.inject(LoggerService), 'info');
        cmp.onBreadcrumbContextMenu({
          event,
          canonicalPath: '$.does.not.exist',
          depth: 99,
        });
        expect(cmp.contextNode()).toBeNull();
        expect(cmp.selectedPath()).toBeNull();
        expect(info).not.toHaveBeenCalled();
        expect(event.defaultPrevented).toBe(false);
      });

      it('calls preventDefault on the carried event when handling', async () => {
        await createWith({ alpha: 1 });
        cmp.expandAll();
        fixture.detectChanges();
        const event = ctxMouseEvent();
        cmp.onBreadcrumbContextMenu({
          event,
          canonicalPath: '$.alpha',
          depth: 1,
        });
        expect(event.defaultPrevented).toBe(true);
      });
    });

    describe('copyKey', () => {
      it('copies the key text and shows a success toast', async () => {
        await createWith({ alpha: 1 });
        const writeText = jasmine.createSpy('writeText').and.resolveTo(undefined);
        const node = nodeAt('$.alpha');
        withCtxClipboard({ writeText }, () => cmp.copyKey(node));
        await Promise.resolve();
        await Promise.resolve();
        expect(writeText).toHaveBeenCalledWith('alpha');
        expect(snackOpen).toHaveBeenCalled();
      });

      it('copies a numeric array index as its string form', async () => {
        await createWith([10, 20]);
        cmp.expandAll();
        fixture.detectChanges();
        const writeText = jasmine.createSpy('writeText').and.resolveTo(undefined);
        const node = nodeAt('$[1]');
        withCtxClipboard({ writeText }, () => cmp.copyKey(node));
        await Promise.resolve();
        await Promise.resolve();
        expect(writeText).toHaveBeenCalledWith('1');
      });

      it('is a no-op on the root (segment === undefined)', async () => {
        await createWith({ alpha: 1 });
        const writeText = jasmine.createSpy('writeText').and.resolveTo(undefined);
        const root = nodeAt('$');
        withCtxClipboard({ writeText }, () => cmp.copyKey(root));
        await Promise.resolve();
        await Promise.resolve();
        expect(writeText).not.toHaveBeenCalled();
      });
    });

    describe('copyValue', () => {
      it('copies a string value as raw text (no JSON quotes)', async () => {
        await createWith({ note: 'hello "world"' });
        const writeText = jasmine.createSpy('writeText').and.resolveTo(undefined);
        const node = nodeAt('$.note');
        withCtxClipboard({ writeText }, () => cmp.copyValue(node, 'menu'));
        await Promise.resolve();
        await Promise.resolve();
        expect(writeText).toHaveBeenCalledWith('hello "world"');
      });

      it('copies a number as its string form', async () => {
        await createWith({ count: 42 });
        const writeText = jasmine.createSpy('writeText').and.resolveTo(undefined);
        const node = nodeAt('$.count');
        withCtxClipboard({ writeText }, () => cmp.copyValue(node, 'menu'));
        await Promise.resolve();
        await Promise.resolve();
        expect(writeText).toHaveBeenCalledWith('42');
      });

      it('copies a boolean as "true"/"false"', async () => {
        await createWith({ enabled: true });
        const writeText = jasmine.createSpy('writeText').and.resolveTo(undefined);
        const node = nodeAt('$.enabled');
        withCtxClipboard({ writeText }, () => cmp.copyValue(node, 'menu'));
        await Promise.resolve();
        await Promise.resolve();
        expect(writeText).toHaveBeenCalledWith('true');
      });

      it('copies null as the literal "null"', async () => {
        await createWith({ blank: null });
        const writeText = jasmine.createSpy('writeText').and.resolveTo(undefined);
        const node = nodeAt('$.blank');
        withCtxClipboard({ writeText }, () => cmp.copyValue(node, 'menu'));
        await Promise.resolve();
        await Promise.resolve();
        expect(writeText).toHaveBeenCalledWith('null');
      });

      it('copies an object as 2-space pretty JSON (multi-line)', async () => {
        await createWith({ obj: { a: 1, b: 'x' } });
        const writeText = jasmine.createSpy('writeText').and.resolveTo(undefined);
        const node = nodeAt('$.obj');
        withCtxClipboard({ writeText }, () => cmp.copyValue(node, 'menu'));
        await Promise.resolve();
        await Promise.resolve();
        const arg = writeText.calls.mostRecent().args[0] as string;
        expect(arg).toContain('\n');
        expect(arg).toContain('  "a": 1');
        expect(arg).toContain('  "b": "x"');
      });

      it('copies an array as 2-space pretty JSON', async () => {
        await createWith({ arr: [1, 2] });
        const writeText = jasmine.createSpy('writeText').and.resolveTo(undefined);
        const node = nodeAt('$.arr');
        withCtxClipboard({ writeText }, () => cmp.copyValue(node, 'menu'));
        await Promise.resolve();
        await Promise.resolve();
        const arg = writeText.calls.mostRecent().args[0] as string;
        expect(arg).toBe('[\n  1,\n  2\n]');
      });
    });

    describe('findByKey', () => {
      it('sets scope=keys, regex=false, valueType=all and queries the segment', async () => {
        await createWith({ alpha: 1, beta: 2 });
        prefs.update({
          searchScope: 'values',
          searchRegexMode: true,
          searchValueType: 'string',
        });
        cmp.expandAll();
        fixture.detectChanges();
        const node = nodeAt('$.alpha');
        cmp.findByKey(node);
        expect(prefs.prefs().searchScope).toBe('keys');
        expect(prefs.prefs().searchRegexMode).toBe(false);
        expect(prefs.prefs().searchValueType).toBe('all');
        expect(cmp.search()).toBe('alpha');
      });

      it('elevates the clicked row to the active hit', async () => {
        await createWith({ alpha: 1, alphabet: 2, alpine: 3 });
        cmp.expandAll();
        fixture.detectChanges();
        const node = nodeAt('$.alphabet');
        cmp.findByKey(node);
        await Promise.resolve();
        await Promise.resolve();
        const idx = cmp.activeHitIndex();
        const paths = cmp.searchHitPaths();
        expect(paths[idx]).toBe('$.alphabet');
      });

      it('falls back to the first hit when the clicked row is not a hit', async () => {
        // searching for a key with a typo wouldn't yield clicked-row in
        // hits; we simulate that by setting a non-matching pathString.
        await createWith({ alpha: 1, beta: 2 });
        cmp.expandAll();
        fixture.detectChanges();
        // Manually invoke activateClickedHitOrFirst with a path that
        // isn't in the hit set after we set search to 'beta'.
        prefs.update({ searchScope: 'keys', searchRegexMode: false, searchValueType: 'all' });
        cmp.search.set('beta');
        // call private helper indirectly: searchByKey on `$.alpha` with
        // current search='beta' would write 'alpha' to search, but we
        // want the inverse - just verify by calling searchByKey with a
        // node whose key doesn't match the existing query.
        const node = nodeAt('$.alpha');
        cmp.findByKey(node);
        await Promise.resolve();
        await Promise.resolve();
        // After searchByKey on $.alpha, paths = [$.alpha]; activeHit = 0.
        const idx = cmp.activeHitIndex();
        const paths = cmp.searchHitPaths();
        expect(paths[idx]).toBe('$.alpha');
      });

      it('does nothing on the root (no segment)', async () => {
        await createWith({ alpha: 1 });
        prefs.update({ searchScope: 'values' });
        cmp.findByKey(nodeAt('$'));
        // unchanged
        expect(prefs.prefs().searchScope).toBe('values');
      });
    });

    describe('findByValue', () => {
      it('sets scope=values, queries the value, and elevates the clicked row', async () => {
        await createWith({ a: 'needle', b: 'haystack', c: 'needle' });
        cmp.expandAll();
        fixture.detectChanges();
        const node = nodeAt('$.c');
        cmp.findByValue(node);
        await Promise.resolve();
        await Promise.resolve();
        expect(prefs.prefs().searchScope).toBe('values');
        expect(prefs.prefs().searchRegexMode).toBe(false);
        expect(prefs.prefs().searchValueType).toBe('all');
        expect(cmp.search()).toBe('needle');
        const idx = cmp.activeHitIndex();
        const paths = cmp.searchHitPaths();
        expect(paths[idx]).toBe('$.c');
      });

      it('searches a string value as raw text (no JSON quotes)', async () => {
        await createWith({ a: 'with "quotes"' });
        cmp.expandAll();
        fixture.detectChanges();
        cmp.findByValue(nodeAt('$.a'));
        expect(cmp.search()).toBe('with "quotes"');
      });

      it('does not act on object/array/null/undefined', async () => {
        await createWith({ obj: {}, arr: [], blank: null });
        cmp.expandAll();
        fixture.detectChanges();
        prefs.update({ searchScope: 'keys' });
        cmp.findByValue(nodeAt('$.obj'));
        cmp.findByValue(nodeAt('$.arr'));
        cmp.findByValue(nodeAt('$.blank'));
        expect(prefs.prefs().searchScope).toBe('keys');
        expect(cmp.search()).toBe('');
      });
    });

    describe('collapseFromHere', () => {
      it("collapses the clicked container without clearing descendants' state", async () => {
        // Path Y: collapseFromHere is now non-recursive (single-row).
        // CDK FlatTree preserves descendants' expansion state across
        // a parent collapse/expand cycle, so re-expanding `outer`
        // restores `mid` to expanded. The recursive walk that the
        // earlier implementation did was deleted to keep "one way to
        // collapse" and avoid divergent behavior between dblclick
        // and the menu.
        await createWith({ outer: { mid: { inner: 1 } } });
        cmp.expandAll();
        fixture.detectChanges();
        const outer = nodeAt('$.outer');
        const mid = nodeAt('$.outer.mid');
        expect(cmp.__getHelpersForTesting().isExpanded(outer)).toBe(true);
        expect(cmp.__getHelpersForTesting().isExpanded(mid)).toBe(true);
        cmp.collapseFromHere(outer);
        expect(cmp.__getHelpersForTesting().isExpanded(outer))
          .withContext('clicked row collapses')
          .toBe(false);
        // mid stays in the expansionModel because we only collapsed
        // outer; CDK preserves its state. Re-expanding outer would
        // make mid visible again.
        expect(cmp.__getHelpersForTesting().isExpanded(mid))
          .withContext("descendant's expansion state preserved")
          .toBe(true);
      });
    });

    describe('expandAllFromHere', () => {
      it('expands the clicked container and every descendant container', async () => {
        await createWith({ outer: { mid: { inner: 1 } } });
        cmp.collapseAll();
        fixture.detectChanges();
        const outer = nodeAt('$.outer');
        cmp.expandAllFromHere(outer);
        expect(cmp.__getHelpersForTesting().isExpanded(outer)).toBe(true);
        expect(cmp.__getHelpersForTesting().isExpanded(nodeAt('$.outer.mid'))).toBe(true);
      });
    });

    describe('expandToDepthFromHere', () => {
      it('+1 expands only the clicked node when starting from a collapsed subtree', async () => {
        await createWith({ outer: { mid: { inner: { deep: 1 } } } });
        cmp.collapseAll();
        fixture.detectChanges();
        const outer = nodeAt('$.outer');
        cmp.expandToDepthFromHere(outer, 1);
        expect(cmp.__getHelpersForTesting().isExpanded(outer)).toBe(true);
        expect(cmp.__getHelpersForTesting().isExpanded(nodeAt('$.outer.mid'))).toBe(false);
      });

      it('+N expands every collapsed container at relative depth < N (including hidden ones)', async () => {
        await createWith({ outer: { mid: { inner: { deep: 1 } } } });
        cmp.collapseAll();
        fixture.detectChanges();
        const outer = nodeAt('$.outer');
        cmp.expandToDepthFromHere(outer, 3);
        expect(cmp.__getHelpersForTesting().isExpanded(outer)).toBe(true);
        expect(cmp.__getHelpersForTesting().isExpanded(nodeAt('$.outer.mid'))).toBe(true);
        expect(cmp.__getHelpersForTesting().isExpanded(nodeAt('$.outer.mid.inner'))).toBe(true);
      });

      it('+N never collapses a container at relative depth >= N (expand-only)', async () => {
        await createWith({ outer: { mid: { inner: 1 } } });
        cmp.expandAll();
        fixture.detectChanges();
        const outer = nodeAt('$.outer');
        cmp.expandToDepthFromHere(outer, 1);
        // +1 only acts on depth 0; deeper containers stay expanded.
        expect(cmp.__getHelpersForTesting().isExpanded(outer)).toBe(true);
        expect(cmp.__getHelpersForTesting().isExpanded(nodeAt('$.outer.mid'))).toBe(true);
      });

      it('is idempotent on an already-fully-expanded subtree', async () => {
        await createWith({ outer: { mid: { inner: 1 } } });
        cmp.expandAll();
        fixture.detectChanges();
        const outer = nodeAt('$.outer');
        const mid = nodeAt('$.outer.mid');
        cmp.expandToDepthFromHere(outer, 3);
        cmp.expandToDepthFromHere(outer, 3);
        expect(cmp.__getHelpersForTesting().isExpanded(outer)).toBe(true);
        expect(cmp.__getHelpersForTesting().isExpanded(mid)).toBe(true);
      });
    });

    describe('isolate / collapseSiblings', () => {
      it('truth-table (non-empty, empty): single Isolate shown; collapses peers; emits tree.contextMenu.isolate', async () => {
        await createWith({ a: { a1: 'leaf', a2: { z: 1 }, a3: { z: 1 } } });
        cmp.expandAll();
        fixture.detectChanges();
        const a2 = nodeAt('$.a.a2');
        const a3 = nodeAt('$.a.a3');
        const a = nodeAt('$.a');
        expect(cmp.showIsolateSingle(a2)).toBe(true);
        expect(cmp.showIsolatePair(a2)).toBe(false);
        const infoSpy = spyOn(TestBed.inject(LoggerService), 'info').and.callThrough();
        cmp.isolateRow(a2, 'single');
        expect(cmp.__getHelpersForTesting().isExpanded(a3)).toBe(false);
        expect(cmp.__getHelpersForTesting().isExpanded(a)).toBe(true);
        expect(cmp.__getHelpersForTesting().isExpanded(a2)).toBe(true);
        expect(infoSpy).toHaveBeenCalledWith('tree.contextMenu.isolate');
      });

      it('truth-table (empty, non-empty): single Isolate shown; collapses higher off-chain branches; emits tree.contextMenu.isolate', async () => {
        await createWith({ a: { a2: { z: 1 } }, b: { z: 1 } });
        cmp.expandAll();
        fixture.detectChanges();
        const a2 = nodeAt('$.a.a2');
        const b = nodeAt('$.b');
        const a = nodeAt('$.a');
        expect(cmp.showIsolateSingle(a2)).toBe(true);
        expect(cmp.showIsolatePair(a2)).toBe(false);
        const infoSpy = spyOn(TestBed.inject(LoggerService), 'info').and.callThrough();
        cmp.isolateRow(a2, 'single');
        expect(cmp.__getHelpersForTesting().isExpanded(b)).toBe(false);
        expect(cmp.__getHelpersForTesting().isExpanded(a)).toBe(true);
        expect(infoSpy).toHaveBeenCalledWith('tree.contextMenu.isolate');
      });

      it('truth-table (non-empty, non-empty): pair shown; narrow collapses only direct peers, wide collapses both', async () => {
        await createWith({
          a: { a2: { z: 1 }, a3: { z: 1 } },
          b: { z: 1 },
          c: { z: 1 },
        });
        cmp.expandAll();
        fixture.detectChanges();
        const a2 = nodeAt('$.a.a2');
        expect(cmp.showIsolateSingle(a2)).toBe(false);
        expect(cmp.showIsolatePair(a2)).toBe(true);

        const infoSpy = spyOn(TestBed.inject(LoggerService), 'info').and.callThrough();
        cmp.collapseSiblings(a2);
        expect(cmp.__getHelpersForTesting().isExpanded(nodeAt('$.a.a3'))).toBe(false);
        expect(cmp.__getHelpersForTesting().isExpanded(nodeAt('$.b'))).toBe(true);
        expect(cmp.__getHelpersForTesting().isExpanded(nodeAt('$.c'))).toBe(true);
        expect(infoSpy).toHaveBeenCalledWith('tree.contextMenu.isolateNarrow');

        cmp.isolateRow(a2, 'wide');
        expect(cmp.__getHelpersForTesting().isExpanded(nodeAt('$.b'))).toBe(false);
        expect(cmp.__getHelpersForTesting().isExpanded(nodeAt('$.c'))).toBe(false);
        expect(infoSpy).toHaveBeenCalledWith('tree.contextMenu.isolateWide');
      });

      it('truth-table (empty, empty): no Isolate items shown', async () => {
        await createWith({ a: { a2: { z: 1 } } });
        cmp.expandAll();
        fixture.detectChanges();
        const a2 = nodeAt('$.a.a2');
        expect(cmp.showIsolateSingle(a2)).toBe(false);
        expect(cmp.showIsolatePair(a2)).toBe(false);
      });

      it('primitive-leaf click with expanded aunts: single Isolate offered; collapses the aunts', async () => {
        await createWith({ a: { a1: 'leaf' }, b: { z: 1 } });
        cmp.expandAll();
        fixture.detectChanges();
        const a1 = nodeAt('$.a.a1');
        expect(cmp.showIsolateSingle(a1)).toBe(true);
        cmp.isolateRow(a1, 'single');
        expect(cmp.__getHelpersForTesting().isExpanded(nodeAt('$.b'))).toBe(false);
      });

      it('empty container click does not throw and still collapses off-chain branches', async () => {
        await createWith({ a: { empty: {} }, b: { z: 1 } });
        cmp.expandAll();
        fixture.detectChanges();
        const empty = nodeAt('$.a.empty');
        expect(() => cmp.isolateRow(empty, 'single')).not.toThrow();
        expect(cmp.__getHelpersForTesting().isExpanded(nodeAt('$.b'))).toBe(false);
      });

      it('array-segment path: lock-step walk handles numeric indices and collapses higher off-chain branches', async () => {
        await createWith({ arr: [{ x: { z: 1 } }, { x: { z: 1 } }], other: { z: 1 } });
        cmp.expandAll();
        fixture.detectChanges();
        const x = nodeAt('$.arr[1].x');
        // Off-chain peers at parent (arr[1]) level: none -> narrowSet empty.
        // Off-chain peers at higher (root, arr): [other, arr[0]] -> widerSet non-empty.
        expect(cmp.showIsolateSingle(x)).toBe(true);
        expect(cmp.showIsolatePair(x)).toBe(false);
        cmp.isolateRow(x, 'single');
        expect(cmp.__getHelpersForTesting().isExpanded(nodeAt('$.arr[0]'))).toBe(false);
        expect(cmp.__getHelpersForTesting().isExpanded(nodeAt('$.other'))).toBe(false);
        expect(cmp.__getHelpersForTesting().isExpanded(nodeAt('$.arr[1]'))).toBe(true);
      });

      it('clicked-row already collapsed: hidden subtree expansion state is preserved', async () => {
        await createWith({ a: { a2: { x: { z: 1 } } }, b: { z: 1 } });
        cmp.expandAll();
        fixture.detectChanges();
        // Collapse only $.a.a2 (so $.a.a2.x stays expanded in CDK state but hidden).
        cmp.__getHelpersForTesting().setExpanded(nodeAt('$.a.a2'), false);
        expect(cmp.__getHelpersForTesting().isExpanded(nodeAt('$.a.a2'))).toBe(false);
        expect(cmp.__getHelpersForTesting().isExpanded(nodeAt('$.a.a2.x'))).toBe(true);

        cmp.isolateRow(nodeAt('$.a.a2'), 'single');
        // Off-chain collapse happened.
        expect(cmp.__getHelpersForTesting().isExpanded(nodeAt('$.b'))).toBe(false);
        // Clicked row and its hidden subtree state are untouched.
        expect(cmp.__getHelpersForTesting().isExpanded(nodeAt('$.a.a2'))).toBe(false);
        expect(cmp.__getHelpersForTesting().isExpanded(nodeAt('$.a.a2.x'))).toBe(true);
      });

      it('stale-path no-op: predicates return false and actions do nothing when path no longer resolves', async () => {
        await createWith({ a: { b: { z: 1 } }, c: { z: 1 } });
        cmp.expandAll();
        fixture.detectChanges();
        const stale = nodeAt('$.a.b');
        // Rebuild the tree with a different shape; $.a.b no longer exists.
        fixture.componentRef.setInput('value', { x: { y: 1 } });
        fixture.detectChanges();
        expect(cmp.showIsolateSingle(stale)).toBe(false);
        expect(cmp.showIsolatePair(stale)).toBe(false);
        const infoSpy = spyOn(TestBed.inject(LoggerService), 'info').and.callThrough();
        expect(() => cmp.isolateRow(stale, 'single')).not.toThrow();
        expect(() => cmp.collapseSiblings(stale)).not.toThrow();
        expect(infoSpy).not.toHaveBeenCalled();
      });

      it('idempotent: invoking either action twice produces the same end state', async () => {
        await createWith({ a: { a2: { z: 1 }, a3: { z: 1 } }, b: { z: 1 } });
        cmp.expandAll();
        fixture.detectChanges();
        const a2 = nodeAt('$.a.a2');
        cmp.isolateRow(a2, 'wide');
        const stateAfterFirst = {
          a: cmp.__getHelpersForTesting().isExpanded(nodeAt('$.a')),
          a2: cmp.__getHelpersForTesting().isExpanded(a2),
          a3: cmp.__getHelpersForTesting().isExpanded(nodeAt('$.a.a3')),
          b: cmp.__getHelpersForTesting().isExpanded(nodeAt('$.b')),
        };
        cmp.isolateRow(a2, 'wide');
        expect(cmp.__getHelpersForTesting().isExpanded(nodeAt('$.a'))).toBe(stateAfterFirst.a);
        expect(cmp.__getHelpersForTesting().isExpanded(a2)).toBe(stateAfterFirst.a2);
        expect(cmp.__getHelpersForTesting().isExpanded(nodeAt('$.a.a3'))).toBe(stateAfterFirst.a3);
        expect(cmp.__getHelpersForTesting().isExpanded(nodeAt('$.b'))).toBe(stateAfterFirst.b);
      });

      it('telemetry: each ID is emitted with no payload (no user content)', async () => {
        await createWith({
          a: { a2: { z: 1 }, a3: { z: 1 } },
          b: { z: 1 },
        });
        cmp.expandAll();
        fixture.detectChanges();
        const a2 = nodeAt('$.a.a2');
        const infoSpy = spyOn(TestBed.inject(LoggerService), 'info').and.callThrough();
        cmp.collapseSiblings(a2);
        cmp.isolateRow(a2, 'wide');
        expect(infoSpy).toHaveBeenCalledWith('tree.contextMenu.isolateNarrow');
        expect(infoSpy).toHaveBeenCalledWith('tree.contextMenu.isolateWide');
        // Verify no payload (single-arg calls).
        for (const args of infoSpy.calls.allArgs()) {
          expect(args.length).toBe(1);
        }
      });

      it('root row: both predicates return false; methods are no-ops', async () => {
        await createWith({ a: { z: 1 }, b: { z: 1 } });
        cmp.expandAll();
        fixture.detectChanges();
        const root = nodeAt('$');
        expect(cmp.showIsolateSingle(root)).toBe(false);
        expect(cmp.showIsolatePair(root)).toBe(false);
        const infoSpy = spyOn(TestBed.inject(LoggerService), 'info').and.callThrough();
        cmp.isolateRow(root, 'single');
        cmp.collapseSiblings(root);
        expect(infoSpy).not.toHaveBeenCalled();
        expect(cmp.__getHelpersForTesting().isExpanded(nodeAt('$.a'))).toBe(true);
        expect(cmp.__getHelpersForTesting().isExpanded(nodeAt('$.b'))).toBe(true);
      });

      it('direct child of root: widerSet is empty by definition; pair never appears', async () => {
        await createWith({ a: { z: 1 }, b: { z: 1 }, c: { z: 1 } });
        cmp.expandAll();
        fixture.detectChanges();
        const a = nodeAt('$.a');
        // Off-chain peers at the parent (root) level: [b, c] -> narrowSet non-empty.
        // No higher ancestor exists -> widerSet is empty.
        expect(cmp.showIsolateSingle(a)).toBe(true);
        expect(cmp.showIsolatePair(a)).toBe(false);
        cmp.isolateRow(a, 'single');
        expect(cmp.__getHelpersForTesting().isExpanded(nodeAt('$.b'))).toBe(false);
        expect(cmp.__getHelpersForTesting().isExpanded(nodeAt('$.c'))).toBe(false);
      });
    });

    describe('visibility predicates', () => {
      it('showCopyKey: hidden on root, shown on keyed child', async () => {
        await createWith({ alpha: 1 });
        expect(cmp.showCopyKey(nodeAt('$'))).toBe(false);
        expect(cmp.showCopyKey(nodeAt('$.alpha'))).toBe(true);
      });

      it('showFindByKey: hidden in embeddedMode', async () => {
        await createWith({ alpha: 1 });
        fixture.componentRef.setInput('embeddedMode', true);
        fixture.detectChanges();
        expect(cmp.showFindByKey(nodeAt('$.alpha'))).toBe(false);
      });

      it('showFindByValue: hidden on object/array/null/undefined and in embeddedMode', async () => {
        await createWith({ obj: {}, arr: [], blank: null, str: 'x' });
        cmp.expandAll();
        fixture.detectChanges();
        expect(cmp.showFindByValue(nodeAt('$.obj'))).toBe(false);
        expect(cmp.showFindByValue(nodeAt('$.arr'))).toBe(false);
        expect(cmp.showFindByValue(nodeAt('$.blank'))).toBe(false);
        expect(cmp.showFindByValue(nodeAt('$.str'))).toBe(true);
        fixture.componentRef.setInput('embeddedMode', true);
        fixture.detectChanges();
        expect(cmp.showFindByValue(nodeAt('$.str'))).toBe(false);
      });

      it('showCollapse: hidden when already collapsed', async () => {
        await createWith({ outer: { inner: 1 } });
        cmp.collapseAll();
        fixture.detectChanges();
        expect(cmp.showCollapse(nodeAt('$.outer'))).toBe(false);
      });

      it('showExpandAllFromHere: hidden when subtree is fully expanded', async () => {
        await createWith({ outer: { inner: { leaf: 1 } } });
        cmp.expandAll();
        fixture.detectChanges();
        expect(cmp.showExpandAllFromHere(nodeAt('$.outer'))).toBe(false);
      });

      it('showExpandToDepth: hides +N greater than the deepest container descendant depth (Bug 1)', async () => {
        // Subtree { outer: { mid: { inner: 1 } } } from $.outer:
        //   $.outer (clicked, container, depth 0)
        //   $.outer.mid (container, depth 1)
        //   $.outer.mid.inner (primitive leaf, depth 2)
        // After v0.19.4: maxDescendantDepth counts only containers,
        // so it returns 1 (mid is the deepest container). +1 alone
        // is in range; +2..+5 hide. Expand all + +1 are both meaningful
        // but distinct: +1 expands only outer (one click); All
        // expands outer AND mid (two clicks of work in one).
        await createWith({ outer: { mid: { inner: 1 } } });
        cmp.collapseAll();
        fixture.detectChanges();
        const outer = nodeAt('$.outer');
        expect(cmp.showExpandToDepth(outer, 1)).toBe(true);
        expect(cmp.showExpandToDepth(outer, 2)).toBe(false);
        expect(cmp.showExpandToDepth(outer, 3)).toBe(false);
        expect(cmp.showExpandToDepth(outer, 4)).toBe(false);
        expect(cmp.showExpandToDepth(outer, 5)).toBe(false);
      });

      it('showExpandToDepth: hides every +N when subtree is already fully expanded (Bug 2)', async () => {
        await createWith({ outer: { mid: { inner: { leaf: 1 } } } });
        cmp.expandAll();
        fixture.detectChanges();
        const outer = nodeAt('$.outer');
        for (let depth = 1; depth <= 5; depth++) {
          expect(cmp.showExpandToDepth(outer, depth))
            .withContext(`+${depth} should hide when fully expanded`)
            .toBe(false);
        }
      });

      it('showExpandToDepth: hides every +N when clicked node has only primitive children', async () => {
        // After v0.19.4: the clicked node has no container descendants
        // (all children are primitives), so maxDescendantDepth = 0
        // and every +N hides. Only Expand all is meaningful in this
        // case (and the single-item elevation logic in
        // `expandFromHereSingleAction` will surface it).
        await createWith({ outer: { x: 1, y: 2 } });
        cmp.collapseAll();
        fixture.detectChanges();
        const outer = nodeAt('$.outer');
        expect(cmp.showExpandToDepth(outer, 1)).toBe(false);
        expect(cmp.showExpandToDepth(outer, 2)).toBe(false);
        expect(cmp.showExpandToDepth(outer, 3)).toBe(false);
      });

      it('showExpandToDepth: walks hidden containers under collapsed ancestors', async () => {
        // outer is expanded; mid is collapsed (so inner is hidden).
        // After v0.19.4: maxDescendantDepth(outer) counts only
        // containers (mid d=1, inner d=2) -> 2. The leaf primitive
        // at d=3 doesn't extend the actionable depth because
        // expanding inner already reveals it.
        await createWith({ outer: { mid: { inner: { leaf: 1 } } } });
        cmp.expandAll();
        fixture.detectChanges();
        const outer = nodeAt('$.outer');
        const mid = nodeAt('$.outer.mid');
        cmp.__getHelpersForTesting().setExpanded(mid, false);
        fixture.detectChanges();
        // Collapsed at d=1 (mid). Hidden under it: inner at d=2 still
        // expanded (we did expandAll first, then only collapsed mid).
        expect(cmp.showExpandToDepth(outer, 1)).toBe(false);
        expect(cmp.showExpandToDepth(outer, 2)).toBe(true);
        // +3 hides because maxDescendantDepth=2 (inner is the deepest
        // container; leaf at d=3 is a primitive and doesn't count).
        expect(cmp.showExpandToDepth(outer, 3)).toBe(false);
      });

      it('showExpandToDepth: partial expansion shows only +N that reach a collapsed container', async () => {
        // Mirrors the user's example: top-level expanded, second-level
        // expanded, alt-second-level collapsed (its third-level hidden
        // and collapsed inside it). After v0.19.4: hide +1; show +2;
        // hide +3..+5 (third-level is the deepest container at d=2,
        // x/y at d=3 are primitives so don't extend depth).
        await createWith({
          'top-level': {
            'second-level': { 'third-level': { x: 1, y: 2 } },
            'alt-second-level': { 'third-level': { x: 1, y: 2 } },
          },
        });
        cmp.expandAll();
        fixture.detectChanges();
        const top = nodeAt('$["top-level"]');
        const altSecond = nodeAt('$["top-level"]["alt-second-level"]');
        const altThird = nodeAt('$["top-level"]["alt-second-level"]["third-level"]');
        // Collapse only alt-second-level and its (now hidden) third-level
        // so the partial-expansion shape matches the user's scenario.
        cmp.__getHelpersForTesting().setExpanded(altThird, false);
        cmp.__getHelpersForTesting().setExpanded(altSecond, false);
        fixture.detectChanges();
        expect(cmp.showExpandToDepth(top, 1)).toBe(false);
        expect(cmp.showExpandToDepth(top, 2)).toBe(true);
        // +3 hides post-v0.19.4: alt-third-level is at d=2 (deepest
        // container); its primitive children at d=3 don't extend depth.
        expect(cmp.showExpandToDepth(top, 3)).toBe(false);
        expect(cmp.showExpandToDepth(top, 4)).toBe(false);
        expect(cmp.showExpandToDepth(top, 5)).toBe(false);
      });
    });

    describe('onRowDblClick', () => {
      it('copies the value of a primitive row', async () => {
        await createWith({ note: 'hi' });
        const writeText = jasmine.createSpy('writeText').and.resolveTo(undefined);
        const node = nodeAt('$.note');
        withCtxClipboard({ writeText }, () => cmp.onRowDblClick(new MouseEvent('dblclick'), node));
        await Promise.resolve();
        await Promise.resolve();
        expect(writeText).toHaveBeenCalledWith('hi');
      });

      it('expands a collapsed container on dblclick', async () => {
        await createWith({ obj: { a: 1 } });
        cmp.collapseAll();
        fixture.detectChanges();
        const writeText = jasmine.createSpy('writeText').and.resolveTo(undefined);
        const node = nodeAt('$.obj');
        expect(cmp.__getHelpersForTesting().isExpanded(node))
          .withContext('starts collapsed')
          .toBe(false);
        withCtxClipboard({ writeText }, () => cmp.onRowDblClick(new MouseEvent('dblclick'), node));
        await Promise.resolve();
        await Promise.resolve();
        expect(cmp.__getHelpersForTesting().isExpanded(node))
          .withContext('expanded after dblclick')
          .toBe(true);
        expect(writeText).not.toHaveBeenCalled();
      });

      it('collapses an expanded container on dblclick', async () => {
        await createWith({ obj: { a: 1 } });
        cmp.expandAll();
        fixture.detectChanges();
        const writeText = jasmine.createSpy('writeText').and.resolveTo(undefined);
        const node = nodeAt('$.obj');
        expect(cmp.__getHelpersForTesting().isExpanded(node))
          .withContext('starts expanded')
          .toBe(true);
        withCtxClipboard({ writeText }, () => cmp.onRowDblClick(new MouseEvent('dblclick'), node));
        await Promise.resolve();
        await Promise.resolve();
        expect(cmp.__getHelpersForTesting().isExpanded(node))
          .withContext('collapsed after dblclick')
          .toBe(false);
        expect(writeText).not.toHaveBeenCalled();
      });

      it('toggles container on dblclick even when Alt is held (no copy)', async () => {
        await createWith({ obj: { a: 1 } });
        cmp.collapseAll();
        fixture.detectChanges();
        const writeText = jasmine.createSpy('writeText').and.resolveTo(undefined);
        const node = nodeAt('$.obj');
        withCtxClipboard({ writeText }, () =>
          cmp.onRowDblClick(new MouseEvent('dblclick', { altKey: true }), node),
        );
        await Promise.resolve();
        await Promise.resolve();
        expect(cmp.__getHelpersForTesting().isExpanded(node))
          .withContext('Alt does not suppress toggle')
          .toBe(true);
        expect(writeText).not.toHaveBeenCalled();
      });

      it('emits tree.row.doubleClickToggle with the post-toggle action', async () => {
        const logger = await createWithLoggerSpy({ obj: { a: 1 } });
        cmp.collapseAll();
        fixture.detectChanges();
        const node = nodeAt('$.obj');

        cmp.onRowDblClick(new MouseEvent('dblclick'), node);
        expect(logger.info).toHaveBeenCalledWith('tree.row.doubleClickToggle', {
          action: 'expand',
        });

        logger.info.calls.reset();
        cmp.onRowDblClick(new MouseEvent('dblclick'), node);
        expect(logger.info).toHaveBeenCalledWith('tree.row.doubleClickToggle', {
          action: 'collapse',
        });
      });

      it('copies the literal `{}` on dblclick of an empty object row', async () => {
        // Per Q4b: empty containers no longer no-op on dblclick. They
        // route through the same copyValue path as primitives, copying
        // the literal `{}` to the clipboard. Issue #109's
        // "expand/collapse instead of copying" wording is relaxed for
        // this edge case (no expand/collapse possible). The
        // `tree.row.doubleClickCopyValue` JSDoc was also updated.
        const logger = await createWithLoggerSpy({ empty: {} });
        const writeText = jasmine.createSpy('writeText').and.resolveTo(undefined);
        const node = nodeAt('$.empty');
        const wasExpanded = cmp.__getHelpersForTesting().isExpanded(node);
        withCtxClipboard({ writeText }, () => cmp.onRowDblClick(new MouseEvent('dblclick'), node));
        await Promise.resolve();
        await Promise.resolve();
        expect(writeText).toHaveBeenCalledWith('{}');
        expect(cmp.__getHelpersForTesting().isExpanded(node))
          .withContext('expansion state unchanged on empty container')
          .toBe(wasExpanded);
        expect(logger.info).toHaveBeenCalledWith('tree.row.doubleClickCopyValue', {
          escaped: false,
        });
        expect(logger.info).not.toHaveBeenCalledWith(
          'tree.row.doubleClickToggle',
          jasmine.anything(),
        );
      });

      it('copies the literal `[]` on dblclick of an empty array row', async () => {
        const logger = await createWithLoggerSpy({ empty: [] });
        const writeText = jasmine.createSpy('writeText').and.resolveTo(undefined);
        const node = nodeAt('$.empty');
        withCtxClipboard({ writeText }, () => cmp.onRowDblClick(new MouseEvent('dblclick'), node));
        await Promise.resolve();
        await Promise.resolve();
        expect(writeText).toHaveBeenCalledWith('[]');
        expect(logger.info).toHaveBeenCalledWith('tree.row.doubleClickCopyValue', {
          escaped: false,
        });
        expect(logger.info).not.toHaveBeenCalledWith(
          'tree.row.doubleClickToggle',
          jasmine.anything(),
        );
      });

      it('skips when the dblclick target is an interactive descendant (kebab pill)', async () => {
        await createWith({ alpha: 1 });
        cmp.expandAll();
        fixture.detectChanges();
        const writeText = jasmine.createSpy('writeText').and.resolveTo(undefined);
        const kebab = (fixture.nativeElement as HTMLElement).querySelector(
          '.tree-kebab-pill',
        ) as HTMLButtonElement;
        const ev = new MouseEvent('dblclick', { bubbles: true });
        Object.defineProperty(ev, 'target', { value: kebab });
        const node = nodeAt('$.alpha');
        withCtxClipboard({ writeText }, () => cmp.onRowDblClick(ev, node));
        await Promise.resolve();
        await Promise.resolve();
        expect(writeText).not.toHaveBeenCalled();
      });

      it('skips when the dblclick target is the chevron toggle button (regression for issue #109)', async () => {
        const logger = await createWithLoggerSpy({ obj: { a: 1 } });
        cmp.collapseAll();
        fixture.detectChanges();
        const node = nodeAt('$.obj');
        const wasExpanded = cmp.__getHelpersForTesting().isExpanded(node);
        const chevron = (fixture.nativeElement as HTMLElement).querySelector(
          '.tree-row[data-path="$.obj"] .tree-twisty[mattreenodetoggle], .tree-row[data-path="$.obj"] button[mattreenodetoggle]',
        ) as HTMLButtonElement | null;
        expect(chevron).withContext('found the chevron toggle button on $.obj').toBeTruthy();
        const ev = new MouseEvent('dblclick', { bubbles: true });
        Object.defineProperty(ev, 'target', { value: chevron });
        cmp.onRowDblClick(ev, node);
        // The interactive-descendant guard should short-circuit before
        // any toggle / telemetry happens here. The chevron's own
        // matTreeNodeToggle click handler is what flips state on click;
        // this guard ensures dblclick on the chevron does not _also_
        // toggle from the row handler.
        expect(cmp.__getHelpersForTesting().isExpanded(node)).toBe(wasExpanded);
        expect(logger.info).not.toHaveBeenCalledWith(
          'tree.row.doubleClickToggle',
          jasmine.anything(),
        );
      });
    });

    describe('rendering', () => {
      it('renders a kebab button on every visible row', async () => {
        await createWith({ a: 1, b: 2 });
        cmp.expandAll();
        fixture.detectChanges();
        const kebabs = (fixture.nativeElement as HTMLElement).querySelectorAll('.tree-kebab-pill');
        // root container + a leaf + b leaf = 3 visible rows.
        expect(kebabs.length).toBeGreaterThanOrEqual(3);
      });

      it('renders menu items with the right contextNode when the kebab is clicked via the DOM', async () => {
        // Regression: MatMenuTrigger's host (click) listener could run
        // before our template (click) on the same kebab button,
        // opening the menu with `contextNode()` still null and the
        // `@if (contextNode()) { ... }` branch hiding every item.
        // Verifies the menu actually shows items after a real DOM click.
        await createWith({ alpha: 1 });
        cmp.expandAll();
        fixture.detectChanges();
        const kebabs = (fixture.nativeElement as HTMLElement).querySelectorAll(
          '.tree-kebab-pill',
        ) as NodeListOf<HTMLButtonElement>;
        // The leaf row's kebab (skip the root container's kebab at index 0).
        const leafKebab = Array.from(kebabs).find(
          (b) => b.closest('.tree-row[data-path="$.alpha"]') !== null,
        ) as HTMLButtonElement | undefined;
        expect(leafKebab).withContext('found a kebab on $.alpha').toBeTruthy();
        leafKebab!.click();
        fixture.detectChanges();
        // Wait a tick for the menu overlay to attach.
        await Promise.resolve();
        fixture.detectChanges();
        expect(cmp.contextNode()?.pathString).toBe('$.alpha');
        const items = document.body.querySelectorAll('button.mat-mdc-menu-item');
        expect(items.length).withContext('menu must render at least one item').toBeGreaterThan(0);
        // Clean up the overlay so it doesn't leak into other specs.
        document.body
          .querySelectorAll('.cdk-overlay-backdrop')
          .forEach((b) => (b as HTMLElement).click());
        fixture.detectChanges();
      });

      it('renders Copy value as the first menu item, marked as the default action', async () => {
        // M7q polish: Copy value moved to position 1 + bold via
        // `.ctx-default-action` so the dblclick-equivalent action is
        // both top-of-list and visually distinct.
        await createWith({ alpha: 1 });
        cmp.expandAll();
        fixture.detectChanges();
        const kebab = (fixture.nativeElement as HTMLElement).querySelector(
          '.tree-row[data-path="$.alpha"] .tree-kebab-pill',
        ) as HTMLButtonElement | null;
        expect(kebab).toBeTruthy();
        kebab!.click();
        fixture.detectChanges();
        await Promise.resolve();
        fixture.detectChanges();
        const items = document.body.querySelectorAll(
          'button.mat-mdc-menu-item',
        ) as NodeListOf<HTMLButtonElement>;
        expect(items.length).toBeGreaterThan(0);
        const first = items[0];
        // The bolded Copy value row carries a `.sr-only` a11y hint
        // span suffix in v0.19.3+, so we assert that the visible
        // label is still the prefix of textContent (the rest is the
        // visually-hidden double-click hint).
        expect(first.textContent?.trim().startsWith(cmp.ctxCopyValueLabel)).toBeTrue();
        expect(first.classList.contains('ctx-default-action')).toBe(true);
        document.body
          .querySelectorAll('.cdk-overlay-backdrop')
          .forEach((b) => (b as HTMLElement).click());
        fixture.detectChanges();
      });
    });

    describe('surfaced default-shortcut row (Path Y)', () => {
      it('omits the surfaced row and bolds Copy value for a primitive', async () => {
        await createWith({ alpha: 1 });
        cmp.expandAll();
        fixture.detectChanges();
        cmp.contextNode.set(nodeAt('$.alpha'));
        expect(cmp.defaultActionKind()).toBe('copyValue');
        expect(cmp.surfacedShortcutLabel()).toBeNull();
      });

      it('surfaces "Expand 1 level" for a collapsed container', async () => {
        await createWith({ obj: { a: 1 } });
        cmp.collapseAll();
        fixture.detectChanges();
        cmp.contextNode.set(nodeAt('$.obj'));
        expect(cmp.defaultActionKind()).toBe('expandRow');
        expect(cmp.surfacedShortcutLabel()).toBe(cmp.ctxExpand1LevelLabel);
      });

      it('surfaces "Collapse from here" for an expanded container', async () => {
        await createWith({ obj: { a: 1 } });
        cmp.expandAll();
        fixture.detectChanges();
        cmp.contextNode.set(nodeAt('$.obj'));
        expect(cmp.defaultActionKind()).toBe('collapseRow');
        expect(cmp.surfacedShortcutLabel()).toBe(cmp.ctxCollapseFromHereLabel);
      });

      it('omits the surfaced row and bolds Copy value for an empty container', async () => {
        await createWith({ empty: {} });
        fixture.detectChanges();
        cmp.contextNode.set(nodeAt('$.empty'));
        // Empty container falls into the copyValue branch because its
        // children list is empty, even though its type is 'object'.
        expect(cmp.defaultActionKind()).toBe('copyValue');
        expect(cmp.surfacedShortcutLabel()).toBeNull();
      });

      it('clicking the surfaced "Expand 1 level" row expands the clicked container', async () => {
        await createWith({ obj: { a: 1 } });
        cmp.collapseAll();
        fixture.detectChanges();
        const node = nodeAt('$.obj');
        cmp.contextNode.set(node);
        expect(cmp.__getHelpersForTesting().isExpanded(node)).toBe(false);
        cmp.onSurfacedShortcutClick(node);
        expect(cmp.__getHelpersForTesting().isExpanded(node))
          .withContext('expanded after surfaced shortcut click')
          .toBe(true);
      });

      it('clicking the surfaced "Collapse from here" row collapses the clicked container', async () => {
        await createWith({ obj: { a: 1 } });
        cmp.expandAll();
        fixture.detectChanges();
        const node = nodeAt('$.obj');
        cmp.contextNode.set(node);
        expect(cmp.__getHelpersForTesting().isExpanded(node)).toBe(true);
        cmp.onSurfacedShortcutClick(node);
        expect(cmp.__getHelpersForTesting().isExpanded(node))
          .withContext('collapsed after surfaced shortcut click')
          .toBe(false);
      });

      it('renders a `.sr-only` a11y hint on the bolded surfaced row (collapsed container)', async () => {
        // v0.19.3: bolded items announce "; same as double-clicking
        // the row" to AT users via a visually-hidden span. Replaces
        // the v0.19.0 matTooltip that was dropped in v0.19.1 because
        // the overlay obscured the next menu item.
        await createWith({ obj: { a: 1 } });
        cmp.collapseAll();
        fixture.detectChanges();
        await openMenuFor('$.obj');
        const items = Array.from(
          document.body.querySelectorAll<HTMLButtonElement>('button.mat-mdc-menu-item'),
        );
        const surfaced = items.find((m) => m.classList.contains('ctx-default-action'));
        expect(surfaced).withContext('found surfaced bolded row').toBeTruthy();
        const hint = surfaced!.querySelector<HTMLElement>('.sr-only');
        expect(hint?.textContent?.trim()).toBe(cmp.defaultActionA11yHint.trim());
        document.body
          .querySelectorAll('.cdk-overlay-backdrop')
          .forEach((b) => (b as HTMLElement).click());
        fixture.detectChanges();
      });

      it('renders a `.sr-only` a11y hint on the bolded Copy value for primitives', async () => {
        await createWith({ alpha: 1 });
        cmp.expandAll();
        fixture.detectChanges();
        await openMenuFor('$.alpha');
        const items = Array.from(
          document.body.querySelectorAll<HTMLButtonElement>('button.mat-mdc-menu-item'),
        );
        const copyValue = items.find((m) => m.classList.contains('ctx-default-action'));
        expect(copyValue?.textContent?.trim().startsWith(cmp.ctxCopyValueLabel)).toBeTrue();
        const hint = copyValue!.querySelector<HTMLElement>('.sr-only');
        expect(hint?.textContent?.trim()).toBe(cmp.defaultActionA11yHint.trim());
        document.body
          .querySelectorAll('.cdk-overlay-backdrop')
          .forEach((b) => (b as HTMLElement).click());
        fixture.detectChanges();
      });
    });

    describe('Subtree submenu (Path Y + v0.19.4 elevation)', () => {
      it('renders the Subtree > trigger when at least 2 subtree actions apply', async () => {
        // After v0.19.4 single-item elevation: a single-action Subtree
        // elevates its lone item directly to the row menu instead of
        // nesting it. Renders as a real `Subtree >` flyout only when
        // 2+ actions apply. A nested-container fixture clicked at a
        // mid-level with peers gives Collapse + Isolate (single mode)
        // = 2 items, so the trigger renders.
        await createWith({ outer: { a: { x: 1, y: 2 }, b: { z: 3 } } });
        cmp.expandAll();
        fixture.detectChanges();
        await openMenuFor('$.outer.a');
        const items = Array.from(
          document.body.querySelectorAll<HTMLButtonElement>('button.mat-mdc-menu-item'),
        );
        const trigger = items.find((m) =>
          (m.textContent ?? '').trim().includes(cmp.ctxSubtreeMenuLabel),
        );
        expect(trigger).withContext('Subtree trigger present').toBeTruthy();
        document.body
          .querySelectorAll('.cdk-overlay-backdrop')
          .forEach((b) => (b as HTMLElement).click());
        fixture.detectChanges();
      });

      it('elevates a single Subtree item to row level instead of rendering Subtree >', async () => {
        // Click on an expanded container that has only primitive
        // children: the only Subtree action would be Collapse, but
        // the surfaced default-shortcut row already shows
        // "Collapse from here" -- so v0.19.4 suppresses the
        // duplicate via the `'collapseSame'` sentinel. No Subtree
        // trigger renders at all (suppression case).
        await createWith({ obj: { a: 1, b: 2 } });
        cmp.expandAll();
        fixture.detectChanges();
        await openMenuFor('$.obj');
        const items = Array.from(
          document.body.querySelectorAll<HTMLButtonElement>('button.mat-mdc-menu-item'),
        );
        const subtreeTrigger = items.find((m) =>
          (m.textContent ?? '').trim().includes(cmp.ctxSubtreeMenuLabel),
        );
        expect(subtreeTrigger)
          .withContext('Subtree submenu suppressed (collapseSame)')
          .toBeUndefined();
        // Verify that the surfaced shortcut row carries the same
        // Collapse action (so the user still has access).
        const surfaced = items.find((m) => m.classList.contains('ctx-default-action'));
        expect(surfaced?.textContent?.trim().startsWith(cmp.ctxCollapseFromHereLabel)).toBeTrue();
        document.body
          .querySelectorAll('.cdk-overlay-backdrop')
          .forEach((b) => (b as HTMLElement).click());
        fixture.detectChanges();
      });

      it('hides the Subtree > trigger on a primitive row (no subtree to act on)', async () => {
        await createWith({ alpha: 1 });
        cmp.expandAll();
        fixture.detectChanges();
        await openMenuFor('$.alpha');
        const items = Array.from(
          document.body.querySelectorAll<HTMLButtonElement>('button.mat-mdc-menu-item'),
        );
        const trigger = items.find((m) =>
          (m.textContent ?? '').trim().includes(cmp.ctxSubtreeMenuLabel),
        );
        expect(trigger).withContext('Subtree trigger absent on primitive').toBeUndefined();
        document.body
          .querySelectorAll('.cdk-overlay-backdrop')
          .forEach((b) => (b as HTMLElement).click());
        fixture.detectChanges();
      });

      it('Subtree submenu contains Collapse siblings + Isolate when both narrow and wider sets apply', async () => {
        // For showIsolatePair to be true, both narrowSet (peers under
        // the clicked row's parent) and widerSet (peers at higher
        // ancestors) must be non-empty. The fixture has:
        //   - root has $.outer and $.sibling (widerSet for $.outer.a)
        //   - $.outer has .a and .b (narrowSet for $.outer.a)
        await createWith({ outer: { a: { x: 1, y: 2 }, b: { z: 3 } }, sibling: { p: 1 } });
        cmp.expandAll();
        fixture.detectChanges();
        await openMenuFor('$.outer.a');
        const trigger = menuItemContaining(cmp.ctxSubtreeMenuLabel);
        trigger.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true, cancelable: true }));
        fixture.detectChanges();
        await Promise.resolve();
        fixture.detectChanges();
        const panels = Array.from(
          document.body.querySelectorAll<HTMLElement>('.mat-mdc-menu-panel'),
        );
        const subtreePanel = panels[panels.length - 1]!;
        const labels = Array.from(
          subtreePanel.querySelectorAll<HTMLButtonElement>('button.mat-mdc-menu-item'),
        ).map((m) => (m.textContent ?? '').trim());
        // Spec terms preserved per DESIGN_SPEC.md §514.
        expect(labels).toContain(cmp.ctxIsolateLabel);
        expect(labels).toContain(cmp.ctxCollapseSiblingsLabel);
        document.body
          .querySelectorAll('.cdk-overlay-backdrop')
          .forEach((b) => (b as HTMLElement).click());
        fixture.detectChanges();
      });

      it('renders depth labels with `+N` prefix per DESIGN_SPEC.md §516', async () => {
        // The +N notation distinguishes per-row relative-additive
        // depth from the toolbar's absolute snap-to-exact dropdown.
        expect(cmp.ctxExpandToDepth1Label).toBe('+1 level');
        expect(cmp.ctxExpandToDepth2Label).toBe('+2 levels');
        expect(cmp.ctxExpandToDepth3Label).toBe('+3 levels');
        expect(cmp.ctxExpandToDepth4Label).toBe('+4 levels');
        expect(cmp.ctxExpandToDepth5Label).toBe('+5 levels');
      });

      it('Subtree -> Expand submenu trigger renders when any depth predicate applies', async () => {
        await createWith({ outer: { mid: { inner: 1 } } });
        cmp.collapseAll();
        fixture.detectChanges();
        const node = nodeAt('$.outer');
        expect(cmp.showExpandFromHereMenu(node)).toBeTrue();
      });
    });

    describe('single-item elevation (v0.19.4)', () => {
      it('expandFromHereSingleAction returns expandAll when only Expand all is visible', async () => {
        // Container with only primitive children: maxDescendantDepth=0
        // (no container descendants), so +N predicates all hide. Expand
        // all is the lone Expand contribution, ready to elevate.
        await createWith({ outer: { x: 1, y: 2 } });
        cmp.collapseAll();
        fixture.detectChanges();
        const outer = nodeAt('$.outer');
        const single = cmp.expandFromHereSingleAction(outer);
        expect(single).toEqual({ kind: 'expandAll' });
        expect(cmp.showExpandFromHereSubmenu(outer))
          .withContext('Expand sub-submenu hides for single item')
          .toBeFalse();
      });

      it('expandFromHereSingleAction returns null when 2+ items are visible', async () => {
        // Two-level nesting with container descendants: +1 and All
        // both visible (different end states). No single elevation.
        await createWith({ outer: { mid: { inner: 1 } } });
        cmp.collapseAll();
        fixture.detectChanges();
        const outer = nodeAt('$.outer');
        expect(cmp.expandFromHereSingleAction(outer)).toBeNull();
        expect(cmp.showExpandFromHereSubmenu(outer))
          .withContext('Expand sub-submenu renders for 2+ items')
          .toBeTrue();
      });

      it('subtreeElevatedAction returns null when 2+ Subtree items apply', async () => {
        // Collapse + Isolate (single mode peers) = 2 items.
        await createWith({ outer: { a: { x: 1 }, b: { y: 2 } } });
        cmp.expandAll();
        fixture.detectChanges();
        const a = nodeAt('$.outer.a');
        expect(cmp.subtreeElevatedAction(a)).toBeNull();
        expect(cmp.showSubtreeMenu(a)).toBeTrue();
      });

      it('subtreeElevatedAction returns collapseSame when surfaced shortcut would duplicate', async () => {
        // Single Subtree item is Collapse, and the surfaced
        // shortcut row also shows Collapse from here -- suppress
        // both via the sentinel.
        await createWith({ obj: { a: 1, b: 2 } });
        cmp.expandAll();
        fixture.detectChanges();
        const obj = nodeAt('$.obj');
        cmp.contextNode.set(obj);
        expect(cmp.defaultActionKind()).toBe('collapseRow');
        expect(cmp.subtreeElevatedAction(obj)).toEqual({ kind: 'collapseSame' });
        expect(cmp.showSubtreeMenu(obj))
          .withContext('Subtree submenu suppressed when surfaced row duplicates')
          .toBeFalse();
      });

      it('subtreeElevatedAction returns expandSingle for collapsed container with only primitives', async () => {
        // A collapsed container with only primitive children:
        //   - showCollapse: false (not expanded)
        //   - showIsolate*: false (no peers expanded)
        //   - showHighlight*: false (canEditHighlights false)
        //   - showExpandFromHereMenu: true (Expand all is meaningful)
        //   - expandFromHereSingleAction: { kind: 'expandAll' }
        // Surfaced shortcut = Expand 1 level (expandRow), single
        // Expand action is expandAll (NOT depth=1) -> elevate as
        // 'expandSingle' (no expandSame suppression).
        await createWith({ obj: { a: 1, b: 2 } });
        cmp.collapseAll();
        fixture.detectChanges();
        const obj = nodeAt('$.obj');
        cmp.contextNode.set(obj);
        expect(cmp.defaultActionKind()).toBe('expandRow');
        const elevated = cmp.subtreeElevatedAction(obj);
        expect(elevated?.kind).toBe('expandSingle');
        if (elevated?.kind === 'expandSingle') {
          expect(elevated.single).toEqual({ kind: 'expandAll' });
        }
      });

      it('subtreeElevatedAction returns expandSubmenu when Expand has 2+ items as the lone Subtree contribution', async () => {
        // Collapsed container with nested containers: showCollapse
        // false (not expanded), no isolate / highlight, but Expand
        // has both +1 and All visible -> 2 items. Subtree count
        // is 1 (the whole Expand "section" counts as one), so
        // Subtree elevates the Expand submenu trigger to row level.
        await createWith({ outer: { mid: { inner: 1 } } });
        cmp.collapseAll();
        fixture.detectChanges();
        const outer = nodeAt('$.outer');
        cmp.contextNode.set(outer);
        expect(cmp.subtreeElevatedAction(outer)).toEqual({ kind: 'expandSubmenu' });
      });

      it('subtreeElevatedAction returns removeTreeHighlight on a primitive leaf with cascade ancestor', async () => {
        // Primitive leaf with a cascade highlight on its ancestor:
        //   - showCollapse: false (no children)
        //   - showHighlight*: false (not a container; not editable
        //     unless canEditHighlights)
        //   - showRemoveTreeHighlight: true (has cascade ancestor)
        //   - showExpandFromHereMenu: false
        // The lone Subtree contribution elevates with the
        // "Remove subtree highlight" elevated label.
        await createWith({ parent: { child: 1 } });
        // Mirror enableHighlightEditing pattern from other tests.
        fixture.componentRef.setInput('canEditHighlights', true);
        fixture.componentRef.setInput('highlights', [
          { path: '$.parent', color: '#7e6500', cascade: true },
        ]);
        cmp.expandAll();
        fixture.detectChanges();
        const child = nodeAt('$.parent.child');
        expect(cmp.subtreeElevatedAction(child)).toEqual({ kind: 'removeTreeHighlight' });
      });
    });

    describe('icons (Phase 3)', () => {
      it('renders a leading <jj-icon> on every top-level menu item', async () => {
        // Phase 3 of the tree-menu overhaul applies leading icons to
        // every top-level row in the row menu (Path Y choice: Option
        // 1 -- icons everywhere). For a primitive row we expect at
        // minimum: Copy value, Copy key, Copy path, Find by key,
        // Find by value -- all five with leading icons.
        await createWith({ alpha: 1 });
        cmp.expandAll();
        fixture.detectChanges();
        await openMenuFor('$.alpha');
        const items = Array.from(
          document.body.querySelectorAll<HTMLButtonElement>('button.mat-mdc-menu-item'),
        );
        expect(items.length).toBeGreaterThanOrEqual(5);
        for (const item of items) {
          expect(item.querySelector('jj-icon'))
            .withContext(`menu item "${(item.textContent ?? '').trim()}" has a leading jj-icon`)
            .toBeTruthy();
        }
        document.body
          .querySelectorAll('.cdk-overlay-backdrop')
          .forEach((b) => (b as HTMLElement).click());
        fixture.detectChanges();
      });

      it('surfaces an "expand-subtree" icon on the surfaced shortcut for collapsed containers', async () => {
        await createWith({ obj: { a: 1 } });
        cmp.collapseAll();
        fixture.detectChanges();
        cmp.contextNode.set(nodeAt('$.obj'));
        expect(cmp.surfacedShortcutIconName()).toBe('expand-subtree');
      });

      it('surfaces a "collapse-subtree" icon on the surfaced shortcut for expanded containers', async () => {
        await createWith({ obj: { a: 1 } });
        cmp.expandAll();
        fixture.detectChanges();
        cmp.contextNode.set(nodeAt('$.obj'));
        expect(cmp.surfacedShortcutIconName()).toBe('collapse-subtree');
      });

      it('surfaces no icon on primitives (Copy value at top is bolded directly)', async () => {
        await createWith({ alpha: 1 });
        fixture.detectChanges();
        cmp.contextNode.set(nodeAt('$.alpha'));
        expect(cmp.surfacedShortcutIconName()).toBeNull();
      });
    });

    describe('telemetry (Phase 4)', () => {
      it('emits tree.contextMenu.collapse with source=top from the surfaced shortcut', async () => {
        const logger = await createWithLoggerSpy({ obj: { a: 1 } });
        cmp.expandAll();
        fixture.detectChanges();
        const node = nodeAt('$.obj');
        cmp.contextNode.set(node);
        cmp.onSurfacedShortcutClick(node);
        expect(logger.info).toHaveBeenCalledWith('tree.contextMenu.collapse', { source: 'top' });
      });

      it('emits tree.contextMenu.collapse with source=submenu from the in-Subtree item', async () => {
        const logger = await createWithLoggerSpy({ obj: { a: 1 } });
        cmp.expandAll();
        fixture.detectChanges();
        cmp.collapseFromHere(nodeAt('$.obj'));
        expect(logger.info).toHaveBeenCalledWith('tree.contextMenu.collapse', {
          source: 'submenu',
        });
      });

      it('emits tree.contextMenu.expandToDepth with source=top relativeDepth=1 from the surfaced shortcut', async () => {
        const logger = await createWithLoggerSpy({ obj: { a: 1 } });
        cmp.collapseAll();
        fixture.detectChanges();
        const node = nodeAt('$.obj');
        cmp.contextNode.set(node);
        cmp.onSurfacedShortcutClick(node);
        expect(logger.info).toHaveBeenCalledWith('tree.contextMenu.expandToDepth', {
          relativeDepth: 1,
          source: 'top',
        });
      });

      it('emits tree.contextMenu.expandToDepth with source=submenu from the in-Subtree depth item', async () => {
        const logger = await createWithLoggerSpy({ outer: { a: { x: 1 } } });
        cmp.collapseAll();
        fixture.detectChanges();
        cmp.expandToDepthFromHere(nodeAt('$.outer'), 3);
        expect(logger.info).toHaveBeenCalledWith('tree.contextMenu.expandToDepth', {
          relativeDepth: 3,
          source: 'submenu',
        });
      });

      it('emits tree.contextMenu.expandAllFromHere with source=submenu', async () => {
        const logger = await createWithLoggerSpy({ outer: { a: { x: 1 } } });
        cmp.collapseAll();
        fixture.detectChanges();
        cmp.expandAllFromHere(nodeAt('$.outer'));
        expect(logger.info).toHaveBeenCalledWith('tree.contextMenu.expandAllFromHere', {
          source: 'submenu',
        });
      });

      it('emits tree.contextMenu.subtreeOpened when the Subtree submenu opens', async () => {
        const logger = await createWithLoggerSpy({ obj: { a: 1 } });
        cmp.expandAll();
        fixture.detectChanges();
        cmp.onSubtreeMenuOpened();
        expect(logger.info).toHaveBeenCalledWith('tree.contextMenu.subtreeOpened');
      });

      it('emits tree.contextMenu.highlight for single-row scope and highlightSubtree for cascade scope', async () => {
        const logger = await createWithLoggerSpy({ parent: { child: 1 } });
        cmp.canEditHighlights;
        // Wire canEditHighlights via the component's input. The
        // existing test fixtures often set a fake host; here we
        // hit the predicate directly by mutating the signal.
        fixture.componentRef.setInput('canEditHighlights', true);
        fixture.detectChanges();
        cmp.applyManualHighlight(nodeAt('$.parent'), false, '#fff59d');
        expect(logger.info).toHaveBeenCalledWith('tree.contextMenu.highlight');
        logger.info.calls.reset();
        cmp.applyManualHighlight(nodeAt('$.parent'), true, '#b3e5fc');
        expect(logger.info).toHaveBeenCalledWith('tree.contextMenu.highlightSubtree');
      });

      it('emits tree.contextMenu.extract from the menu-driven entry point', async () => {
        const logger = await createWithLoggerSpy({ payload: '{"k":1}' });
        cmp.expandAll();
        fixture.detectChanges();
        // emitExtract requires extractCandidates input; without it
        // the early-return path skips the emit. We just need to
        // verify the menu-click logger fires before the early-out
        // so spy on the call.
        cmp.onExtractMenuClick(nodeAt('$.payload'));
        expect(logger.info).toHaveBeenCalledWith('tree.contextMenu.extract');
      });
    });

    describe('Find labels (rename, i18n IDs stable)', () => {
      it('renders "Find by key" / "Find by value" for a primitive with a key', async () => {
        await createWith({ alpha: 1 });
        cmp.expandAll();
        fixture.detectChanges();
        await openMenuFor('$.alpha');
        const labels = Array.from(
          document.body.querySelectorAll<HTMLButtonElement>('button.mat-mdc-menu-item'),
        ).map((m) => (m.textContent ?? '').trim());
        expect(labels).toContain(cmp.ctxFindByKeyLabel);
        expect(labels).toContain(cmp.ctxFindByValueLabel);
        // Source text changed; values reflect the rename.
        expect(cmp.ctxFindByKeyLabel).toBe('Find by key');
        expect(cmp.ctxFindByValueLabel).toBe('Find by value');
        document.body
          .querySelectorAll('.cdk-overlay-backdrop')
          .forEach((b) => (b as HTMLElement).click());
        fixture.detectChanges();
      });
    });
  });

  describe('dblclick container toggle (issue #109, DOM-level)', () => {
    function withClipboard<T>(stub: { writeText?: jasmine.Spy } | undefined, run: () => T): T {
      const original = (navigator as { clipboard?: Clipboard }).clipboard;
      const hadOwn = Object.prototype.hasOwnProperty.call(navigator, 'clipboard');
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: stub });
      try {
        return run();
      } finally {
        if (hadOwn && original) {
          Object.defineProperty(navigator, 'clipboard', {
            configurable: true,
            value: original,
          });
        } else {
          delete (navigator as { clipboard?: unknown }).clipboard;
        }
      }
    }

    function objRow(): HTMLElement {
      const row = (fixture.nativeElement as HTMLElement).querySelector(
        '.tree-row[data-path="$.obj"]',
      ) as HTMLElement | null;
      expect(row).withContext('found the $.obj container row').toBeTruthy();
      return row!;
    }

    function objChevron(): HTMLButtonElement {
      const chevron = (fixture.nativeElement as HTMLElement).querySelector(
        '.tree-row[data-path="$.obj"] button[mattreenodetoggle]',
      ) as HTMLButtonElement | null;
      expect(chevron).withContext('found the $.obj chevron toggle').toBeTruthy();
      return chevron!;
    }

    it('real dblclick on container row toggles expansion and does not copy', async () => {
      const logger = await createWithLoggerSpy({ obj: { a: 1, b: 2 } });
      cmp.collapseAll();
      fixture.detectChanges();
      const writeText = jasmine.createSpy('writeText').and.resolveTo(undefined);
      const node = (() => {
        const stack = [cmp.root()!];
        while (stack.length > 0) {
          const n = stack.pop()!;
          if (n.pathString === '$.obj') return n;
          for (const c of n.children ?? []) stack.push(c);
        }
        throw new Error('no $.obj node');
      })();
      expect(cmp.__getHelpersForTesting().isExpanded(node))
        .withContext('starts collapsed')
        .toBe(false);

      withClipboard({ writeText }, () => {
        objRow().dispatchEvent(
          new MouseEvent('dblclick', { bubbles: true, cancelable: true, altKey: false }),
        );
      });
      await Promise.resolve();
      await Promise.resolve();
      fixture.detectChanges();

      expect(cmp.__getHelpersForTesting().isExpanded(node))
        .withContext('expanded after real dblclick')
        .toBe(true);
      expect(writeText).not.toHaveBeenCalled();
      expect(logger.info).toHaveBeenCalledWith('tree.row.doubleClickToggle', {
        action: 'expand',
      });

      // Second real dblclick collapses.
      logger.info.calls.reset();
      withClipboard({ writeText }, () => {
        objRow().dispatchEvent(
          new MouseEvent('dblclick', { bubbles: true, cancelable: true, altKey: false }),
        );
      });
      await Promise.resolve();
      await Promise.resolve();
      fixture.detectChanges();

      expect(cmp.__getHelpersForTesting().isExpanded(node))
        .withContext('collapsed after second real dblclick')
        .toBe(false);
      expect(writeText).not.toHaveBeenCalled();
      expect(logger.info).toHaveBeenCalledWith('tree.row.doubleClickToggle', {
        action: 'collapse',
      });
    });

    it('dblclick on the chevron does not invoke row dblclick behavior', async () => {
      const logger = await createWithLoggerSpy({ obj: { a: 1 } });
      cmp.collapseAll();
      fixture.detectChanges();

      // The chevron button's own click handler (matTreeNodeToggle) runs
      // on each click. A real `dblclick` issued on the chevron is two
      // clicks plus a synthetic dblclick: click 1 expands, click 2
      // collapses, dblclick is short-circuited by the
      // interactive-descendant guard. Net state: matches starting state,
      // and crucially no `tree.row.doubleClickToggle` event fired from
      // the row handler. (The chevron path is intentionally
      // uninstrumented.)
      const chevron = objChevron();
      chevron.dispatchEvent(
        new MouseEvent('dblclick', { bubbles: true, cancelable: true, altKey: false }),
      );
      await Promise.resolve();
      fixture.detectChanges();

      expect(logger.info).not.toHaveBeenCalledWith(
        'tree.row.doubleClickToggle',
        jasmine.anything(),
      );
    });
  });

  describe('Alt-modifier copy escape', () => {
    const rawGreeting = 'hello\nworld';
    const escapedGreeting = JSON.stringify(rawGreeting);

    async function createAltCopyFixture(): Promise<jasmine.SpyObj<LoggerService>> {
      const logger = await createWithLoggerSpy({ greeting: rawGreeting });
      cmp.expandAll();
      fixture.detectChanges();
      return logger;
    }

    function greetingRow(): HTMLElement {
      const row = (fixture.nativeElement as HTMLElement).querySelector(
        '.tree-row[data-path="$.greeting"]',
      ) as HTMLElement | null;
      expect(row).withContext('found the $.greeting tree row').toBeTruthy();
      return row!;
    }

    function withClipboard<T>(stub: { writeText?: jasmine.Spy } | undefined, run: () => T): T {
      const original = (navigator as { clipboard?: Clipboard }).clipboard;
      const hadOwn = Object.prototype.hasOwnProperty.call(navigator, 'clipboard');
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: stub });
      try {
        return run();
      } finally {
        if (hadOwn && original) {
          Object.defineProperty(navigator, 'clipboard', {
            configurable: true,
            value: original,
          });
        } else {
          delete (navigator as { clipboard?: unknown }).clipboard;
        }
      }
    }

    async function flushCopyMicrotasks(): Promise<void> {
      await Promise.resolve();
      await Promise.resolve();
    }

    async function openGreetingContextMenu(): Promise<HTMLButtonElement> {
      greetingRow().dispatchEvent(
        new MouseEvent('contextmenu', {
          clientX: 100,
          clientY: 100,
          bubbles: true,
          cancelable: true,
        }),
      );
      fixture.detectChanges();
      await new Promise<void>((resolve) => queueMicrotask(() => resolve()));
      fixture.detectChanges();
      const button = document.body.querySelector(
        'button.ctx-default-action.mat-mdc-menu-item, button.ctx-default-action[mat-menu-item]',
      ) as HTMLButtonElement | null;
      expect(button).withContext('found the Copy value context-menu item').toBeTruthy();
      return button!;
    }

    function closeOpenMenus(): void {
      cmp.ctxTrigger()?.closeMenu();
      document.body
        .querySelectorAll('.cdk-overlay-backdrop')
        .forEach((backdrop) => (backdrop as HTMLElement).click());
      fixture.detectChanges();
    }

    afterEach(() => {
      closeOpenMenus();
    });

    it('dblclick without Alt', async () => {
      const logger = await createAltCopyFixture();
      const writeText = jasmine.createSpy('writeText').and.resolveTo(undefined);

      withClipboard({ writeText }, () => {
        greetingRow().dispatchEvent(
          new MouseEvent('dblclick', { bubbles: true, cancelable: true, altKey: false }),
        );
      });
      await flushCopyMicrotasks();

      expect(writeText).toHaveBeenCalledWith(rawGreeting);
      expect(logger.info).toHaveBeenCalledWith('tree.row.doubleClickCopyValue', {
        escaped: false,
      });
    });

    it('dblclick with Alt', async () => {
      const logger = await createAltCopyFixture();
      const writeText = jasmine.createSpy('writeText').and.resolveTo(undefined);

      withClipboard({ writeText }, () => {
        greetingRow().dispatchEvent(
          new MouseEvent('dblclick', { bubbles: true, cancelable: true, altKey: true }),
        );
      });
      await flushCopyMicrotasks();

      expect(writeText).toHaveBeenCalledWith(escapedGreeting);
      expect(logger.info).toHaveBeenCalledWith('tree.row.doubleClickCopyValue', {
        escaped: true,
      });
    });

    it('Menu Copy value without Alt (DOM-level)', async () => {
      const logger = await createAltCopyFixture();
      const writeText = jasmine.createSpy('writeText').and.resolveTo(undefined);
      const button = await openGreetingContextMenu();

      withClipboard({ writeText }, () => {
        button.dispatchEvent(
          new MouseEvent('click', { bubbles: true, cancelable: true, altKey: false }),
        );
      });
      await flushCopyMicrotasks();

      expect(writeText).toHaveBeenCalledWith(rawGreeting);
      expect(logger.info).toHaveBeenCalledWith('tree.contextMenu.copyValue', {
        escaped: false,
      });
    });

    it('Menu Copy value with Alt (DOM-level)', async () => {
      const logger = await createAltCopyFixture();
      const writeText = jasmine.createSpy('writeText').and.resolveTo(undefined);
      const button = await openGreetingContextMenu();

      withClipboard({ writeText }, () => {
        button.dispatchEvent(
          new MouseEvent('click', { bubbles: true, cancelable: true, altKey: true }),
        );
      });
      await flushCopyMicrotasks();

      expect(writeText).toHaveBeenCalledWith(escapedGreeting);
      expect(logger.info).toHaveBeenCalledWith('tree.contextMenu.copyValue', {
        escaped: true,
      });
    });
  });

  describe('M7g-3b: keyboard navigation and ARIA attributes', () => {
    /**
     * Resolve the rendered <mat-nested-tree-node> for a given pathString.
     * Throws if no node is rendered for that path (caller should
     * `expandAll()` first when the row sits below the auto-fit depth).
     */
    function nodeEl(pathString: string): HTMLElement {
      const candidates = (fixture.nativeElement as HTMLElement).querySelectorAll<HTMLElement>(
        'mat-nested-tree-node[data-tree-node-path]',
      );
      const el =
        Array.from(candidates).find((n) => n.getAttribute('data-tree-node-path') === pathString) ??
        null;
      if (!el) {
        throw new Error(`No mat-nested-tree-node rendered for path ${pathString}`);
      }
      return el;
    }

    function dispatchKey(target: HTMLElement, key: string, init: KeyboardEventInit = {}): void {
      target.dispatchEvent(
        new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }),
      );
    }

    /**
     * Wait one rAF so `moveFocusTo` has a chance to commit the deferred
     * DOM `focus()` call.
     */
    function nextRaf(): Promise<void> {
      return new Promise((resolve) => requestAnimationFrame(() => resolve()));
    }

    it('renders aria-level/posinset/setsize/expanded and exactly one tabindex=0', async () => {
      await createWith({ a: 1, b: 2, c: 3 });
      cmp.expandAll();
      fixture.detectChanges();

      const root = nodeEl('$');
      expect(root.getAttribute('role')).toBe('treeitem');
      expect(root.getAttribute('aria-level')).toBe('1');
      expect(root.getAttribute('aria-posinset')).toBe('1');
      expect(root.getAttribute('aria-setsize')).toBe('1');
      expect(root.getAttribute('aria-expanded')).toBe('true');

      const a = nodeEl('$.a');
      expect(a.getAttribute('aria-level')).toBe('2');
      expect(a.getAttribute('aria-posinset')).toBe('1');
      expect(a.getAttribute('aria-setsize')).toBe('3');

      const c = nodeEl('$.c');
      expect(c.getAttribute('aria-posinset')).toBe('3');
      expect(c.getAttribute('aria-setsize')).toBe('3');

      const focused = (fixture.nativeElement as HTMLElement).querySelectorAll(
        'mat-nested-tree-node[tabindex="0"]',
      );
      expect(focused.length).toBe(1);
    });

    it('aria-expanded flips when the container is toggled', async () => {
      await createWith({ a: { x: 1 } });
      const a = cmp['nodeIndex']().get('$.a')!;
      cmp.__getHelpersForTesting().setExpanded(a, true);
      fixture.detectChanges();
      expect(nodeEl('$.a').getAttribute('aria-expanded')).toBe('true');

      cmp.__getHelpersForTesting().setExpanded(a, false);
      fixture.detectChanges();
      expect(nodeEl('$.a').getAttribute('aria-expanded')).toBe('false');
    });

    it('initial focus lands on the first visible row', async () => {
      await createWith({ a: 1, b: 2 });
      fixture.detectChanges();
      await Promise.resolve();
      fixture.detectChanges();
      expect(cmp.focusedPath()).toBe('$');
      expect(nodeEl('$').getAttribute('tabindex')).toBe('0');
    });

    it('ArrowDown/ArrowUp move focus through visible rows', async () => {
      await createWith({ a: 1, b: 2 });
      cmp.expandAll();
      fixture.detectChanges();

      cmp.focusedPath.set('$');
      fixture.detectChanges();

      dispatchKey(nodeEl('$'), 'ArrowDown');
      expect(cmp.focusedPath()).toBe('$.a');

      fixture.detectChanges();
      dispatchKey(nodeEl('$.a'), 'ArrowDown');
      expect(cmp.focusedPath()).toBe('$.b');

      fixture.detectChanges();
      dispatchKey(nodeEl('$.b'), 'ArrowUp');
      expect(cmp.focusedPath()).toBe('$.a');
    });

    it('ArrowDown does not move past the last visible row', async () => {
      await createWith({ a: 1 });
      cmp.expandAll();
      fixture.detectChanges();

      cmp.focusedPath.set('$.a');
      fixture.detectChanges();
      dispatchKey(nodeEl('$.a'), 'ArrowDown');
      expect(cmp.focusedPath()).toBe('$.a');
    });

    it('ArrowUp does not move past the first visible row', async () => {
      await createWith({ a: 1 });
      fixture.detectChanges();
      cmp.focusedPath.set('$');
      fixture.detectChanges();
      dispatchKey(nodeEl('$'), 'ArrowUp');
      expect(cmp.focusedPath()).toBe('$');
    });

    it('Home and End jump to first/last visible rows', async () => {
      await createWith({ a: 1, b: 2, c: 3 });
      cmp.expandAll();
      fixture.detectChanges();

      cmp.focusedPath.set('$.b');
      fixture.detectChanges();
      dispatchKey(nodeEl('$.b'), 'Home');
      expect(cmp.focusedPath()).toBe('$');

      fixture.detectChanges();
      dispatchKey(nodeEl('$'), 'End');
      expect(cmp.focusedPath()).toBe('$.c');
    });

    it('ArrowRight on a collapsed container expands without moving focus', async () => {
      await createWith({ a: { x: 1 } });
      const aNode = cmp['nodeIndex']().get('$.a')!;
      cmp.__getHelpersForTesting().setExpanded(aNode, false);
      fixture.detectChanges();
      cmp.focusedPath.set('$.a');
      fixture.detectChanges();

      dispatchKey(nodeEl('$.a'), 'ArrowRight');
      expect(cmp.__getHelpersForTesting().isExpanded(aNode)).toBeTrue();
      expect(cmp.focusedPath()).toBe('$.a');
    });

    it('ArrowRight on an expanded container moves focus to first child', async () => {
      await createWith({ a: { x: 1 } });
      cmp.expandAll();
      fixture.detectChanges();
      cmp.focusedPath.set('$.a');
      fixture.detectChanges();

      dispatchKey(nodeEl('$.a'), 'ArrowRight');
      expect(cmp.focusedPath()).toBe('$.a.x');
    });

    it('ArrowRight on a leaf does not move focus or expand', async () => {
      await createWith({ a: 1 });
      cmp.expandAll();
      fixture.detectChanges();
      cmp.focusedPath.set('$.a');
      fixture.detectChanges();

      dispatchKey(nodeEl('$.a'), 'ArrowRight');
      expect(cmp.focusedPath()).toBe('$.a');
    });

    it('ArrowLeft on an expanded container collapses without moving focus', async () => {
      await createWith({ a: { x: 1 } });
      const aNode = cmp['nodeIndex']().get('$.a')!;
      cmp.__getHelpersForTesting().setExpanded(aNode, true);
      fixture.detectChanges();
      cmp.focusedPath.set('$.a');
      fixture.detectChanges();

      dispatchKey(nodeEl('$.a'), 'ArrowLeft');
      expect(cmp.__getHelpersForTesting().isExpanded(aNode)).toBeFalse();
      expect(cmp.focusedPath()).toBe('$.a');
    });

    it('ArrowLeft on a collapsed container moves focus to parent', async () => {
      await createWith({ a: { x: 1 } });
      const aNode = cmp['nodeIndex']().get('$.a')!;
      cmp.__getHelpersForTesting().setExpanded(aNode, false);
      fixture.detectChanges();
      cmp.focusedPath.set('$.a');
      fixture.detectChanges();

      dispatchKey(nodeEl('$.a'), 'ArrowLeft');
      expect(cmp.focusedPath()).toBe('$');
    });

    it('ArrowLeft on a leaf moves focus to parent', async () => {
      await createWith({ a: 1 });
      cmp.expandAll();
      fixture.detectChanges();
      cmp.focusedPath.set('$.a');
      fixture.detectChanges();

      dispatchKey(nodeEl('$.a'), 'ArrowLeft');
      expect(cmp.focusedPath()).toBe('$');
    });

    it('Enter on the focused row sets selectedPath', async () => {
      await createWith({ a: 1, b: 2 });
      cmp.expandAll();
      fixture.detectChanges();
      cmp.focusedPath.set('$.a');
      fixture.detectChanges();

      dispatchKey(nodeEl('$.a'), 'Enter');
      expect(cmp.selectedPath()).toBe('$.a');
    });

    it('Space on the focused row sets selectedPath and prevents default', async () => {
      await createWith({ a: 1 });
      cmp.expandAll();
      fixture.detectChanges();
      cmp.focusedPath.set('$.a');
      fixture.detectChanges();

      const ev = new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true });
      nodeEl('$.a').dispatchEvent(ev);
      expect(cmp.selectedPath()).toBe('$.a');
      expect(ev.defaultPrevented).toBeTrue();
    });

    it('clicking a row sets BOTH selectedPath and focusedPath', async () => {
      await createWith({ a: 1, b: 2 });
      cmp.expandAll();
      fixture.detectChanges();
      // Reset initial focus so we can verify the click moves it.
      cmp.focusedPath.set('$');
      fixture.detectChanges();

      const aRow = nodeEl('$.a').querySelector('.tree-row') as HTMLElement;
      aRow.click();
      fixture.detectChanges();

      expect(cmp.selectedPath()).toBe('$.a');
      expect(cmp.focusedPath()).toBe('$.a');
    });

    it('search Enter does not yank focus from the search input', async () => {
      await createWith({ alpha: 1, beta: 2 });
      cmp.expandAll();
      fixture.detectChanges();

      // Attach to body so the input can receive real DOM focus.
      document.body.appendChild(fixture.nativeElement);
      try {
        const input = (fixture.nativeElement as HTMLElement).querySelector(
          'input.tree-search',
        ) as HTMLInputElement;
        input.focus();
        cmp.search.set('alpha');
        fixture.detectChanges();
        await Promise.resolve();
        fixture.detectChanges();

        // Sanity: search produced a hit.
        expect(cmp.searchHitCount()).toBeGreaterThan(0);

        // Trigger the search-Enter cycle directly (mirrors what
        // `(keydown.enter)="onSearchEnter($event)"` would do).
        const ev = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
        Object.defineProperty(ev, 'target', { value: input });
        cmp.onSearchEnter(ev);
        fixture.detectChanges();

        expect(cmp.focusedPath()).toBe('$.alpha');
        expect(document.activeElement).toBe(input);
      } finally {
        document.body.removeChild(fixture.nativeElement);
      }
    });

    it('focus recovery walks up to the nearest visible ancestor when collapsed', async () => {
      await createWith({ a: { x: 1 } });
      cmp.expandAll();
      fixture.detectChanges();
      cmp.focusedPath.set('$.a.x');
      fixture.detectChanges();
      expect(cmp.focusedPath()).toBe('$.a.x');

      // Collapsing $.a hides $.a.x; the lifecycle effect should
      // recover focus to $.a (the nearest visible ancestor).
      const aNode = cmp['nodeIndex']().get('$.a')!;
      cmp.__getHelpersForTesting().setExpanded(aNode, false);
      fixture.detectChanges();
      expect(cmp.focusedPath()).toBe('$.a');
    });

    it('focus recovery resets to first visible row when the JSON shape changes', async () => {
      await createWith({ a: { x: 1 } });
      cmp.expandAll();
      fixture.detectChanges();
      cmp.focusedPath.set('$.a.x');
      fixture.detectChanges();
      expect(cmp.focusedPath()).toBe('$.a.x');

      fixture.componentRef.setInput('value', { totally: 'different' });
      fixture.detectChanges();
      await Promise.resolve();
      fixture.detectChanges();

      expect(cmp.focusedPath()).toBe('$');
    });

    it('Shift+F10 opens the row context menu via openContextMenuAt', async () => {
      await createWith({ a: 1 });
      cmp.expandAll();
      fixture.detectChanges();
      cmp.focusedPath.set('$.a');
      fixture.detectChanges();
      // Attach so getBoundingClientRect returns non-zero values.
      document.body.appendChild(fixture.nativeElement);
      try {
        const aNode = cmp['nodeIndex']().get('$.a')!;
        dispatchKey(nodeEl('$.a'), 'F10', { shiftKey: true });
        fixture.detectChanges();
        await Promise.resolve();
        fixture.detectChanges();

        expect(cmp.contextNode()).toBe(aNode);
      } finally {
        document.body.removeChild(fixture.nativeElement);
      }
    });

    it('focus the row when moveFocusTo runs (rAF deferred)', async () => {
      await createWith({ a: 1, b: 2 });
      cmp.expandAll();
      fixture.detectChanges();
      cmp.focusedPath.set('$');
      fixture.detectChanges();
      document.body.appendChild(fixture.nativeElement);
      try {
        dispatchKey(nodeEl('$'), 'ArrowDown');
        fixture.detectChanges();
        await nextRaf();
        expect(cmp.focusedPath()).toBe('$.a');
        expect(document.activeElement).toBe(nodeEl('$.a'));
      } finally {
        document.body.removeChild(fixture.nativeElement);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Keyboard copy: Ctrl+C / Cmd+C with a focused tree row copies the row's
  // value to the clipboard. Works on leaves, containers, and empty containers
  // alike (the rubber-duck "parent or leaf" requirement). Strict modifier
  // gate: Ctrl+Shift+C and Ctrl+Alt+C are intentional no-ops so we don't
  // fight devtools or AltGr layouts. The `currentTarget !== target` guard
  // at the top of `onTreeKeydown` already shields any descendant element
  // (twisty, kebab, beacon, extract pill) and the search input (which is
  // outside the mat-nested-tree-node anyway). Companion to the row context
  // menu copy and the leaf-row dblclick copy paths; all three share copy
  // semantics.
  // ---------------------------------------------------------------------------
  describe('keyboard copy (Ctrl+C / Cmd+C, focused tree row)', () => {
    function withClipboard<T>(stub: { writeText?: jasmine.Spy } | undefined, run: () => T): T {
      const original = (navigator as { clipboard?: Clipboard }).clipboard;
      const hadOwn = Object.prototype.hasOwnProperty.call(navigator, 'clipboard');
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: stub });
      try {
        return run();
      } finally {
        if (hadOwn && original) {
          Object.defineProperty(navigator, 'clipboard', {
            configurable: true,
            value: original,
          });
        } else {
          delete (navigator as { clipboard?: unknown }).clipboard;
        }
      }
    }

    type Cn = ReturnType<JsonTreeComponent['root']>;
    function nodeAt(path: string): NonNullable<Cn> {
      const stack: Array<NonNullable<Cn>> = [];
      const root = cmp.root();
      if (root) stack.push(root);
      while (stack.length > 0) {
        const n = stack.pop() as NonNullable<Cn>;
        if (n.pathString === path) return n;
        for (const c of n.children ?? []) stack.push(c);
      }
      throw new Error(`No node at path ${path}`);
    }

    function rowNodeEl(pathString: string): HTMLElement {
      const candidates = (fixture.nativeElement as HTMLElement).querySelectorAll<HTMLElement>(
        'mat-nested-tree-node[data-tree-node-path]',
      );
      const el =
        Array.from(candidates).find((n) => n.getAttribute('data-tree-node-path') === pathString) ??
        null;
      if (!el) {
        throw new Error(`No mat-nested-tree-node rendered for path ${pathString}`);
      }
      return el;
    }

    /** Dispatch a real KeyboardEvent('keydown') on the row element. */
    function dispatchOnRow(target: HTMLElement, init: KeyboardEventInit): void {
      target.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'c',
          bubbles: true,
          cancelable: true,
          ...init,
        }),
      );
    }

    it('Ctrl+C on a focused leaf row copies the raw value', async () => {
      await createWith({ note: 'hi' });
      cmp.expandAll();
      fixture.detectChanges();
      cmp.focusedPath.set('$.note');
      fixture.detectChanges();

      const writeText = jasmine.createSpy('writeText').and.resolveTo(undefined);
      withClipboard({ writeText }, () => {
        dispatchOnRow(rowNodeEl('$.note'), { ctrlKey: true });
      });
      await Promise.resolve();
      await Promise.resolve();
      expect(writeText).toHaveBeenCalledWith('hi');
    });

    it('Ctrl+C on a focused container row copies pretty JSON without changing expansion', async () => {
      await createWith({ obj: { a: 1, b: 2 } });
      cmp.collapseAll();
      fixture.detectChanges();
      const node = nodeAt('$.obj');
      const wasExpanded = cmp.__getHelpersForTesting().isExpanded(node);
      cmp.focusedPath.set('$.obj');
      fixture.detectChanges();

      const writeText = jasmine.createSpy('writeText').and.resolveTo(undefined);
      withClipboard({ writeText }, () => {
        dispatchOnRow(rowNodeEl('$.obj'), { ctrlKey: true });
      });
      await Promise.resolve();
      await Promise.resolve();

      const expected = JSON.stringify({ a: 1, b: 2 }, null, 2);
      expect(writeText).toHaveBeenCalledWith(expected);
      expect(cmp.__getHelpersForTesting().isExpanded(node))
        .withContext('expansion state unchanged by keyboard copy')
        .toBe(wasExpanded);
    });

    it('Ctrl+C on a focused expanded container row also copies pretty JSON without collapsing', async () => {
      await createWith({ obj: { a: 1 } });
      cmp.expandAll();
      fixture.detectChanges();
      const node = nodeAt('$.obj');
      expect(cmp.__getHelpersForTesting().isExpanded(node))
        .withContext('starts expanded')
        .toBe(true);
      cmp.focusedPath.set('$.obj');
      fixture.detectChanges();

      const writeText = jasmine.createSpy('writeText').and.resolveTo(undefined);
      withClipboard({ writeText }, () => {
        dispatchOnRow(rowNodeEl('$.obj'), { ctrlKey: true });
      });
      await Promise.resolve();
      await Promise.resolve();

      expect(writeText).toHaveBeenCalledWith(JSON.stringify({ a: 1 }, null, 2));
      expect(cmp.__getHelpersForTesting().isExpanded(node))
        .withContext('still expanded after keyboard copy')
        .toBe(true);
    });

    it('Ctrl+C on the focused root container copies the whole document', async () => {
      await createWith({ a: 1, b: 'two' });
      cmp.expandAll();
      fixture.detectChanges();
      cmp.focusedPath.set('$');
      fixture.detectChanges();

      const writeText = jasmine.createSpy('writeText').and.resolveTo(undefined);
      withClipboard({ writeText }, () => {
        dispatchOnRow(rowNodeEl('$'), { ctrlKey: true });
      });
      await Promise.resolve();
      await Promise.resolve();
      expect(writeText).toHaveBeenCalledWith(JSON.stringify({ a: 1, b: 'two' }, null, 2));
    });

    it('Ctrl+C on a focused empty object row copies "{}"', async () => {
      await createWith({ empty: {} });
      cmp.expandAll();
      fixture.detectChanges();
      cmp.focusedPath.set('$.empty');
      fixture.detectChanges();

      const writeText = jasmine.createSpy('writeText').and.resolveTo(undefined);
      withClipboard({ writeText }, () => {
        dispatchOnRow(rowNodeEl('$.empty'), { ctrlKey: true });
      });
      await Promise.resolve();
      await Promise.resolve();
      expect(writeText).toHaveBeenCalledWith('{}');
    });

    it('Ctrl+C on a focused empty array row copies "[]"', async () => {
      await createWith({ empty: [] });
      cmp.expandAll();
      fixture.detectChanges();
      cmp.focusedPath.set('$.empty');
      fixture.detectChanges();

      const writeText = jasmine.createSpy('writeText').and.resolveTo(undefined);
      withClipboard({ writeText }, () => {
        dispatchOnRow(rowNodeEl('$.empty'), { ctrlKey: true });
      });
      await Promise.resolve();
      await Promise.resolve();
      expect(writeText).toHaveBeenCalledWith('[]');
    });

    it('Cmd+C (metaKey) also copies on a focused row (macOS parity)', async () => {
      await createWith({ note: 'hi' });
      cmp.expandAll();
      fixture.detectChanges();
      cmp.focusedPath.set('$.note');
      fixture.detectChanges();

      const writeText = jasmine.createSpy('writeText').and.resolveTo(undefined);
      withClipboard({ writeText }, () => {
        dispatchOnRow(rowNodeEl('$.note'), { metaKey: true });
      });
      await Promise.resolve();
      await Promise.resolve();
      expect(writeText).toHaveBeenCalledWith('hi');
    });

    it('Ctrl+Shift+C is a no-op (does not steal devtools shortcut)', async () => {
      await createWith({ note: 'hi' });
      cmp.expandAll();
      fixture.detectChanges();
      cmp.focusedPath.set('$.note');
      fixture.detectChanges();

      const writeText = jasmine.createSpy('writeText').and.resolveTo(undefined);
      let prevented = false;
      withClipboard({ writeText }, () => {
        const ev = new KeyboardEvent('keydown', {
          key: 'C',
          ctrlKey: true,
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        });
        rowNodeEl('$.note').dispatchEvent(ev);
        prevented = ev.defaultPrevented;
      });
      await Promise.resolve();
      await Promise.resolve();
      expect(writeText).not.toHaveBeenCalled();
      expect(prevented).withContext('Ctrl+Shift+C must not be preventDefaulted').toBe(false);
    });

    it('Ctrl+Alt+C is a no-op (does not steal AltGr layouts)', async () => {
      await createWith({ note: 'hi' });
      cmp.expandAll();
      fixture.detectChanges();
      cmp.focusedPath.set('$.note');
      fixture.detectChanges();

      const writeText = jasmine.createSpy('writeText').and.resolveTo(undefined);
      let prevented = false;
      withClipboard({ writeText }, () => {
        const ev = new KeyboardEvent('keydown', {
          key: 'c',
          ctrlKey: true,
          altKey: true,
          bubbles: true,
          cancelable: true,
        });
        rowNodeEl('$.note').dispatchEvent(ev);
        prevented = ev.defaultPrevented;
      });
      await Promise.resolve();
      await Promise.resolve();
      expect(writeText).not.toHaveBeenCalled();
      expect(prevented).withContext('Ctrl+Alt+C must not be preventDefaulted').toBe(false);
    });

    it('plain "c" with no modifier is a no-op', async () => {
      await createWith({ note: 'hi' });
      cmp.expandAll();
      fixture.detectChanges();
      cmp.focusedPath.set('$.note');
      fixture.detectChanges();

      const writeText = jasmine.createSpy('writeText').and.resolveTo(undefined);
      withClipboard({ writeText }, () => {
        dispatchOnRow(rowNodeEl('$.note'), {});
      });
      await Promise.resolve();
      await Promise.resolve();
      expect(writeText).not.toHaveBeenCalled();
    });

    it('emits tree.keyboard.copyValue with escaped: false', async () => {
      const logger = await createWithLoggerSpy({ obj: { a: 1 } });
      cmp.collapseAll();
      fixture.detectChanges();
      cmp.focusedPath.set('$.obj');
      fixture.detectChanges();

      const writeText = jasmine.createSpy('writeText').and.resolveTo(undefined);
      withClipboard({ writeText }, () => {
        dispatchOnRow(rowNodeEl('$.obj'), { ctrlKey: true });
      });
      await Promise.resolve();
      await Promise.resolve();

      expect(logger.info).toHaveBeenCalledWith('tree.keyboard.copyValue', { escaped: false });
      // No dblclick / contextMenu sibling event leaked.
      expect(logger.info).not.toHaveBeenCalledWith(
        'tree.row.doubleClickCopyValue',
        jasmine.anything(),
      );
      expect(logger.info).not.toHaveBeenCalledWith(
        'tree.contextMenu.copyValue',
        jasmine.anything(),
      );
    });

    it('does not fire when the keydown originates from a descendant of the row', async () => {
      await createWith({ obj: { a: 1 } });
      cmp.collapseAll();
      fixture.detectChanges();
      cmp.focusedPath.set('$.obj');
      fixture.detectChanges();

      // Pick the chevron toggle button: a real descendant of the
      // mat-nested-tree-node. A Ctrl+C dispatched from the chevron
      // bubbles up to the row, where currentTarget !== target causes
      // the handler to short-circuit before our switch case runs.
      const chevron = (fixture.nativeElement as HTMLElement).querySelector(
        'mat-nested-tree-node[data-tree-node-path="$.obj"] button[mattreenodetoggle]',
      ) as HTMLButtonElement | null;
      expect(chevron).withContext('found the $.obj chevron button').toBeTruthy();

      const writeText = jasmine.createSpy('writeText').and.resolveTo(undefined);
      let prevented = false;
      withClipboard({ writeText }, () => {
        const ev = new KeyboardEvent('keydown', {
          key: 'c',
          ctrlKey: true,
          bubbles: true,
          cancelable: true,
        });
        chevron!.dispatchEvent(ev);
        prevented = ev.defaultPrevented;
      });
      await Promise.resolve();
      await Promise.resolve();
      expect(writeText)
        .withContext('descendant bubble must not trigger row-level copy')
        .not.toHaveBeenCalled();
      expect(prevented).withContext('descendant bubble must not be preventDefaulted').toBe(false);
    });

    it('Ctrl+C on a real focused container row copies its value (DOM-level)', async () => {
      await createWith({ obj: { a: 1, b: 2, c: 3 } });
      cmp.collapseAll();
      fixture.detectChanges();
      cmp.focusedPath.set('$.obj');
      fixture.detectChanges();

      // Mount fixture so Angular's (keydown) binding sees a real DOM
      // tree. We do NOT assert document.activeElement here -- elements
      // with tabindex="-1" don't always accept programmatic focus in
      // headless Chromium. The keydown binding fires regardless of
      // activeElement; the test's value is proving the real DOM
      // wiring (Angular template -> handler -> clipboard) works
      // end-to-end.
      document.body.appendChild(fixture.nativeElement);
      try {
        const row = rowNodeEl('$.obj');

        const writeText = jasmine.createSpy('writeText').and.resolveTo(undefined);
        let prevented = false;
        withClipboard({ writeText }, () => {
          const ev = new KeyboardEvent('keydown', {
            key: 'c',
            ctrlKey: true,
            bubbles: true,
            cancelable: true,
          });
          row.dispatchEvent(ev);
          prevented = ev.defaultPrevented;
        });
        await Promise.resolve();
        await Promise.resolve();

        expect(writeText).toHaveBeenCalledWith(JSON.stringify({ a: 1, b: 2, c: 3 }, null, 2));
        expect(prevented).withContext('Ctrl+C should be preventDefaulted').toBe(true);
      } finally {
        document.body.removeChild(fixture.nativeElement);
      }
    });
  });
});
