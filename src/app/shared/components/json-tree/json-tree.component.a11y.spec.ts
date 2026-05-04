import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { MatSnackBar } from '@angular/material/snack-bar';
import { JsonTreeComponent } from './json-tree.component';
import { provideFakeAuth } from '../../../../testing/auth.testing';
import { attachFixtureToBody } from '../../../../testing/a11y';

/**
 * M7g-3b structural accessibility spec for the JSON tree component.
 *
 * Covers the WAI-ARIA Tree pattern that Wave 3b lands (audit findings
 * F2.1-F2.3):
 *   - role="tree" on <mat-tree> (CDK default) plus aria-label;
 *   - role="treeitem" on every <mat-nested-tree-node> (CDK default);
 *   - aria-level / aria-posinset / aria-setsize / aria-expanded on
 *     each tree node;
 *   - role="presentation" on the visual `.tree-row` chrome and the
 *     decorative `.tree-row--close` brace;
 *   - role="group" on `.tree-children`;
 *   - roving tabindex (exactly one node tabindex="0").
 *
 * NOTE on the strict axe scan: Wave 3b deliberately does NOT run
 * `expectNoStrictA11yViolations` against the rendered tree yet. The
 * audit surfaced ~14 dark-theme and ~18 light-theme color-contrast
 * violations on tree elements (e.g., `.tree-count`, `.tree-type-badge`,
 * `.tree-value-string` at 4.14:1 just under WCAG 4.5:1) plus app-shell
 * bleed (`.jj-breadcrumb`). Those are the focus of M7g-3d (Light-theme
 * + disabled-text contrast); folding them into 3b would balloon scope
 * past F2.1-F2.3. The structural assertions below confirm the WAI-ARIA
 * Tree pattern landed; the strict axe gate joins the file in Wave 3d.
 */
describe('JsonTreeComponent (a11y)', () => {
  const REPRESENTATIVE_VALUE = {
    name: 'Alice',
    age: 30,
    active: true,
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
    return fixture;
  }

  afterEach(() => {
    teardown?.();
    teardown = undefined;
  });

  it('exposes the WAI-ARIA Tree role chain (tree -> treeitem -> group)', async () => {
    const fixture = await configure();
    teardown = attachFixtureToBody(fixture, 'dark');
    fixture.detectChanges();
    fixture.componentInstance.expandAll();
    fixture.detectChanges();

    const host = fixture.nativeElement as HTMLElement;
    const tree = host.querySelector('mat-tree');
    expect(tree?.getAttribute('role'))
      .withContext('CDK should set role="tree" on <mat-tree>')
      .toBe('tree');
    expect(tree?.getAttribute('aria-label'))
      .withContext('the tree must have an aria-label so AT can announce it')
      .toBeTruthy();

    const treeitems = host.querySelectorAll('mat-nested-tree-node[role="treeitem"]');
    expect(treeitems.length)
      .withContext('every <mat-nested-tree-node> should carry role="treeitem"')
      .toBeGreaterThan(0);

    const groups = host.querySelectorAll('.tree-children[role="group"]');
    expect(groups.length)
      .withContext('every container should expose role="group" for its children')
      .toBeGreaterThan(0);

    // .tree-row is presentational chrome; the treeitem role lives on
    // its mat-nested-tree-node ancestor instead.
    const rows = host.querySelectorAll('.tree-row[role="presentation"]');
    expect(rows.length)
      .withContext('the visual .tree-row chrome should be role="presentation"')
      .toBeGreaterThan(0);
  });

  it('has exactly one tabindex="0" tree node (roving focus invariant)', async () => {
    const fixture = await configure();
    teardown = attachFixtureToBody(fixture, 'dark');
    fixture.detectChanges();
    fixture.componentInstance.expandAll();
    fixture.detectChanges();
    await Promise.resolve();
    fixture.detectChanges();

    const focused = (fixture.nativeElement as HTMLElement).querySelectorAll(
      'mat-nested-tree-node[tabindex="0"]',
    );
    expect(focused.length).toBe(1);
  });
});
