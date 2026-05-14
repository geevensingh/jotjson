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
        { provide: MatSnackBar, useValue: { open: jasmine.createSpy('snackOpen') } },
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
    expect(tree).withContext('the virtual scroll viewport should carry role="tree"').toBeTruthy();
    expect(tree?.getAttribute('aria-label'))
      .withContext('the tree must have an aria-label so AT can announce it')
      .toBeTruthy();

    const treeitems = host.querySelectorAll('.tree-row[role="treeitem"]');
    expect(treeitems.length)
      .withContext('every `.tree-row` (open + leaf) should carry role="treeitem"')
      .toBeGreaterThan(0);

    // The synthetic close-brace row stays role="presentation".
    const closeRows = host.querySelectorAll('.tree-row--close[role="presentation"]');
    expect(closeRows.length)
      .withContext('every close-brace row should be role="presentation"')
      .toBeGreaterThan(0);
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
        { provide: MatSnackBar, useValue: { open: jasmine.createSpy('snackOpen') } },
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
    expect(renderedRows.length)
      .withContext('virtualization should render fewer rows than the 150-key object')
      .toBeLessThan(150);

    // Sanity: a single tabindex=0 lives on the first visible row.
    const initialFocused = host.querySelector('.tree-row[tabindex="0"]');
    expect(initialFocused)
      .withContext('roving-tabindex invariant: exactly one tabindex=0 on mount')
      .toBeTruthy();
    const initialFocusedPath = initialFocused?.getAttribute('data-path') ?? null;
    expect(initialFocusedPath).withContext('focused row should have a data-path').toBeTruthy();

    // Scroll far enough that the originally-focused row leaves the rendered window.
    const cmp = fixture.componentInstance;
    const viewport = cmp.__getHelpersForTesting().getViewport();
    expect(viewport).withContext('viewport view-child should be resolved').toBeTruthy();
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
    expect(afterScrollFocused.length)
      .withContext('exactly one tabindex=0 should still live in the DOM after scroll')
      .toBe(1);

    // The snapped path should NOT be the originally-focused row's path
    // (it's offscreen now), and it MUST appear among the currently-rendered rows.
    const snappedPath = afterScrollFocused[0]!.getAttribute('data-path');
    expect(snappedPath)
      .withContext('focused path must change when the original row is scrolled out')
      .not.toBe(initialFocusedPath);
    const allRenderedPaths = Array.from(host.querySelectorAll('.tree-row[role="treeitem"]')).map(
      (el) => el.getAttribute('data-path'),
    );
    expect(allRenderedPaths)
      .withContext('snapped focusedPath must point to a row currently in the rendered range')
      .toContain(snappedPath);
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
