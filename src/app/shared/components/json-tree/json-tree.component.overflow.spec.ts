import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { MatSnackBar } from '@angular/material/snack-bar';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { attachFixtureToBody } from '../../../../testing/a11y';
import { provideFakeAuth } from '../../../../testing/auth.testing';
import { JsonTreeComponent } from './json-tree.component';

/**
 * v0.21.1 hotfix regression spec for tree row width overflow.
 *
 * Reproduces the bug surfaced by https://jotjson.com/s/HiZ2qI: a row
 * whose value's natural single-line render is much wider than the
 * panel pushed the whole tree past its container, breaking the
 * Phase-2 single-line ellipsify contract declared in DESIGN_SPEC.md
 * v0.21.0 ("long values truncate with an ellipsis and reveal the
 * full string on hover instead of wrapping").
 *
 * Root cause was the CDK-internal
 * `cdk-virtual-scroll-content-wrapper`: CDK styles it
 * `position: absolute; min-width: 100%; width: auto`, so it
 * shrink-to-fits to the widest row and `.tree-row` sees an
 * effectively-unbounded containing block. Fix: pin the wrapper at
 * `width: 100%` via a `:host ::ng-deep .tree-viewport` rule in
 * `json-tree.component.scss`. See the commentary at the rule itself
 * for the full explanation.
 *
 * Mounting strategy: the host is sized at mount (NOT resize-after-
 * render) so we don't depend on `ResizeObserver` callback timing.
 * The four assertions are intentionally layered so any future
 * regression in any layer surfaces independently:
 *   1. Sanity: the value's natural single-line width is far wider
 *      than the panel (proves we're actually exercising the bug).
 *   2. Wrapper constrained: the load-bearing assertion that the
 *      `:host ::ng-deep ... { width: 100% }` rule is in effect.
 *   3. No horizontal scrollbar at the viewport: the user-visible
 *      symptom we're regressing-protecting.
 *   4. CDK class still exists: defends against a future Angular CDK
 *      upgrade silently renaming `cdk-virtual-scroll-content-wrapper`
 *      and our SCSS selector becoming a no-op.
 */
describe('JsonTreeComponent (row-width overflow)', () => {
  let teardown: (() => void) | undefined;
  let fixtureValue: unknown;

  beforeAll(async () => {
    const response = await fetch('/fixtures/LongUnbreakableValue.json');
    if (!response.ok) {
      throw new Error(
        `Failed to load fixtures/LongUnbreakableValue.json: HTTP ${response.status}. ` +
          `Ensure src/testing/fixtures is registered in angular.json test assets.`,
      );
    }
    fixtureValue = JSON.parse(await response.text());
  });

  async function configure(panelWidthPx: number): Promise<ComponentFixture<JsonTreeComponent>> {
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
    fixture.componentRef.setInput('value', fixtureValue);

    // Phase 2 (issue #95) -- the CDK virtual scroll viewport queries
    // its parent's `clientHeight` synchronously during
    // `ngAfterViewInit`. Without explicit pixel dimensions on the
    // host the viewport measures zero and renders zero rows.
    // Sizing AT mount (rather than after `detectChanges`) means the
    // first `OverflowDetectorDirective.afterNextRender` measurement
    // already runs at the constrained size, so we never depend on
    // ResizeObserver callback timing (no test seam for that).
    const host = fixture.nativeElement as HTMLElement;
    host.style.height = '600px';
    host.style.width = `${panelWidthPx}px`;
    return fixture;
  }

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

  it('constrains the cdk-virtual-scroll-content-wrapper to the viewport width when a row value is much wider', async () => {
    const PANEL_WIDTH_PX = 400;
    const fixture = await configure(PANEL_WIDTH_PX);
    teardown = attachFixtureToBody(fixture, 'dark');
    await drainViewport(fixture);

    const host = fixture.nativeElement as HTMLElement;
    const viewport = host.querySelector<HTMLElement>('.tree-viewport');
    expect(viewport)
      .withContext('the cdk-virtual-scroll-viewport with class .tree-viewport must render')
      .toBeTruthy();

    const wrapper = host.querySelector<HTMLElement>('.cdk-virtual-scroll-content-wrapper');
    // Assertion 4: the CDK internal class our SCSS selector targets
    // must still exist. A future Angular CDK upgrade that renames
    // this class would silently regress the fix; this assertion
    // catches that in CI.
    expect(wrapper)
      .withContext(
        'the CDK-internal .cdk-virtual-scroll-content-wrapper element must still exist (the v0.21.1 fix in json-tree.component.scss targets it)',
      )
      .toBeTruthy();

    // Find the widest .tree-value-string cell in the rendered DOM.
    // The fixture's `Parameters[0].Value` is a JSON-escape-laden
    // ~800-char string with an embedded long URL token; its
    // single-line natural width far exceeds 400px.
    const valueCells = Array.from(host.querySelectorAll<HTMLElement>('.tree-value-string'));
    expect(valueCells.length)
      .withContext('expandAll should surface at least one string-value cell from the fixture')
      .toBeGreaterThan(0);
    const widestCell = valueCells.reduce((widest, cell) =>
      cell.scrollWidth > widest.scrollWidth ? cell : widest,
    );

    // Assertion 1 (precondition): the cell's natural single-line
    // width is at least 2x the panel. If a future fixture edit
    // makes the value short enough to fit, this assertion fails
    // loudly and we know the test stopped exercising the bug
    // class -- rather than passing by coincidence.
    expect(widestCell.scrollWidth)
      .withContext(
        `precondition: the widest .tree-value-string's natural width (scrollWidth=${widestCell.scrollWidth}) must be at least 2x the panel width (${PANEL_WIDTH_PX}px) so we know the test is actually exercising the row-overflow bug; if this fails, edit fixtures/LongUnbreakableValue.json to restore a long unbreakable value`,
      )
      .toBeGreaterThanOrEqual(2 * PANEL_WIDTH_PX);

    // Assertion 2 (load-bearing): the wrapper is pinned to the
    // viewport's clientWidth (1px tolerance for sub-pixel rounding
    // in headless Chromium).
    const viewportWidth = viewport!.clientWidth;
    expect(wrapper!.clientWidth)
      .withContext(
        `wrapper.clientWidth (${wrapper!.clientWidth}) must be <= viewport.clientWidth (${viewportWidth}) + 1; without the v0.21.1 SCSS fix, the wrapper grows to the widest row's max-content`,
      )
      .toBeLessThanOrEqual(viewportWidth + 1);

    // Assertion 3 (user-visible symptom): the viewport itself
    // doesn't show a horizontal scrollbar. Pre-fix, the viewport's
    // scrollWidth would exceed clientWidth and the user would see
    // a horizontal scrollbar across the entire tree panel.
    expect(viewport!.scrollWidth)
      .withContext(
        `viewport.scrollWidth (${viewport!.scrollWidth}) must be <= viewport.clientWidth (${viewportWidth}) + 1; if this fails the user sees a horizontal scrollbar on the tree (https://jotjson.com/s/HiZ2qI was the live repro for v0.21.0)`,
      )
      .toBeLessThanOrEqual(viewportWidth + 1);
  });
});
