import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { MatSnackBar } from '@angular/material/snack-bar';
import { MatTooltip } from '@angular/material/tooltip';
import { By } from '@angular/platform-browser';
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

  /**
   * v0.23.1 hotfix regression assertions (twisty alignment + tooltip
   * width). Same fixture, same panel width. The four new tests are
   * sibling `it` cases within this describe so they share the
   * pre-mount sizing pattern and `attachFixtureToBody` lifecycle.
   *
   * Bug A (twisty alignment): the v0.21.1 `.tree-row > * { min-width:
   * 0 }` cascade let every unmarked flex child of `.tree-row` shrink
   * under content pressure. `.tree-twisty` (intrinsic `width: 1.1em`,
   * default `flex-shrink: 1`) was the visible victim -- its
   * placeholder spacer on a long-value row shrunk from 14.3px to
   * 0.91px, shifting `.tree-key` ~13px left of sibling rows.
   *
   * Bug B (tooltip width): Material 21 hardcodes
   * `.mdc-tooltip__surface { max-width: 200px; word-break: normal;
   * white-space: normal; }`, producing a 200x320 vertical column for
   * a 1024-char value-string tooltip. No `--mat-tooltip-max-width`
   * token exists, so we override via `matTooltipClass="jj-tooltip-wide"`
   * scoped to a global rule in `src/styles/_material.scss`. The
   * Material-21 binding lands `matTooltipClass` on the INNER
   * `.mat-mdc-tooltip` div (not the outer cdk-overlay pane), so the
   * selector targets `.mat-mdc-tooltip.jj-tooltip-wide
   * .mdc-tooltip__surface`. The fourth assertion below guards that
   * selector against silent regressions.
   */

  it('v0.23.1: keeps the twisty spacer at its natural width when the row has a much-wider value sibling', async () => {
    const PANEL_WIDTH_PX = 400;
    const fixture = await configure(PANEL_WIDTH_PX);
    teardown = attachFixtureToBody(fixture, 'dark');
    await drainViewport(fixture);

    const host = fixture.nativeElement as HTMLElement;
    const row = host.querySelector<HTMLElement>('[data-path="$.Parameters[0].Value"]');
    expect(row).withContext('overflowing leaf row must render').not.toBeNull();
    const twisty = row!.querySelector<HTMLElement>('.tree-twisty');
    expect(twisty).withContext('leaf row must render a .tree-twisty spacer').not.toBeNull();

    // Twisty's intrinsic width is 1.1em at the tree's font size
    // (~14.3px at the default 13px font). Pre-v0.23.1 it shrunk to
    // ~0.91px under flex pressure from the long .tree-value-string
    // because .tree-twisty was missing `flex-shrink: 0` and the
    // v0.21.1 `.tree-row > * { min-width: 0 }` rule allowed
    // shrinkage below intrinsic.
    const twistyWidth = twisty!.getBoundingClientRect().width;
    expect(twistyWidth)
      .withContext(
        `twisty.width=${twistyWidth.toFixed(2)}; pre-v0.23.1 it shrunk to ~0.91px on overflow rows because .tree-twisty was missing flex-shrink:0`,
      )
      .toBeGreaterThanOrEqual(13);
  });

  it('v0.23.1: aligns the .tree-key X-position against padding-left + twisty width on an overflowing row', async () => {
    const PANEL_WIDTH_PX = 400;
    const fixture = await configure(PANEL_WIDTH_PX);
    teardown = attachFixtureToBody(fixture, 'dark');
    await drainViewport(fixture);

    const host = fixture.nativeElement as HTMLElement;
    const row = host.querySelector<HTMLElement>('[data-path="$.Parameters[0].Value"]');
    expect(row).not.toBeNull();
    const twisty = row!.querySelector<HTMLElement>('.tree-twisty');
    const key = row!.querySelector<HTMLElement>('.tree-key');
    expect(twisty).not.toBeNull();
    expect(key).withContext('leaf row must render a .tree-key').not.toBeNull();

    // Invariant: keyLeft - rowLeft = paddingLeft + twistyWidth + gap.
    // `.tree-row` declares `gap: 2px` in component SCSS (see
    // `json-tree.component.scss:199`). The row's `padding-left` scales
    // with `item.level * 1.25em` -- read it from computed style so
    // this test stays valid for fixtures at any nesting depth.
    //
    // Asserting against this invariant -- rather than comparing
    // X-positions across sibling rows -- decouples the test from
    // leading-comment / rule-icon / beacon-badge variation that
    // would silently shift one row's key relative to another's.
    const padLeft = parseFloat(getComputedStyle(row!).paddingLeft);
    const rowLeft = row!.getBoundingClientRect().left;
    const twistyWidth = twisty!.getBoundingClientRect().width;
    const keyLeft = key!.getBoundingClientRect().left;
    const GAP_PX = 2;

    const expectedKeyOffset = padLeft + twistyWidth + GAP_PX;
    const actualKeyOffset = keyLeft - rowLeft;
    // +/- 2px tolerance for sub-pixel rounding in headless Chromium
    // (matches the +1 tolerance used for clientWidth comparisons
    // above; key alignment crosses two getBoundingClientRect reads
    // so doubles the rounding budget).
    expect(Math.abs(actualKeyOffset - expectedKeyOffset))
      .withContext(
        `keyOffset=${actualKeyOffset.toFixed(2)} vs expected=${expectedKeyOffset.toFixed(2)} (padLeft=${padLeft}, twistyWidth=${twistyWidth.toFixed(2)}, gap=${GAP_PX}); pre-v0.23.1 the twisty shrunk under flex pressure and the key shifted ~13px left of this invariant`,
      )
      .toBeLessThanOrEqual(2);
  });

  it('v0.23.1: wires matTooltipClass="jj-tooltip-wide" onto the leaf value-string tooltip', async () => {
    const PANEL_WIDTH_PX = 400;
    const fixture = await configure(PANEL_WIDTH_PX);
    teardown = attachFixtureToBody(fixture, 'dark');
    await drainViewport(fixture);

    const host = fixture.nativeElement as HTMLElement;
    const probe = host.querySelector('.tree-row--probe');
    const debugEl = fixture.debugElement
      .queryAll(By.directive(MatTooltip))
      .find(
        (de) =>
          (de.nativeElement as HTMLElement).classList.contains('tree-value-string') &&
          !probe?.contains(de.nativeElement as HTMLElement),
      );
    expect(debugEl)
      .withContext('a .tree-value-string MatTooltip directive must be present after expandAll')
      .toBeDefined();
    // Read tooltipClass off the directive instance rather than
    // `getAttribute('matTooltipClass')`: for a static literal
    // attribute Angular reflects the value to a DOM attribute,
    // but a future binding-form change (`[matTooltipClass]=
    // "someConst"`) would not -- the directive's `.tooltipClass`
    // property is the canonical source.
    const tooltip = debugEl!.injector.get(MatTooltip);
    expect(tooltip.tooltipClass)
      .withContext(
        'value-string tooltip must opt into `jj-tooltip-wide` so long values render in a readable, wider popover (Material default 200px wraps mid-character on JSON.stringify-escaped long URLs)',
      )
      .toBe('jj-tooltip-wide');
  });

  it('v0.23.1: cascades a viewport-proportional max-width onto the tooltip surface via .jj-tooltip-wide', () => {
    // Synthesize the exact tooltip DOM Material 21 renders (from
    // `node_modules/@angular/material/fesm2022/_tooltip-chunk.mjs:815`
    // template: a `.mat-mdc-tooltip` host div whose `[class]=
    // "tooltipClass"` binding adds the panel class, and an inner
    // `.mat-mdc-tooltip-surface.mdc-tooltip__surface` child).
    //
    // This is a stylesheet-cascade test, not a Material integration
    // test. It guards against three regression modes the other three
    // assertions above can't see:
    //   (a) The selector regressing to `.mat-mdc-tooltip-panel` --
    //       which is the class Material puts on the cdk-overlay
    //       pane, NOT where `matTooltipClass` lands. That mistake
    //       would silently no-op the override and tests 1-3 would
    //       still pass.
    //   (b) A Material upgrade renaming `.mdc-tooltip__surface` or
    //       `.mat-mdc-tooltip` such that the override no longer
    //       matches the rendered DOM.
    //   (c) A regression to a fixed pixel cap (the v0.23.1 override
    //       shipped as `90vw`, replacing an earlier `min(640px,
    //       80vw)` draft that the user pushed back on as
    //       under-justified). The `> innerWidth * 0.85` threshold
    //       below pins the principle: cap scales with viewport.
    //       A future regression to e.g. `max-width: 640px` on a
    //       1024px+ Karma viewport would resolve to 640 < 870 and
    //       fail this assertion.
    const wrapper = document.createElement('div');
    wrapper.className = 'mdc-tooltip mat-mdc-tooltip jj-tooltip-wide';
    const surface = document.createElement('div');
    surface.className = 'mat-mdc-tooltip-surface mdc-tooltip__surface';
    surface.textContent = 'x'.repeat(1024);
    wrapper.appendChild(surface);
    document.body.appendChild(wrapper);
    try {
      const computedMaxWidth = parseFloat(getComputedStyle(surface).maxWidth);
      // `getComputedStyle` resolves `vw` units to absolute pixels at
      // computed-style time in modern Chromium (the CSSOM "used
      // value" form). 90vw on a 1024px viewport => 921.6px; on a
      // 1366px viewport => 1229.4px. The threshold uses 85% of the
      // current `window.innerWidth` to leave a small buffer for
      // sub-pixel rounding while still failing if the cap ever
      // collapses to a fixed pixel value smaller than the viewport.
      const proportionalThreshold = window.innerWidth * 0.85;
      expect(computedMaxWidth)
        .withContext(
          `computed surface max-width=${computedMaxWidth.toFixed(2)}px vs viewport*0.85=${proportionalThreshold.toFixed(2)}px (innerWidth=${window.innerWidth}). The v0.23.1 cap is 90vw -- a viewport-proportional rule, not a fixed pixel. If this fails because the value is small, the override either no-ops (selector regression to .mat-mdc-tooltip-panel) or has been swapped back to a fixed pixel cap.`,
        )
        .toBeGreaterThan(proportionalThreshold);
    } finally {
      wrapper.remove();
    }
  });
});

/**
 * v0.25.1 hotfix regression spec for long object keys (issue #248).
 *
 * Reproduces the bug surfaced by https://jotjson.com/s/HiZ2qI: a row
 * whose JSON key is a long unbreakable string (base64 property
 * name, long enum string ID) pushed the row past the viewport
 * because `.tree-key` had `flex-shrink: 0` and no `max-width`, so
 * the existing `nowrap + overflow:hidden + text-overflow:ellipsis`
 * cascade (present since #236) was dormant.
 *
 * Fix in `json-tree.component.scss`:
 *   * `.tree-key { max-width: 80%; flex-shrink: 0; ... }` -- the
 *     80% cap engages ellipsification; `flex-shrink: 0` keeps it
 *     pinned so the v0.21.1 short-key + long-value case still has
 *     the value absorb shrinkage.
 *   * The `: ` separator was moved from `.tree-key::after` into a
 *     sibling `<span class="tree-key-sep">: </span>` with
 *     `flex-shrink: 0`, so the colon survives ellipsification (in
 *     `::after`, ellipsis would clip the colon first).
 *
 * Fix in `json-tree.component.html`: both `.tree-key` sites (leaf
 * and open) wire `OverflowDetectorDirective` + `matTooltip` with
 * `matTooltipClass="jj-tooltip-wide"`, mirroring the v0.21.1
 * pattern on `.tree-value-string`.
 *
 * The six assertions below layer so any future regression in any
 * layer surfaces independently:
 *   1. Sanity: the leaf-row key's natural single-line width is far
 *      wider than the panel (proves we're exercising the bug).
 *   2. Wrapper constrained: the v0.21.1 invariant still holds
 *      under key-side stress.
 *   3. Leaf-row key ellipsifies AT the 80% cap.
 *   4. Open-row key ellipsifies AT the 80% cap (covers L517).
 *   5. Colon separator visible after key clipping (the
 *      `.tree-key-sep` sibling does not get eaten by the ellipsis).
 *   6. Tooltip wired with `jj-tooltip-wide` on BOTH key sites.
 */
describe('JsonTreeComponent (long-key overflow)', () => {
  let teardown: (() => void) | undefined;
  let fixtureValue: unknown;

  beforeAll(async () => {
    const response = await fetch('/fixtures/LongUnbreakableKey.json');
    if (!response.ok) {
      throw new Error(
        `Failed to load fixtures/LongUnbreakableKey.json: HTTP ${response.status}. ` +
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

  // Computes `row.clientWidth - paddingLeft - paddingRight` to match
  // the box `max-width: 80%` resolves against (the content-box). The
  // raw row.clientWidth includes the level-dependent padding-left
  // (`item.level * 1.25em`) so a nesting-depth change in the fixture
  // would silently shift the reference point if we compared against
  // clientWidth directly.
  function rowContentBoxWidth(row: HTMLElement): number {
    const style = getComputedStyle(row);
    const padLeft = parseFloat(style.paddingLeft);
    const padRight = parseFloat(style.paddingRight);
    return row.clientWidth - padLeft - padRight;
  }

  // The two long-key paths in fixtures/LongUnbreakableKey.json.
  // Defined as constants so we can reuse them across assertions and
  // get readable failure messages when the fixture drifts.
  const LEAF_KEY_PATH =
    '$.ALongUnbreakableLeafKey_For_Issue_248_Regression_Test_' +
    'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA_ZZZZ';
  const OPEN_KEY_PATH =
    '$.ALongUnbreakableOpenKey_For_Issue_248_Regression_Test_' +
    'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB_ZZZZ';

  afterEach(() => {
    teardown?.();
    teardown = undefined;
  });

  it('sanity: leaf-row long key has natural single-line width >= 2x panel content-box width', async () => {
    const PANEL_WIDTH_PX = 400;
    const fixture = await configure(PANEL_WIDTH_PX);
    teardown = attachFixtureToBody(fixture, 'dark');
    await drainViewport(fixture);

    const host = fixture.nativeElement as HTMLElement;
    const row = host.querySelector<HTMLElement>(`[data-path="${LEAF_KEY_PATH}"]`);
    expect(row).withContext('leaf-row with long key must render').not.toBeNull();
    const key = row!.querySelector<HTMLElement>('.tree-key');
    expect(key).withContext('leaf row must render a .tree-key').not.toBeNull();

    // If this precondition fails (a future fixture edit makes the
    // key short enough to fit), the test stops exercising the bug
    // class; fail loudly rather than passing by coincidence.
    const contentBox = rowContentBoxWidth(row!);
    expect(key!.scrollWidth)
      .withContext(
        `precondition: leaf-row key natural scrollWidth (${key!.scrollWidth}) must be >= 2x row content-box width (${contentBox.toFixed(2)}); if this fails, edit fixtures/LongUnbreakableKey.json to restore a long unbreakable key`,
      )
      .toBeGreaterThanOrEqual(2 * contentBox);
  });

  it('keeps the cdk-virtual-scroll-content-wrapper within the viewport when a row KEY is much wider', async () => {
    // v0.21.1 invariant under v0.25.1 stress: long keys must not
    // re-introduce horizontal scroll the way long values used to.
    const PANEL_WIDTH_PX = 400;
    const fixture = await configure(PANEL_WIDTH_PX);
    teardown = attachFixtureToBody(fixture, 'dark');
    await drainViewport(fixture);

    const host = fixture.nativeElement as HTMLElement;
    const viewport = host.querySelector<HTMLElement>('.tree-viewport');
    const wrapper = host.querySelector<HTMLElement>('.cdk-virtual-scroll-content-wrapper');
    expect(viewport).withContext('viewport must render').not.toBeNull();
    expect(wrapper).withContext('CDK wrapper must render').not.toBeNull();

    const viewportWidth = viewport!.clientWidth;
    expect(wrapper!.clientWidth)
      .withContext(
        `wrapper.clientWidth (${wrapper!.clientWidth}) must be <= viewport.clientWidth (${viewportWidth}) + 1 under long-key stress; pre-v0.25.1 the .tree-key (flex-shrink:0, no max-width) pushed .tree-row past the viewport`,
      )
      .toBeLessThanOrEqual(viewportWidth + 1);
    expect(viewport!.scrollWidth)
      .withContext(
        `viewport.scrollWidth (${viewport!.scrollWidth}) must be <= viewport.clientWidth (${viewportWidth}) + 1; if this fails the user sees a horizontal scrollbar on a long-key row`,
      )
      .toBeLessThanOrEqual(viewportWidth + 1);
  });

  it('leaf-row .tree-key ellipsifies at the 80% max-width cap', async () => {
    const PANEL_WIDTH_PX = 400;
    const fixture = await configure(PANEL_WIDTH_PX);
    teardown = attachFixtureToBody(fixture, 'dark');
    await drainViewport(fixture);

    const host = fixture.nativeElement as HTMLElement;
    const row = host.querySelector<HTMLElement>(`[data-path="${LEAF_KEY_PATH}"]`);
    expect(row).withContext('leaf-row with long key must render').not.toBeNull();
    const key = row!.querySelector<HTMLElement>('.tree-key');
    expect(key).withContext('leaf row must render a .tree-key').not.toBeNull();

    // Cascade activated: rendered box is narrower than natural.
    expect(key!.scrollWidth)
      .withContext(
        `key.scrollWidth (${key!.scrollWidth}) must exceed key.clientWidth (${key!.clientWidth}); cascade dormant means max-width clamp didn't engage`,
      )
      .toBeGreaterThan(key!.clientWidth + 1);

    // The 80% cap resolves against the row's content-box, NOT
    // clientWidth (which includes the level-dependent padding-left).
    const contentBox = rowContentBoxWidth(row!);
    const cap = contentBox * 0.8;
    expect(key!.clientWidth)
      .withContext(
        `key.clientWidth=${key!.clientWidth} must be <= 80% of row content-box (${cap.toFixed(2)}) + 1px tolerance; row contentBox=${contentBox.toFixed(2)}`,
      )
      .toBeLessThanOrEqual(cap + 1);
  });

  it('open-row .tree-key ellipsifies at the 80% max-width cap', async () => {
    const PANEL_WIDTH_PX = 400;
    const fixture = await configure(PANEL_WIDTH_PX);
    teardown = attachFixtureToBody(fixture, 'dark');
    await drainViewport(fixture);

    const host = fixture.nativeElement as HTMLElement;
    const row = host.querySelector<HTMLElement>(`[data-path="${OPEN_KEY_PATH}"]`);
    expect(row).withContext('open-row with long key must render').not.toBeNull();
    const key = row!.querySelector<HTMLElement>('.tree-key');
    expect(key).withContext('open row must render a .tree-key').not.toBeNull();

    expect(key!.scrollWidth)
      .withContext(
        `open-row key.scrollWidth (${key!.scrollWidth}) must exceed key.clientWidth (${key!.clientWidth}); cascade dormant on open row means the L517 template site wasn't wired the same as L318`,
      )
      .toBeGreaterThan(key!.clientWidth + 1);

    const contentBox = rowContentBoxWidth(row!);
    const cap = contentBox * 0.8;
    expect(key!.clientWidth)
      .withContext(
        `open-row key.clientWidth=${key!.clientWidth} must be <= 80% of row content-box (${cap.toFixed(2)}) + 1px tolerance; row contentBox=${contentBox.toFixed(2)}`,
      )
      .toBeLessThanOrEqual(cap + 1);
  });

  it('the colon separator remains visible after the leaf-row key is clipped', async () => {
    // The `: ` separator used to live in `.tree-key::after` which
    // sat INSIDE the key's overflow box -- `text-overflow: ellipsis`
    // clips trailing content first, so it would replace the colon.
    // The v0.25.1 fix moves the separator to a sibling
    // `<span class="tree-key-sep">` with `flex-shrink: 0` so it
    // survives clipping. This assertion guards against a regression
    // that re-inlines the colon (e.g. someone reverts the
    // `::after` removal or strips `flex-shrink: 0` on
    // `.tree-key-sep`).
    const PANEL_WIDTH_PX = 400;
    const fixture = await configure(PANEL_WIDTH_PX);
    teardown = attachFixtureToBody(fixture, 'dark');
    await drainViewport(fixture);

    const host = fixture.nativeElement as HTMLElement;
    const row = host.querySelector<HTMLElement>(`[data-path="${LEAF_KEY_PATH}"]`);
    expect(row).withContext('leaf-row with long key must render').not.toBeNull();
    const key = row!.querySelector<HTMLElement>('.tree-key');
    const sep = row!.querySelector<HTMLElement>('.tree-key-sep');
    expect(key).withContext('leaf row must render a .tree-key').not.toBeNull();
    expect(sep)
      .withContext(
        '.tree-key-sep sibling span must render; if null, the colon was re-inlined into .tree-key::after and would be the first content clipped by the ellipsis',
      )
      .not.toBeNull();

    expect(sep!.clientWidth)
      .withContext(
        `sep.clientWidth (${sep!.clientWidth}) must be > 0 -- if zero, the separator was clipped/hidden and the row would render as "longkey..." with no ": " before the value`,
      )
      .toBeGreaterThan(0);
    expect(sep!.scrollWidth)
      .withContext(
        `sep.scrollWidth (${sep!.scrollWidth}) must be <= sep.clientWidth (${sep!.clientWidth}) + 1 -- separator itself must not be ellipsified`,
      )
      .toBeLessThanOrEqual(sep!.clientWidth + 1);

    // The separator visually follows the key (the colon comes after
    // the ellipsis, not before it).
    const keyRight = key!.getBoundingClientRect().right;
    const sepLeft = sep!.getBoundingClientRect().left;
    expect(sepLeft)
      .withContext(
        `sep left=${sepLeft.toFixed(2)} must be >= key right=${keyRight.toFixed(2)} - 1 (DOM order: <key> then <sep>)`,
      )
      .toBeGreaterThanOrEqual(keyRight - 1);
  });

  it('wires matTooltipClass="jj-tooltip-wide" onto BOTH the leaf-row and open-row .tree-key tooltips (per data-path)', async () => {
    const PANEL_WIDTH_PX = 400;
    const fixture = await configure(PANEL_WIDTH_PX);
    teardown = attachFixtureToBody(fixture, 'dark');
    await drainViewport(fixture);

    // Per-row lookup is required, not a global `>= 2` count: the
    // fixture has multiple leaf rows (LeafKey + nested "child" +
    // shortKey), so a global "found >= 2 .tree-key tooltips" check
    // would pass even if the open-row template were unwired (3 leaf
    // tooltips still satisfy >= 2). We must verify BOTH specific
    // rows -- the leaf at LEAF_KEY_PATH and the open at
    // OPEN_KEY_PATH -- carry a directly-bound MatTooltip with the
    // wide tooltipClass. (PR #268 review feedback.)
    //
    // Why `By.directive(MatTooltip)` + `.closest('[data-path=...]')`
    // and not `keyDebugEl.injector.get(MatTooltip)`:
    //   - `injector.get` walks UP the NodeInjector tree, so an
    //     ancestor's MatTooltip would resolve and mask a missing
    //     binding on the .tree-key element itself.
    //   - `injector.get` THROWS NullInjectorError when no binding is
    //     found, which is the exact regression this test guards
    //     against -- so the contextual diagnostic below would never
    //     fire on the failure case.
    // `By.directive(MatTooltip)` returns only DebugElements where
    // the directive is directly attached, side-stepping both.
    //
    // The `.tree-row--probe` row at json-tree.component.html:237 has
    // no `data-path` attribute and no `matTooltip` binding, so it
    // cannot match `[data-path="..."] .tree-key` or
    // `By.directive(MatTooltip)`; an explicit `probe.contains(...)`
    // filter would be redundant here.
    const treeKeyDirectiveDebugEls = fixture.debugElement
      .queryAll(By.directive(MatTooltip))
      .filter((debugEl) => (debugEl.nativeElement as HTMLElement).classList.contains('tree-key'));

    for (const [rowLabel, rowPath] of [
      ['leaf', LEAF_KEY_PATH],
      ['open', OPEN_KEY_PATH],
    ] as const) {
      const tooltipDirectiveDebugEl = treeKeyDirectiveDebugEls.find(
        (debugEl) =>
          (debugEl.nativeElement as HTMLElement).closest(`[data-path="${rowPath}"]`) !== null,
      );
      expect(tooltipDirectiveDebugEl)
        .withContext(
          `${rowLabel}-row .tree-key (path=${rowPath}) must have a MatTooltip directive bound directly to the element; if missing, that template site was not wired with [matTooltip]`,
        )
        .toBeDefined();
      if (!tooltipDirectiveDebugEl) {
        continue;
      }
      // Reading off the directive instance (not `getAttribute(
      // 'matTooltipClass')`) matches the v0.23.1 spec pattern --
      // it stays valid if the binding form ever changes from
      // static literal to `[matTooltipClass]="someConst"`.
      const tooltip = tooltipDirectiveDebugEl.injector.get(MatTooltip);
      expect(tooltip.tooltipClass)
        .withContext(
          `${rowLabel}-row .tree-key tooltip must opt into \`jj-tooltip-wide\`; otherwise long keys render in the Material default 200px popover and wrap mid-character`,
        )
        .toBe('jj-tooltip-wide');
    }
  });
});
