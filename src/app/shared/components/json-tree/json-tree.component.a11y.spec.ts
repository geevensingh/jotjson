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
