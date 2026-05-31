import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { MatSnackBar } from '@angular/material/snack-bar';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { attachFixtureToBody, expectNoStrictA11yViolations } from '../../../../testing/a11y';
import { provideFakeAuth } from '../../../../testing/auth.testing';
import { JsonTreeComponent } from './json-tree.component';

/**
 * M7g-3b structural accessibility spec for the JSON tree component.
 *
 * Covers the WAI-ARIA Tree pattern that Wave 3b lands (audit findings
 * F2.1-F2.3):
 *   - role="tree" on the `<cdk-virtual-scroll-viewport>` plus aria-label;
 *   - role="treeitem" on every `.tree-row` (Phase 2 issue #95 moved
 *     this from `<mat-nested-tree-node>` when virtualization replaced
 *     the Material tree); close-brace rows stay role="presentation";
 *   - aria-level / aria-posinset / aria-setsize / aria-expanded on
 *     each tree node;
 *   - roving tabindex (exactly one node tabindex="0").
 *
 * Wave 3d re-enables the strict axe gate in both themes after the tree
 * token palette and embedded breadcrumb contrast fixes landed.
 */
describe('JsonTreeComponent (a11y)', () => {
  const REPRESENTATIVE_VALUE = {
    name: 'Alice',
    age: 30,
    active: true,
    missing: null,
    tags: ['ops', 'oncall'],
    profile: { id: 'a-1', verified: true },
  };

  let teardown: (() => void) | undefined;

  async function configure(): Promise<ComponentFixture<JsonTreeComponent>> {
    TestBed.resetTestingModule();
    await TestBed.configureTestingModule({
      imports: [JsonTreeComponent],
      providers: [
        ...provideFakeAuth(),
        provideNoopAnimations(),
        { provide: MatSnackBar, useValue: { open: vi.fn() } },
      ],
    }).compileComponents();
    const fixture = TestBed.createComponent(JsonTreeComponent);
    fixture.componentRef.setInput('value', REPRESENTATIVE_VALUE);
    // Phase 2 (issue #95) -- the CDK virtual scroll viewport needs an
    // explicitly-sized parent (it queries `clientHeight` synchronously
    // during `ngAfterViewInit` to compute the rendered row range).
    // `attachFixtureToBody` wraps the host in `min-height: 100vh` which
    // does NOT propagate as a definite height to the JsonTree host's
    // flex children; without explicit pixel dimensions the viewport
    // measures as zero and renders zero rows.
    const host = fixture.nativeElement as HTMLElement;
    host.style.height = '600px';
    host.style.width = '1000px';
    return fixture;
  }

  /**
   * Drains the CDK virtual scroll viewport's measurement + render
   * microtask chain. The viewport schedules its initial `_setRenderedRange`
   * via `Promise.resolve().then(...)`; two microtask awaits + a final
   * `detectChanges` is the minimum to surface the rendered rows in the DOM.
   */
  async function drainViewport(fixture: ComponentFixture<JsonTreeComponent>): Promise<void> {
    fixture.detectChanges();
    fixture.componentInstance.expandAll();
    fixture.detectChanges();
    await Promise.resolve();
    await Promise.resolve();
    fixture.detectChanges();
  }

  afterEach(() => {
    teardown?.();
    teardown = undefined;
  });

  it('exposes the WAI-ARIA Tree role chain (tree -> treeitem -> group)', async () => {
    const fixture = await configure();
    teardown = attachFixtureToBody(fixture, 'dark');
    await drainViewport(fixture);

    const host = fixture.nativeElement as HTMLElement;
    const tree = host.querySelector('cdk-virtual-scroll-viewport[role="tree"]');
    expect(tree, 'the virtual scroll viewport should carry role="tree"').toBeTruthy();
    expect(
      tree?.getAttribute('aria-label'),
      'the tree must have an aria-label so AT can announce it',
    ).toBeTruthy();

    const treeitems = host.querySelectorAll('.tree-row[role="treeitem"]');
    expect(
      treeitems.length,
      'every `.tree-row` (open + leaf) should carry role="treeitem"',
    ).toBeGreaterThan(0);

    // The synthetic close-brace row stays role="presentation".
    const closeRows = host.querySelectorAll('.tree-row--close[role="presentation"]');
    expect(closeRows.length, 'every close-brace row should be role="presentation"').toBeGreaterThan(
      0,
    );
  });

  it('has exactly one tabindex="0" tree node (roving focus invariant)', async () => {
    const fixture = await configure();
    teardown = attachFixtureToBody(fixture, 'dark');
    await drainViewport(fixture);

    const focused = (fixture.nativeElement as HTMLElement).querySelectorAll(
      '.tree-row[tabindex="0"]',
    );
    expect(focused.length).toBe(1);
  });

  it('snaps focusedPath into the rendered range when the user scrolls the focused row offscreen', async () => {
    // Phase 2 (issue #95) -- with `<mat-tree>` every row was in the
    // DOM, so the focused row always had `tabindex="0"`. With CDK
    // virtual scroll, only rows in the rendered window are in the
    // DOM; if `focusedPath` points to an offscreen row, no element
    // has `tabindex="0"` and Tab-into-tree-from-outside skips the
    // tree entirely. The component subscribes to the viewport's
    // `renderedRangeStream` and snaps `focusedPath` to the top of
    // the rendered window when the focused row falls outside it.
    //
    // Use a large enough value that the viewport can't render every
    // row at once (600px host height, ~24px row height -> ~25 rows
    // can fit; we build a 150-key object so scroll definitely moves
    // rows out of the rendered range).
    const largeValue: Record<string, number> = {};
    for (let i = 0; i < 150; i++) largeValue[`key_${String(i).padStart(3, '0')}`] = i;

    TestBed.resetTestingModule();
    await TestBed.configureTestingModule({
      imports: [JsonTreeComponent],
      providers: [
        ...provideFakeAuth(),
        provideNoopAnimations(),
        { provide: MatSnackBar, useValue: { open: vi.fn() } },
      ],
    }).compileComponents();
    const fixture = TestBed.createComponent(JsonTreeComponent);
    fixture.componentRef.setInput('value', largeValue);
    const host = fixture.nativeElement as HTMLElement;
    host.style.height = '600px';
    host.style.width = '1000px';
    teardown = attachFixtureToBody(fixture, 'dark');
    await drainViewport(fixture);

    // Confirm only a window is rendered (virtualization is actually on).
    const renderedRows = host.querySelectorAll('.tree-row[role="treeitem"]');
    expect(
      renderedRows.length,
      'virtualization should render fewer rows than the 150-key object',
    ).toBeLessThan(150);

    // Sanity: a single tabindex=0 lives on the first visible row.
    const initialFocused = host.querySelector('.tree-row[tabindex="0"]');
    expect(
      initialFocused,
      'roving-tabindex invariant: exactly one tabindex=0 on mount',
    ).toBeTruthy();
    const initialFocusedPath = initialFocused?.getAttribute('data-path') ?? null;
    expect(initialFocusedPath, 'focused row should have a data-path').toBeTruthy();

    // Scroll far enough that the originally-focused row leaves the rendered window.
    const cmp = fixture.componentInstance;
    const viewport = cmp.__getHelpersForTesting().getViewport();
    expect(viewport, 'viewport view-child should be resolved').toBeTruthy();
    viewport!.scrollToOffset(2000, 'auto');
    // Belt + suspenders: in some test orderings the scroll-listener
    // attached by CDK's `FixedSizeVirtualScrollStrategy` doesn't fire
    // a synthetic scroll event when `scrollToOffset` mutates scrollTop
    // synchronously. Dispatching an explicit `scroll` event on the
    // viewport's scrollable host kicks the strategy into recomputing
    // its range so `renderedRangeStream` fires reliably in headless
    // Karma runs.
    viewport!.elementRef.nativeElement.dispatchEvent(new Event('scroll'));
    viewport!.checkViewportSize();

    const nextDoubleRaf = (): Promise<void> =>
      new Promise((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      });

    // Drain: two double-rAFs + microtasks + change detection to let
    // CDK's scroll-strategy compute a new `renderedRangeStream` value,
    // the component's subscribe write `renderedRange`, the effect fire,
    // and the resulting `focusedPath` change paint the DOM tabindex.
    await nextDoubleRaf();
    fixture.detectChanges();
    await Promise.resolve();
    await Promise.resolve();
    fixture.detectChanges();
    await nextDoubleRaf();
    fixture.detectChanges();

    // After scroll: focusedPath should have snapped to a row that is
    // currently rendered (otherwise no element has tabindex=0).
    const afterScrollFocused = host.querySelectorAll('.tree-row[tabindex="0"]');
    expect(
      afterScrollFocused.length,
      'exactly one tabindex=0 should still live in the DOM after scroll',
    ).toBe(1);

    // The snapped path should NOT be the originally-focused row's path
    // (it's offscreen now), and it MUST appear among the currently-rendered rows.
    const snappedPath = afterScrollFocused[0]!.getAttribute('data-path');
    expect(snappedPath, 'focused path must change when the original row is scrolled out').not.toBe(
      initialFocusedPath,
    );
    const allRenderedPaths = Array.from(host.querySelectorAll('.tree-row[role="treeitem"]')).map(
      (el) => el.getAttribute('data-path'),
    );
    expect(
      allRenderedPaths,
      'snapped focusedPath must point to a row currently in the rendered range',
    ).toContain(snappedPath);
  });

  it('snaps focusedPath into the rendered range when a programmatic expansion shifts the focused row past renderedRange.end', async () => {
    // Phase 2 round 2 (issue #95, PR #236 follow-up) -- the snap
    // effect must fire on flatList / visibleIndexByPath changes
    // (not just renderedRange changes) to defend the roving-tabindex
    // invariant when expansion shifts the focused row's index past
    // the rendered window without scrolling.
    //
    // Round 1's plan would have untracked all three deps; the
    // skeptic flagged that this would silently regress this case
    // (expansion above the focused row leaves scrollTop unchanged,
    // so the renderedRange-only snap from round 1 would never fire).
    // The locked fix keeps flatList / renderedRange / visibleIndexByPath
    // tracked and only untracks the focusedPath READ.

    // Build a tree where one container at the top alphabetically
    // precedes a long list of leaves. We expandAll(), then collapse
    // aaa_container explicitly so flatList = [root, aaa_container,
    // leaf_001, ..., leaf_100]. Re-expanding aaa_container later
    // pushes every leaf forward by ~100 rows.
    const largeValue: Record<string, unknown> = {};
    largeValue['aaa_container'] = {};
    const container = largeValue['aaa_container'] as Record<string, number>;
    for (let i = 0; i < 100; i++) container[`child_${String(i).padStart(3, '0')}`] = i;
    for (let i = 0; i < 100; i++) largeValue[`leaf_${String(i).padStart(3, '0')}`] = i;

    TestBed.resetTestingModule();
    await TestBed.configureTestingModule({
      imports: [JsonTreeComponent],
      providers: [
        ...provideFakeAuth(),
        provideNoopAnimations(),
        { provide: MatSnackBar, useValue: { open: vi.fn() } },
      ],
    }).compileComponents();
    const fixture = TestBed.createComponent(JsonTreeComponent);
    fixture.componentRef.setInput('value', largeValue);
    const host = fixture.nativeElement as HTMLElement;
    host.style.height = '600px';
    host.style.width = '1000px';
    teardown = attachFixtureToBody(fixture, 'dark');

    // expandAll() so every node is in flatList, then collapse the
    // big container explicitly so its 100 children are NOT in flatList.
    await drainViewport(fixture);
    const cmp = fixture.componentInstance;
    const helpers = cmp.__getHelpersForTesting();

    const containerNode = helpers.findNode((n) => n.pathString === '$.aaa_container');
    expect(containerNode, 'aaa_container should exist after expandAll').toBeTruthy();
    helpers.setExpanded(containerNode!, false);
    fixture.detectChanges();
    await Promise.resolve();
    await Promise.resolve();
    fixture.detectChanges();

    // Focus a leaf that is currently in the rendered window.
    const targetPath = '$.leaf_005';
    const targetNode = helpers.findNode((n) => n.pathString === targetPath);
    expect(targetNode, 'leaf_005 should exist in the tree').toBeTruthy();
    // `onSelect` early-returns when `event.target` is not an Element.
    // Use a real MouseEvent with the row element as target so the
    // click flow exercises `focusedPath.set(node.pathString)`.
    const leafRow = host.querySelector(
      `.tree-row[data-path="${targetPath.replace(/\./g, '\\.').replace(/\$/g, '\\$')}"]`,
    );
    expect(leafRow, 'leaf_005 row should be rendered before we click it').toBeTruthy();
    const fakeClick = new MouseEvent('click', { bubbles: true });
    Object.defineProperty(fakeClick, 'target', { value: leafRow, configurable: true });
    cmp.onSelect(targetNode!, fakeClick);
    fixture.detectChanges();
    await Promise.resolve();
    fixture.detectChanges();

    const beforeExpansionFocused = host.querySelector('.tree-row[tabindex="0"]');
    expect(
      beforeExpansionFocused?.getAttribute('data-path'),
      'focusedPath should be on leaf_005 after onSelect',
    ).toBe(targetPath);

    // Re-expand aaa_container. flatList grows by 100 rows inserted
    // BEFORE leaf_005, pushing leaf_005's flat index outside the
    // rendered range. scrollTop is unchanged, so renderedRange stays
    // anchored at the top; the snap effect must move focusedPath
    // back into the visible window.
    helpers.setExpanded(containerNode!, true);

    const nextDoubleRaf = (): Promise<void> =>
      new Promise((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      });

    await nextDoubleRaf();
    fixture.detectChanges();
    await Promise.resolve();
    await Promise.resolve();
    fixture.detectChanges();
    await nextDoubleRaf();
    fixture.detectChanges();

    // Snap invariant: exactly one tabindex=0 in the DOM after expansion.
    const afterExpansionFocused = host.querySelectorAll('.tree-row[tabindex="0"]');
    expect(
      afterExpansionFocused.length,
      'exactly one tabindex=0 should still live in the DOM after a programmatic expansion shifts the focused row past renderedRange.end',
    ).toBe(1);

    // The snapped focused path must point to a row that is currently
    // in the rendered range -- NOT the original leaf_005 (now offscreen).
    const snappedPath = afterExpansionFocused[0]!.getAttribute('data-path');
    expect(
      snappedPath,
      'focused path must change when the original row is pushed offscreen by expansion',
    ).not.toBe(targetPath);
    const allRenderedPaths = Array.from(host.querySelectorAll('.tree-row[role="treeitem"]')).map(
      (el) => el.getAttribute('data-path'),
    );
    expect(
      allRenderedPaths,
      'snapped focusedPath must point to a row currently in the rendered range',
    ).toContain(snappedPath);
  });

  it('scrolls the viewport and focuses the target when keyboard nav targets an unmounted row', async () => {
    // Phase 2 round 2 (issue #95, PR #236 follow-up) -- moveFocusTo
    // must scroll the viewport when the target row is unmounted, then
    // focus the row after CDK materializes it. With `<mat-tree>`,
    // `el?.scrollIntoView({behavior:'smooth'})` worked because every
    // row was in the DOM; with CDK virtual scroll, `el` is `null` when
    // the row is outside the rendered window, and the no-op silently
    // breaks keyboard nav (e.g., End key past the rendered range).
    //
    // The fix: when the row is unmounted, call `viewport.scrollToIndex`
    // and subscribe to `renderedRangeStream` for the target index to
    // land in range, then focus inside an inner rAF.

    const largeValue: Record<string, number> = {};
    for (let i = 0; i < 150; i++) largeValue[`key_${String(i).padStart(3, '0')}`] = i;

    TestBed.resetTestingModule();
    await TestBed.configureTestingModule({
      imports: [JsonTreeComponent],
      providers: [
        ...provideFakeAuth(),
        provideNoopAnimations(),
        { provide: MatSnackBar, useValue: { open: vi.fn() } },
      ],
    }).compileComponents();
    const fixture = TestBed.createComponent(JsonTreeComponent);
    fixture.componentRef.setInput('value', largeValue);
    const host = fixture.nativeElement as HTMLElement;
    host.style.height = '600px';
    host.style.width = '1000px';
    teardown = attachFixtureToBody(fixture, 'dark');
    await drainViewport(fixture);

    const cmp = fixture.componentInstance;
    const helpers = cmp.__getHelpersForTesting();
    const viewport = helpers.getViewport();
    expect(viewport, 'viewport view-child should be resolved').toBeTruthy();

    const initialScrollOffset = viewport!.measureScrollOffset();
    expect(
      initialScrollOffset,
      'test pre-condition: viewport should start scrolled to the top',
    ).toBe(0);

    // Confirm the last key is currently NOT rendered (virtualization
    // is actually limiting the DOM to a window).
    const lastKeyPath = '$.key_149';
    const renderedBefore = Array.from(host.querySelectorAll('.tree-row[role="treeitem"]')).map(
      (el) => el.getAttribute('data-path'),
    );
    expect(
      renderedBefore,
      'test pre-condition: last key should not be rendered before End is pressed',
    ).not.toContain(lastKeyPath);

    // Get the currently-focused node (whichever row has tabindex=0,
    // which `drainViewport` left at the first visible row).
    const initialFocused = host.querySelector('.tree-row[tabindex="0"]');
    expect(initialFocused, 'a row should hold focus before End is pressed').toBeTruthy();
    const initialFocusedPath = initialFocused!.getAttribute('data-path')!;
    const initialFocusedNode = helpers.findNode((n) => n.pathString === initialFocusedPath);
    expect(initialFocusedNode, 'initial focused node should resolve via findNode').toBeTruthy();

    // Dispatch the End key by calling the row-level keydown handler
    // directly. We can't `host.dispatchEvent` because the @HostBinding
    // is per-row (the template wires `(keydown)="onTreeKeydown($event, node)"`
    // on each `.tree-row`, not on the component host).
    const endEvent = new KeyboardEvent('keydown', { key: 'End', bubbles: true });
    cmp.onTreeKeydown(endEvent, initialFocusedNode!);

    const nextDoubleRaf = (): Promise<void> =>
      new Promise((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      });

    // Drain the moveFocusTo flow:
    //   1. The outer rAF in moveFocusTo runs (querySelector returns null
    //      because the target row is unmounted).
    //   2. viewport.scrollToIndex fires; CDK schedules a synthetic scroll.
    //   3. The renderedRangeStream emits with the target index in range.
    //   4. The inner rAF runs; querySelector now finds the row; focus().
    // Belt + suspenders: dispatch a synthetic scroll event so the strategy
    // recomputes its range deterministically in headless Karma.
    await nextDoubleRaf();
    viewport!.elementRef.nativeElement.dispatchEvent(new Event('scroll'));
    viewport!.checkViewportSize();
    fixture.detectChanges();
    await Promise.resolve();
    await Promise.resolve();
    fixture.detectChanges();
    await nextDoubleRaf();
    fixture.detectChanges();
    await nextDoubleRaf();
    fixture.detectChanges();

    // Viewport actually scrolled.
    const afterScrollOffset = viewport!.measureScrollOffset();
    expect(
      afterScrollOffset,
      'viewport.scrollToIndex should have moved scrollTop past zero',
    ).toBeGreaterThan(0);

    // The previously-unmounted last key is now rendered AND has tabindex="0".
    const focusedRows = host.querySelectorAll('.tree-row[tabindex="0"]');
    expect(focusedRows.length, 'exactly one tabindex=0 after End targets an unmounted row').toBe(1);
    expect(
      focusedRows[0]!.getAttribute('data-path'),
      'focused row should be the End-key target (last visible row)',
    ).toBe(lastKeyPath);
  });

  it('has no critical or serious WCAG 2.1 AA violations (dark theme)', async () => {
    const fixture = await configure();
    teardown = attachFixtureToBody(fixture, 'dark');
    await drainViewport(fixture);

    await expectNoStrictA11yViolations(fixture, { skipWhenStable: true });
  });

  it('has no critical or serious WCAG 2.1 AA violations (light theme)', async () => {
    const fixture = await configure();
    teardown = attachFixtureToBody(fixture, 'light');
    await drainViewport(fixture);

    await expectNoStrictA11yViolations(fixture, { skipWhenStable: true });
  });
});
