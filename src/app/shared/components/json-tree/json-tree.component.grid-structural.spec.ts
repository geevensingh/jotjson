import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { MatSnackBar } from '@angular/material/snack-bar';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { attachFixtureToBody } from '../../../../testing/a11y';
import { provideFakeAuth } from '../../../../testing/auth.testing';
import { PreferencesService } from '../../../core/preferences/preferences.service';
import { JsonTreeComponent } from './json-tree.component';

/**
 * v0.26.1 (issue #269) -- `.tree-row` Grid-template invariants.
 *
 * Each assertion guards a specific contract documented at
 * DESIGN_SPEC.md's v0.26.1 entry and at the inline SCSS comment
 * block in `json-tree.component.scss` for the `.tree-row` selector.
 * Casual deletion of an assertion silently regresses an invariant
 * the SCSS comment block names but doesn't enforce inline.
 *
 * Lives in its own file (rather than appending to the 9000-line
 * `json-tree.component.spec.ts`) so the Grid invariants are
 * discoverable as a single group and can be hardened into a
 * separate build-time lint later (see follow-up issue #5 in the
 * #269 PR description).
 *
 * Mounting strategy mirrors `json-tree.component.overflow.spec.ts`:
 * the host is sized AT mount (not resize-after-render) so the first
 * `OverflowDetectorDirective.afterNextRender` measurement already
 * runs at the constrained size. This decouples the assertions from
 * `ResizeObserver` callback timing.
 */
describe('JsonTreeComponent (.tree-row Grid template invariants -- v0.26.1)', () => {
  let teardown: (() => void) | undefined;
  const fixtureCache = new Map<string, unknown>();

  async function loadFixture(name: string): Promise<unknown> {
    const cached = fixtureCache.get(name);
    if (cached !== undefined) return cached;
    const response = await fetch(`/fixtures/${name}`);
    if (!response.ok) {
      throw new Error(
        `Failed to load fixtures/${name}: HTTP ${response.status}. ` +
          `Ensure src/testing/fixtures is registered in angular.json test assets.`,
      );
    }
    const parsed = JSON.parse(await response.text());
    fixtureCache.set(name, parsed);
    return parsed;
  }

  async function configure(
    value: unknown,
    panelWidthPx: number,
  ): Promise<ComponentFixture<JsonTreeComponent>> {
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
    fixture.componentRef.setInput('value', value);

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

  function firstRealRow(host: HTMLElement): HTMLElement | null {
    // Filter out the off-screen `.tree-row--probe` so we only look at
    // rows the user actually sees. `.tree-row--close` is included in
    // the descendant search but excluded from "first leaf/open" cases
    // explicitly per test.
    const all = Array.from(host.querySelectorAll<HTMLElement>('.tree-row'));
    return all.find((r) => !r.classList.contains('tree-row--probe')) ?? null;
  }

  function probeRow(host: HTMLElement): HTMLElement | null {
    return host.querySelector<HTMLElement>('.tree-row--probe');
  }

  afterEach(() => {
    teardown?.();
    teardown = undefined;
  });

  // 1. Row uses Grid.
  it('renders .tree-row with display: grid', async () => {
    const value = await loadFixture('MidKeyMidValue.json');
    const fixture = await configure(value, 800);
    teardown = attachFixtureToBody(fixture, 'dark');
    await drainViewport(fixture);

    const host = fixture.nativeElement as HTMLElement;
    const row = firstRealRow(host);
    expect(row).withContext('at least one real (non-probe) row must render').not.toBeNull();
    expect(getComputedStyle(row!).display)
      .withContext('the v0.26.1 Grid migration requires .tree-row to render as display: grid')
      .toBe('grid');
  });

  // 2. Grid template includes a 1fr filler track.
  it('grid-template-columns includes a 1fr filler track', async () => {
    const value = await loadFixture('MidKeyMidValue.json');
    const fixture = await configure(value, 800);
    teardown = attachFixtureToBody(fixture, 'dark');
    await drainViewport(fixture);

    const host = fixture.nativeElement as HTMLElement;
    const row = firstRealRow(host);
    expect(row).not.toBeNull();

    // Track names are tokens from the source SCSS; `getComputedStyle`
    // returns the resolved sizes, so we assert against panelWidth
    // dependencies. A filler track absorbing slack means the rightmost
    // track is pinned to the row's right edge: rowRight - rightLeft
    // equals at most the right-track's intrinsic width + padding-right.
    // We sanity-check by toggling the panel between two widths and
    // requiring rowWidth to grow by the same amount as a non-right
    // track edge: i.e. only the filler track absorbed the delta.
    const rowWidth1 = row!.getBoundingClientRect().width;
    expect(rowWidth1).toBeGreaterThan(0);

    host.style.width = '600px';
    fixture.detectChanges();
    await Promise.resolve();
    fixture.detectChanges();

    const rowWidth2 = row!.getBoundingClientRect().width;
    const rightCluster = row!.querySelector<HTMLElement>('.tree-row-right');
    expect(rightCluster)
      .withContext('every value/open row must render a .tree-row-right cluster')
      .not.toBeNull();

    // The widths must scale with the host. If the row tracks were not
    // absorbing the panel-width delta, the row would either overflow
    // or stay at its content-width. Tolerance: +/-2px sub-pixel
    // rounding.
    const widthDelta = Math.abs(rowWidth1 - rowWidth2 - 200);
    expect(widthDelta)
      .withContext(
        `row width changed from ${rowWidth1.toFixed(2)} to ${rowWidth2.toFixed(2)} when panel shrank from 800 to 600 -- the 1fr filler track must absorb the slack`,
      )
      .toBeLessThanOrEqual(2);
  });

  // 3. Right cluster pins to row right edge.
  it('right cluster .tree-row-right right edge equals row right edge within 4 px', async () => {
    const value = await loadFixture('MidKeyMidValue.json');
    const fixture = await configure(value, 600);
    teardown = attachFixtureToBody(fixture, 'dark');
    await drainViewport(fixture);

    const host = fixture.nativeElement as HTMLElement;
    const row = firstRealRow(host);
    expect(row).not.toBeNull();
    const right = row!.querySelector<HTMLElement>('.tree-row-right');
    expect(right).not.toBeNull();

    const rowRect = row!.getBoundingClientRect();
    const rightRect = right!.getBoundingClientRect();

    // `.tree-row` declares `padding: 0 4px 0 0`; the right cluster
    // sits inside the right edge of the row at distance == padding-
    // right (4px). +/- 2px tolerance for sub-pixel rounding.
    const gap = rowRect.right - rightRect.right;
    expect(gap)
      .withContext(
        `rowRight=${rowRect.right.toFixed(2)} - rightClusterRight=${rightRect.right.toFixed(2)} = ${gap.toFixed(2)}; expected ~4 (padding-right). If this fails, the 1fr filler track failed to pin the right cluster.`,
      )
      .toBeGreaterThanOrEqual(0);
    expect(gap).toBeLessThanOrEqual(8);
  });

  // 4. Long-key fixture at 400px L10: row no overflow.
  it('LongUnbreakableKey at 400px: deeply-nested long-key row does not overflow', async () => {
    const value = await loadFixture('LongUnbreakableKey.json');
    const fixture = await configure(value, 400);
    teardown = attachFixtureToBody(fixture, 'dark');
    await drainViewport(fixture);

    const host = fixture.nativeElement as HTMLElement;
    // The deepest long-key row lives at $.longKeyDeepNest.l2...l9
    // and contains the long unbreakable key. Find any row whose
    // .tree-key has the long-name prefix.
    const rows = Array.from(host.querySelectorAll<HTMLElement>('.tree-row:not(.tree-row--probe)'));
    const longKeyRow = rows.find((r) =>
      r.querySelector<HTMLElement>('.tree-key')?.textContent?.includes('AVeryLongUnbreakable'),
    );
    expect(longKeyRow)
      .withContext('a row containing the AVeryLongUnbreakable... key must render after expandAll')
      .toBeDefined();

    // Tolerance: 1px sub-pixel rounding.
    const scrollWidth = longKeyRow!.scrollWidth;
    const clientWidth = longKeyRow!.clientWidth;
    expect(scrollWidth)
      .withContext(
        `long-key row scrollWidth=${scrollWidth} must be <= clientWidth=${clientWidth} + 1; the Grid template's minmax(0, max-content) tracks must shrink under panel pressure`,
      )
      .toBeLessThanOrEqual(clientWidth + 1);
  });

  // 5. Long-key + long-value fixture: key + value tracks share via
  //    Grid `minmax(0, max-content)` proportional sizing. Asserts
  //    contract (both renderable, row doesn't overflow) rather than
  //    px floors (which flake on font-metric variance across
  //    platforms).
  it('LongUnbreakableKey longKeyLongValue at 400px: key + value both renderable, row no overflow', async () => {
    const value = await loadFixture('LongUnbreakableKey.json');
    const fixture = await configure(value, 400);
    // The `longKeyLongValue` branch is near the BOTTOM of the expanded
    // tree (after a 10-level deeply-nested subtree + a short-value
    // subtree). With the default 600px viewport, CDK's virtual scroll
    // may not render it. Make the panel tall enough to materialize
    // all expanded rows in one pass.
    (fixture.nativeElement as HTMLElement).style.height = '1600px';
    teardown = attachFixtureToBody(fixture, 'dark');
    await drainViewport(fixture);

    const host = fixture.nativeElement as HTMLElement;
    const rows = Array.from(host.querySelectorAll<HTMLElement>('.tree-row:not(.tree-row--probe)'));
    const longLongRow = rows.find((r) => {
      const k = r.querySelector<HTMLElement>('.tree-key');
      const v = r.querySelector<HTMLElement>('.tree-value-string');
      return (
        k?.textContent?.includes('AVeryLongUnbreakable') &&
        v?.textContent?.includes('AVeryLongUnbreakable')
      );
    });
    expect(longLongRow)
      .withContext('the long-key + long-value row must render after expandAll')
      .toBeDefined();

    const key = longLongRow!.querySelector<HTMLElement>('.tree-key')!;
    const valueEl = longLongRow!.querySelector<HTMLElement>('.tree-value-string')!;

    // Both present in the render tree and not visibility:hidden. A
    // regression to `display: none` on the element OR any ancestor
    // (e.g. `.tree-row { display: none }`) trips `getClientRects()`.
    // We do NOT assert `clientWidth > 0` here: `.tree-key` has
    // `min-width: 0` and the `[key]` Grid track is `minmax(0,
    // max-content)`, so under unbreakable-content competition the
    // track CAN legitimately resolve to 0px without it being a
    // regression (see issue #287; the author's note at the `long
    // leading comment + long key` test below documents the 2-50+ px
    // cross-platform variance). This assertion is strictly narrower
    // than the old `clientWidth > 0` -- "key is wide enough to be
    // readable" is intentionally NOT enforced (and was not reliably
    // enforced before either, since 0px is a legitimate layout
    // outcome). The row-overflow assertion below guards the
    // user-visible "row fits the panel" contract.
    expect(key.getClientRects().length)
      .withContext(
        'key must be in the render tree (display:none on element or any ancestor would fail this)',
      )
      .toBeGreaterThan(0);
    expect(getComputedStyle(key).visibility)
      .withContext('key must not be visibility:hidden (inherited from ancestor or set directly)')
      .not.toBe('hidden');
    expect(valueEl.getClientRects().length)
      .withContext(
        'value must be in the render tree (display:none on element or any ancestor would fail this)',
      )
      .toBeGreaterThan(0);
    expect(getComputedStyle(valueEl).visibility)
      .withContext('value must not be visibility:hidden')
      .not.toBe('hidden');

    // Row no horizontal overflow. This is the user-visible
    // contract: the Grid template MUST shrink long-long content
    // to fit the row, not push beyond the panel.
    expect(longLongRow!.scrollWidth)
      .withContext(
        `row.scrollWidth=${longLongRow!.scrollWidth} must be <= clientWidth=${longLongRow!.clientWidth} + 1 (long-key + long-value symmetric pressure)`,
      )
      .toBeLessThanOrEqual(longLongRow!.clientWidth + 1);
  });

  // 6. Close row uses display: flex.
  it('.tree-row--close uses display: flex (not grid)', async () => {
    const value = await loadFixture('MidKeyMidValue.json');
    const fixture = await configure(value, 800);
    teardown = attachFixtureToBody(fixture, 'dark');
    await drainViewport(fixture);

    const host = fixture.nativeElement as HTMLElement;
    const closeRow = host.querySelector<HTMLElement>('.tree-row.tree-row--close');
    expect(closeRow)
      .withContext('an expanded fixture must surface at least one .tree-row--close row')
      .not.toBeNull();
    expect(getComputedStyle(closeRow!).display)
      .withContext(
        'close rows have 1-3 children with no shrink competition; they intentionally stay flex per the v0.26.1 SCSS comment block',
      )
      .toBe('flex');
  });

  // 7. Convention enforcement: every direct child of .tree-row has
  //    a non-auto gridColumnStart OR is position:absolute (sr-only).
  it('every direct child of .tree-row:not(.tree-row--close) has non-auto gridColumnStart or is position:absolute', async () => {
    const value = await loadFixture('IsoDateAnnotations.json');
    const fixture = await configure(value, 800);
    teardown = attachFixtureToBody(fixture, 'dark');

    // Ensure date annotations are on so trailing-wrapper renders.
    const prefs = TestBed.inject(PreferencesService);
    prefs.update({ treeShowDateAnnotations: true });

    await drainViewport(fixture);

    const host = fixture.nativeElement as HTMLElement;
    const rows = Array.from(host.querySelectorAll<HTMLElement>('.tree-row')).filter(
      (r) => !r.classList.contains('tree-row--probe') && !r.classList.contains('tree-row--close'),
    );
    expect(rows.length)
      .withContext('at least one non-probe non-close row must render')
      .toBeGreaterThan(0);

    const violations: string[] = [];
    for (const row of rows) {
      const children = Array.from(row.children) as HTMLElement[];
      for (const child of children) {
        const styles = getComputedStyle(child);
        const isOutOfFlow = styles.position === 'absolute' || styles.position === 'fixed';
        const gridColStart = styles.gridColumnStart;
        if (!isOutOfFlow && (gridColStart === 'auto' || gridColStart === '')) {
          violations.push(
            `${child.tagName.toLowerCase()}.${child.className} has gridColumnStart="${gridColStart}" and position="${styles.position}"`,
          );
        }
      }
    }
    expect(violations)
      .withContext(
        'every NEW direct child of .tree-row must be placed via grid-column (per the SCSS convention comment); offenders: ' +
          violations.join(', '),
      )
      .toEqual([]);
  });

  // 8. Probe row height equals first real row height within 2 px.
  it('probe row height equals first real row height within 2 px', async () => {
    const value = await loadFixture('MidKeyMidValue.json');
    const fixture = await configure(value, 800);
    teardown = attachFixtureToBody(fixture, 'dark');
    await drainViewport(fixture);

    const host = fixture.nativeElement as HTMLElement;
    const probe = probeRow(host);
    const realRow = firstRealRow(host);
    expect(probe).withContext('probe row must render').not.toBeNull();
    expect(realRow).withContext('first real row must render').not.toBeNull();

    const probeHeight = probe!.getBoundingClientRect().height;
    const realHeight = realRow!.getBoundingClientRect().height;
    expect(Math.abs(probeHeight - realHeight))
      .withContext(
        `probeHeight=${probeHeight.toFixed(2)} vs realHeight=${realHeight.toFixed(2)}; the probe drives the virtual scroll itemSize so it must match a real row within sub-pixel rounding`,
      )
      .toBeLessThanOrEqual(2);
  });

  // 9. Long-trailing-comment fixture at 400px: key + value present in
  //    the render tree (structural CSS). The previous assertions used
  //    `key.clientWidth >= 1` / `value.clientWidth >= 1` (px floor on
  //    Grid track widths), which is fragile -- both elements have
  //    `min-width: 0` and the `[key]` / `[value]` tracks are
  //    `minmax(0, max-content)`, so under unbreakable-content
  //    competition the track can legitimately resolve to 0px without
  //    it being a regression (see issue #287 + the cross-platform
  //    variance note at test 10). We now assert render-tree presence
  //    (catches `display: none` on element or any ancestor) and
  //    non-hidden visibility (catches `visibility: hidden`). Row-no-
  //    overflow under this fixture is already covered by test 11
  //    (every row at 300px) so we do not duplicate it here.
  it('LongUnbreakableValue Parameters[0].Value at 400px: key + value present in render tree (structural CSS)', async () => {
    const value = await loadFixture('LongUnbreakableValue.json');
    const fixture = await configure(value, 400);
    teardown = attachFixtureToBody(fixture, 'dark');
    await drainViewport(fixture);

    const host = fixture.nativeElement as HTMLElement;
    const row = host.querySelector<HTMLElement>('[data-path="$.Parameters[0].Value"]');
    expect(row).withContext('overflowing leaf row must render').not.toBeNull();

    const key = row!.querySelector<HTMLElement>('.tree-key');
    const valueEl = row!.querySelector<HTMLElement>('.tree-value-string');
    expect(key).not.toBeNull();
    expect(valueEl).not.toBeNull();

    expect(key!.getClientRects().length)
      .withContext(
        'key must be in the render tree (display:none on element or any ancestor would fail this)',
      )
      .toBeGreaterThan(0);
    expect(getComputedStyle(key!).visibility)
      .withContext('key must not be visibility:hidden')
      .not.toBe('hidden');
    expect(valueEl!.getClientRects().length)
      .withContext(
        'value must be in the render tree (display:none on element or any ancestor would fail this)',
      )
      .toBeGreaterThan(0);
    expect(getComputedStyle(valueEl!).visibility)
      .withContext('value must not be visibility:hidden')
      .not.toBe('hidden');
  });

  // 10. Long-leading-comment + long-key fixture at 400px:
  //     (a) leading-comment carries the ellipsify trio
  //         (overflow:hidden + text-overflow:ellipsis + nowrap)
  //         so it CAN truncate rather than push the row;
  //     (b) the leading-wrapper has `min-width: 0` so Grid is
  //         allowed to size its track below intrinsic;
  //     (c) the key is in the render tree (i.e. not `display: none`
  //         on the element or any ancestor, and not
  //         `visibility: hidden`);
  //     (d) the row has no horizontal overflow.
  //
  //     We do NOT assert `key.clientWidth > 0` here: `.tree-key`
  //     has `min-width: 0` and the `[key]` Grid track is `minmax(0,
  //     max-content)`, so under unbreakable-content competition
  //     the track CAN legitimately resolve to 0px without it being
  //     a regression (see issue #287). Grid track sharing under
  //     unbreakable-content competition tie-breaks on font metrics
  //     + layout timing and is not stable across local Chrome on
  //     Windows vs. Chrome headless on CI Linux (observed: 2-50+ px
  //     variance for the same SCSS + fixture). The structural
  //     assertions below are the actual contract; row-level no-
  //     overflow guards the user-visible outcome. "Key is wide
  //     enough to be readable" is intentionally NOT enforced here
  //     -- it would need a separate test with retry + tolerance.
  it('long leading comment + long key at 400px: comment ellipsify contract holds + row no overflow', async () => {
    const value = await loadFixture('LongUnbreakableKey.json');
    const fixture = await configure(value, 400);
    teardown = attachFixtureToBody(fixture, 'dark');
    await drainViewport(fixture);

    // Locate the long-key row's data-path, then attach a comment by
    // that exact path. The pathString format includes `$` plus the
    // dotted/bracketed key segments (see `formatPath` in
    // `build-tree.ts`); reading it from the DOM avoids guessing
    // how a 256-char key segment is serialised.
    let host = fixture.nativeElement as HTMLElement;
    const rows = Array.from(host.querySelectorAll<HTMLElement>('.tree-row:not(.tree-row--probe)'));
    const longKeyRowInitial = rows.find((r) =>
      r.querySelector<HTMLElement>('.tree-key')?.textContent?.includes('AVeryLongUnbreakable'),
    );
    expect(longKeyRowInitial)
      .withContext('a row with the long-key must render after expandAll')
      .toBeDefined();
    const path = longKeyRowInitial!.getAttribute('data-path');
    expect(path).withContext('row must carry a data-path attribute').toBeTruthy();

    fixture.componentRef.setInput(
      'commentsByPath',
      new Map([
        [
          path!,
          {
            leading: [
              'A very long leading comment that should ellipsify under wrapper pressure ' +
                'and not push the key off-screen or cause the row to overflow horizontally. '.repeat(
                  3,
                ),
            ],
          },
        ],
      ]),
    );
    fixture.detectChanges();
    await Promise.resolve();
    fixture.detectChanges();

    host = fixture.nativeElement as HTMLElement;
    const longKeyRow = host.querySelector<HTMLElement>(`[data-path="${path!}"]`);
    expect(longKeyRow).withContext('long-key row must still render').not.toBeNull();

    const leadingWrapper = longKeyRow!.querySelector<HTMLElement>('.tree-row-leading');
    const leadingComment = longKeyRow!.querySelector<HTMLElement>('.tree-comment-leading');
    const key = longKeyRow!.querySelector<HTMLElement>('.tree-key');
    expect(leadingWrapper).withContext('leading wrapper must render').not.toBeNull();
    expect(leadingComment).withContext('leading comment must render').not.toBeNull();
    expect(key).withContext('key must render').not.toBeNull();

    // (a) Comment ellipsify trio. Without these, the comment's
    //     intrinsic min-content equals the full unbreakable text,
    //     and Grid's `[leading]` track grows to match -- pushing
    //     the key off-screen.
    const commentStyles = getComputedStyle(leadingComment!);
    expect(commentStyles.overflowX)
      .withContext('.tree-comment-leading must inherit overflow:hidden from .tree-comment')
      .toBe('hidden');
    expect(commentStyles.textOverflow)
      .withContext('.tree-comment-leading must inherit text-overflow:ellipsis from .tree-comment')
      .toBe('ellipsis');
    expect(commentStyles.whiteSpace)
      .withContext('.tree-comment-leading must inherit white-space:nowrap from .tree-comment')
      .toBe('nowrap');
    expect(commentStyles.minWidth)
      .withContext(
        '.tree-comment must declare min-width:0 so the inline-flex wrapper can shrink it below intrinsic',
      )
      .toBe('0px');

    // (b) Leading-wrapper min-width:0 so the Grid `[leading]`
    //     track can shrink the wrapper below intrinsic.
    const wrapperStyles = getComputedStyle(leadingWrapper!);
    expect(wrapperStyles.minWidth)
      .withContext(
        '.tree-row-leading must declare min-width:0 so Grid `[leading]` track can size it below intrinsic',
      )
      .toBe('0px');

    // (c) Key is in the render tree and not visibility:hidden. A
    //     `display: none` regression on the element or any ancestor
    //     (e.g. `.tree-row { display: none }`) would produce an
    //     empty `getClientRects()` list. Replaces the earlier
    //     `clientWidth > 0` runtime layout check, which flaked on
    //     Linux CI because `.tree-key { min-width: 0 }` plus the
    //     `[key]` track's `minmax(0, max-content)` legitimately
    //     allows 0px under unbreakable-content competition (issue
    //     #287). `getClientRects()` is not subject to Grid track
    //     sizing -- a 0px-wide rendered element still produces one
    //     `DOMRect` with `length === 1`.
    expect(key!.getClientRects().length)
      .withContext(
        'key must be in the render tree (display:none on element or any ancestor would fail this)',
      )
      .toBeGreaterThan(0);
    expect(getComputedStyle(key!).visibility)
      .withContext('key must not be visibility:hidden (inherited from ancestor or set directly)')
      .not.toBe('hidden');

    // (d) Row no horizontal overflow.
    expect(longKeyRow!.scrollWidth)
      .withContext(
        `row.scrollWidth=${longKeyRow!.scrollWidth} must be <= clientWidth=${longKeyRow!.clientWidth} + 1`,
      )
      .toBeLessThanOrEqual(longKeyRow!.clientWidth + 1);
  });

  // 11. Open container with collapsed summary at 400px: row no overflow.
  //     Uses a wider panel (300px is plenty to surface the container
  //     row + summary type badge + count cluster without truncating).
  //     We do NOT call collapseAll() because the component empties
  //     expandedPaths entirely (root included) and renders zero rows;
  //     the auto-fit-to-window initial expansion is sufficient for
  //     this assertion.
  it('CollapsedContainerSummary at 300px: every rendered row scrollWidth <= clientWidth + 1', async () => {
    const value = await loadFixture('CollapsedContainerSummary.json');
    const fixture = await configure(value, 300);
    teardown = attachFixtureToBody(fixture, 'dark');
    fixture.detectChanges();
    await Promise.resolve();
    await Promise.resolve();
    fixture.detectChanges();

    const host = fixture.nativeElement as HTMLElement;
    const rows = Array.from(host.querySelectorAll<HTMLElement>('.tree-row')).filter(
      (r) => !r.classList.contains('tree-row--probe'),
    );
    expect(rows.length)
      .withContext('at least one non-probe row must render under default expansion')
      .toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.scrollWidth)
        .withContext(
          `row scrollWidth=${row.scrollWidth} must be <= clientWidth=${row.clientWidth} + 1 (data-path=${row.getAttribute('data-path') ?? row.getAttribute('data-close-path') ?? '<probe>'})`,
        )
        .toBeLessThanOrEqual(row.clientWidth + 1);
    }
  });

  // 12. Value-side rule icon is descendant of .tree-row-value-cell,
  //     not a direct row child. We verify the probe row, which always
  //     renders one value-side rule icon as a stand-in.
  it('value-side .tree-rule-icon--value is a descendant of .tree-row-value-cell, not a direct row child', async () => {
    const value = await loadFixture('MidKeyMidValue.json');
    const fixture = await configure(value, 800);
    teardown = attachFixtureToBody(fixture, 'dark');
    await drainViewport(fixture);

    const host = fixture.nativeElement as HTMLElement;
    const probe = probeRow(host);
    expect(probe).not.toBeNull();

    const valueIcon = probe!.querySelector<HTMLElement>('.tree-rule-icon--value');
    expect(valueIcon)
      .withContext('probe row must render its value-side rule icon stand-in')
      .not.toBeNull();

    const valueCell = probe!.querySelector<HTMLElement>('.tree-row-value-cell');
    expect(valueCell)
      .withContext('probe row must render the .tree-row-value-cell wrapper')
      .not.toBeNull();
    expect(valueCell!.contains(valueIcon!))
      .withContext(
        'value-side rule icons must live INSIDE .tree-row-value-cell; placing them as direct row children would skip the Grid `[value]` track placement and break the convention',
      )
      .toBe(true);
  });

  // 13. Twisty bounding-rect width >= 13 px (no-shrink-in-wrapper).
  it('LongUnbreakableValue twisty bounding-rect width >= 13 px under long-sibling pressure', async () => {
    const value = await loadFixture('LongUnbreakableValue.json');
    const fixture = await configure(value, 400);
    teardown = attachFixtureToBody(fixture, 'dark');
    await drainViewport(fixture);

    const host = fixture.nativeElement as HTMLElement;
    const row = host.querySelector<HTMLElement>('[data-path="$.Parameters[0].Value"]');
    expect(row).withContext('overflowing leaf row must render').not.toBeNull();
    const twisty = row!.querySelector<HTMLElement>('.tree-twisty');
    expect(twisty).not.toBeNull();

    const twistyWidth = twisty!.getBoundingClientRect().width;
    expect(twistyWidth)
      .withContext(
        `twisty.width=${twistyWidth.toFixed(2)}; .tree-twisty must keep flex-shrink:0 inside the leading wrapper (v0.26.1 retained this declaration)`,
      )
      .toBeGreaterThanOrEqual(13);
  });

  // 14. Date-annotation: trailing wrapper right <= right cluster left + 1.
  it('IsoDateAnnotations at 400px: date-annotation does not overflow into the right cluster', async () => {
    const value = await loadFixture('IsoDateAnnotations.json');
    const fixture = await configure(value, 400);
    teardown = attachFixtureToBody(fixture, 'dark');

    const prefs = TestBed.inject(PreferencesService);
    prefs.update({ treeShowDateAnnotations: true });

    await drainViewport(fixture);

    const host = fixture.nativeElement as HTMLElement;
    const dateRow = host.querySelector<HTMLElement>('[data-path="$.createdAt"]');
    expect(dateRow).withContext('a date-annotated leaf row must render').not.toBeNull();
    const date = dateRow!.querySelector<HTMLElement>('.tree-date-annotation');
    const rightCluster = dateRow!.querySelector<HTMLElement>('.tree-row-right');
    expect(date).withContext('the date annotation must render when the pref is on').not.toBeNull();
    expect(rightCluster).not.toBeNull();

    const dateRight = date!.getBoundingClientRect().right;
    const rightLeft = rightCluster!.getBoundingClientRect().left;
    expect(dateRight)
      .withContext(
        `dateRight=${dateRight.toFixed(2)} must be <= rightClusterLeft=${rightLeft.toFixed(2)} + 1; date-annotation must not overflow into the right cluster`,
      )
      .toBeLessThanOrEqual(rightLeft + 1);
  });

  // 15. Long-number-value ellipsification: assert via computed style
  //     that .tree-value-number declares the v0.26.1 ellipsify trio
  //     (overflow: hidden + text-overflow: ellipsis + min-width: 0).
  //     A run-time scrollWidth test isn't reliable here because
  //     JSON.parse rounds long numeric literals to ~17 significant
  //     figures (IEEE-754 double), so a "200-digit number" lands as
  //     a short rendered string. The computed-style assertion guards
  //     the SCSS contract directly.
  it('LongNumberValue: .tree-value-number declares the v0.26.1 ellipsify trio', async () => {
    const value = await loadFixture('LongNumberValue.json');
    const fixture = await configure(value, 800);
    teardown = attachFixtureToBody(fixture, 'dark');
    await drainViewport(fixture);

    const host = fixture.nativeElement as HTMLElement;
    const numberCell = host.querySelector<HTMLElement>('.tree-value-number');
    expect(numberCell)
      .withContext('a .tree-value-number cell must render from the long-number fixture')
      .not.toBeNull();

    const styles = getComputedStyle(numberCell!);
    expect(styles.overflowX)
      .withContext(
        '.tree-value-number must declare overflow:hidden (v0.26.1 ellipsify trio). Without this rule, a long number clips mid-character at the .tree-row-value-cell wrapper edge with no ellipsis indicator.',
      )
      .toBe('hidden');
    expect(styles.textOverflow)
      .withContext('.tree-value-number must declare text-overflow:ellipsis')
      .toBe('ellipsis');
    expect(styles.minWidth)
      .withContext(
        '.tree-value-number must declare min-width:0 so the inline-flex .tree-row-value-cell can shrink it below intrinsic. ' +
          'Asserting the exact computed string ("0px") not parseFloat() so a regression to "auto" (parses to NaN -> falls back to 0 via ||) is caught.',
      )
      .toBe('0px');
  });

  // 16. Combined slots (leading-comment + trailing-comment + date-
  //     annotation + narrow pane): no wrapper overflows.
  it('combined leading-comment + trailing-comment + date-annotation at 400px: no row overflow', async () => {
    const value = await loadFixture('IsoDateAnnotations.json');
    const fixture = await configure(value, 400);
    teardown = attachFixtureToBody(fixture, 'dark');

    const prefs = TestBed.inject(PreferencesService);
    prefs.update({ treeShowDateAnnotations: true });

    fixture.componentRef.setInput(
      'commentsByPath',
      new Map([
        [
          '$.createdAt',
          {
            leading: ['A very long leading comment placed before the key on the row. '.repeat(2)],
            trailing: [
              'A very long trailing comment placed after the value on the row. '.repeat(2),
            ],
          },
        ],
      ]),
    );
    await drainViewport(fixture);

    const host = fixture.nativeElement as HTMLElement;
    const dateRow = host.querySelector<HTMLElement>('[data-path="$.createdAt"]');
    expect(dateRow).not.toBeNull();
    expect(dateRow!.scrollWidth)
      .withContext(
        `combined-slot row scrollWidth=${dateRow!.scrollWidth} must be <= clientWidth=${dateRow!.clientWidth} + 1`,
      )
      .toBeLessThanOrEqual(dateRow!.clientWidth + 1);
  });

  // 17. Font-size change preserves row layout: row.scrollWidth still
  //     <= row.clientWidth + 1 at both font sizes. (Plan v6's
  //     "scroll position preservation" assertion was originally
  //     stated against treeFontSize; we adopt the stronger property
  //     "layout invariants survive font-size change" because the
  //     CDK virtual-scroll position semantics aren't part of the
  //     Grid template contract.)
  it('changing treeFontSize preserves row layout invariants on both ends', async () => {
    const value = await loadFixture('MidKeyMidValue.json');
    const fixture = await configure(value, 600);
    teardown = attachFixtureToBody(fixture, 'dark');

    const prefs = TestBed.inject(PreferencesService);
    prefs.update({ treeFontSize: 13 });
    await drainViewport(fixture);

    const host = fixture.nativeElement as HTMLElement;
    let row = firstRealRow(host);
    expect(row).not.toBeNull();
    expect(row!.scrollWidth)
      .withContext('at treeFontSize=13, row must not horizontally overflow')
      .toBeLessThanOrEqual(row!.clientWidth + 1);

    prefs.update({ treeFontSize: 20 });
    fixture.detectChanges();
    await Promise.resolve();
    fixture.detectChanges();

    row = firstRealRow(host);
    expect(row).not.toBeNull();
    expect(row!.scrollWidth)
      .withContext('at treeFontSize=20, row must not horizontally overflow either')
      .toBeLessThanOrEqual(row!.clientWidth + 1);
  });

  // 18. Empty-array leaf renders .tree-value-container > .tree-value-brace
  //     inside .tree-row-value-cell (not as a direct grid child).
  it('EmptyArrayLeaf: empty-array leaf nests .tree-value-brace under .tree-value-container under .tree-row-value-cell', async () => {
    const value = await loadFixture('EmptyArrayLeaf.json');
    const fixture = await configure(value, 600);
    teardown = attachFixtureToBody(fixture, 'dark');
    await drainViewport(fixture);

    const host = fixture.nativeElement as HTMLElement;
    const tagsRow = host.querySelector<HTMLElement>('[data-path="$.tags"]');
    expect(tagsRow).withContext('empty-array leaf row $.tags must render').not.toBeNull();

    const valueCell = tagsRow!.querySelector<HTMLElement>('.tree-row-value-cell');
    expect(valueCell).withContext('value cell wrapper must render').not.toBeNull();
    const container = valueCell!.querySelector<HTMLElement>('.tree-value-container');
    expect(container)
      .withContext(
        'empty-array leaf must render a .tree-value-container inside .tree-row-value-cell',
      )
      .not.toBeNull();
    const brace = container!.querySelector<HTMLElement>('.tree-value-brace');
    expect(brace)
      .withContext('the .tree-value-brace ([]) must live inside .tree-value-container')
      .not.toBeNull();
    expect(brace!.textContent?.trim())
      .withContext('the brace span of an empty array must render the literal `[]`')
      .toBe('[]');
  });
});
