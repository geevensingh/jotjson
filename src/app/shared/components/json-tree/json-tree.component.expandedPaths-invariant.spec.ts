import { ComponentFixture, TestBed } from '@angular/core/testing';
import { MatSnackBar } from '@angular/material/snack-bar';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { provideFakeAuth } from '../../../../testing/auth.testing';
import { JsonTreeComponent } from './json-tree.component';

/**
 * Phase 2 (issue #95) invariant spec for the authoritative
 * `expandedPaths` signal. The primary `json-tree.component.spec.ts`
 * tests observable side effects (which rows are in the DOM, which
 * tooltips fire, which telemetry events emit). This file is the
 * narrow contract test: every public expansion-mutating API moves
 * `expandedPaths` to the state the caller asked for, and idempotency
 * holds. If a future refactor mutates the rendered tree without
 * mutating `expandedPaths` (or vice versa), this spec catches it
 * with a focused, fast assertion rather than relying on the broader
 * spec catching it incidentally.
 *
 * Read access goes through `__getHelpersForTesting().readExpandedPaths()`
 * so the production `expandedPaths` field stays private.
 */
describe('JsonTreeComponent expandedPaths invariant', () => {
  let fixture: ComponentFixture<JsonTreeComponent>;
  let cmp: JsonTreeComponent;
  const fixtureWrappers: HTMLDivElement[] = [];

  function attachFixtureForViewport(f: ComponentFixture<JsonTreeComponent>): void {
    const host = f.nativeElement as HTMLElement;
    host.style.height = '600px';
    host.style.width = '1000px';
    const wrapper = document.createElement('div');
    wrapper.style.cssText =
      'position: fixed; left: 0; top: 0; width: 1000px; height: 600px; ' +
      'display: flex; flex-direction: column; overflow: hidden;';
    wrapper.appendChild(host);
    document.body.appendChild(wrapper);
    fixtureWrappers.push(wrapper);
  }

  function detachAllFixtureWrappers(): void {
    while (fixtureWrappers.length > 0) {
      const wrapper = fixtureWrappers.pop()!;
      if (wrapper.parentNode) wrapper.parentNode.removeChild(wrapper);
    }
  }

  async function createWith(value: unknown): Promise<void> {
    TestBed.resetTestingModule();
    await TestBed.configureTestingModule({
      imports: [JsonTreeComponent],
      providers: [
        ...provideFakeAuth(),
        provideNoopAnimations(),
        { provide: MatSnackBar, useValue: { open: jasmine.createSpy('snackOpen') } },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(JsonTreeComponent);
    fixture.componentRef.setInput('value', value);
    attachFixtureForViewport(fixture);
    fixture.detectChanges();
    cmp = fixture.componentInstance;
    fixture.detectChanges();
    await Promise.resolve();
    await Promise.resolve();
    fixture.detectChanges();
  }

  function readExpanded(): ReadonlySet<string> {
    return cmp.__getHelpersForTesting().readExpandedPaths();
  }

  // Walk `cmp.root()` directly (independent of `flatList`, which only
  // surfaces rendered rows) to find a node by `pathString`. This is the
  // invariant spec's escape hatch -- the production `findNode` helper
  // intentionally returns only rendered rows since it backs the kebab /
  // breadcrumb features, but the invariant test must reach collapsed
  // nodes to verify operations that *make* them visible.
  function findNodeByPath(path: string) {
    const root = cmp.root();
    if (!root) throw new Error('Root not built');
    const stack = [root];
    while (stack.length > 0) {
      const node = stack.pop()!;
      if (node.pathString === path) return node;
      for (const child of node.children ?? []) stack.push(child);
    }
    throw new Error(`No node found for path ${path}`);
  }

  afterEach(() => {
    detachAllFixtureWrappers();
  });

  it('collapseAll() yields an empty expandedPaths set and reflects in isExpanded', async () => {
    await createWith({ a: { b: 1 } });
    cmp.expandAll();
    fixture.detectChanges();
    expect(readExpanded().size).toBeGreaterThan(0);
    cmp.collapseAll();
    fixture.detectChanges();
    expect(readExpanded().size).toBe(0);
    const aNode = findNodeByPath('$.a');
    expect(cmp.__getHelpersForTesting().isExpanded(aNode)).toBeFalse();
  });

  it('expandAll() expands every container path in the tree', async () => {
    await createWith({ a: { b: { c: 1 } }, d: { e: 2 } });
    cmp.expandAll();
    fixture.detectChanges();
    const expanded = readExpanded();
    expect(expanded.has('$')).toBeTrue();
    expect(expanded.has('$.a')).toBeTrue();
    expect(expanded.has('$.a.b')).toBeTrue();
    expect(expanded.has('$.d')).toBeTrue();
  });

  it('collapseAll() empties expandedPaths', async () => {
    await createWith({ a: { b: 1 } });
    cmp.expandAll();
    fixture.detectChanges();
    cmp.collapseAll();
    fixture.detectChanges();
    expect(readExpanded().size).toBe(0);
  });

  it('expandToLevel(K) expands containers up to depth K (inclusive)', async () => {
    await createWith({ a: { b: { c: { d: 1 } } } });
    cmp.collapseAll();
    fixture.detectChanges();
    cmp.expandToLevel(2);
    fixture.detectChanges();
    const expanded = readExpanded();
    // depth 0 ($) and depth 1 ($.a) are expanded; deeper containers stay collapsed.
    expect(expanded.has('$')).toBeTrue();
    expect(expanded.has('$.a')).toBeTrue();
    expect(expanded.has('$.a.b')).toBeFalse();
    expect(expanded.has('$.a.b.c')).toBeFalse();
  });

  it('expandNodeAtPath() expands the specific target node (no ancestor walk)', async () => {
    // Contract: `expandNodeAtPath` expands the *named* node only. It does
    // not walk ancestors; callers that want a path fully revealed use
    // `expandAndScroll` (which is private; surfaced via `selectByPathString`).
    await createWith({ a: { b: { c: 1 } } });
    cmp.collapseAll();
    fixture.detectChanges();
    cmp.expandNodeAtPath(['a', 'b']);
    fixture.detectChanges();
    const expanded = readExpanded();
    expect(expanded.has('$.a.b')).toBeTrue();
    expect(expanded.has('$.a')).toBeFalse();
  });

  it('user toggle (helpers.toggleExpanded) flips the path membership idempotently', async () => {
    await createWith({ a: { b: 1 }, c: { d: 2 } });
    cmp.collapseAll();
    fixture.detectChanges();
    const helpers = cmp.__getHelpersForTesting();
    const aNode = findNodeByPath('$.a');
    helpers.toggleExpanded(aNode);
    fixture.detectChanges();
    expect(readExpanded().has('$.a')).toBeTrue();
    helpers.toggleExpanded(aNode);
    fixture.detectChanges();
    expect(readExpanded().has('$.a')).toBeFalse();
  });

  it('expandAllFromHere() expands every descendant container of the start node', async () => {
    await createWith({ a: { b: { c: 1 }, d: 2 }, e: 3 });
    cmp.collapseAll();
    fixture.detectChanges();
    const aNode = findNodeByPath('$.a');
    cmp.expandAllFromHere(aNode);
    fixture.detectChanges();
    const expanded = readExpanded();
    expect(expanded.has('$.a')).toBeTrue();
    expect(expanded.has('$.a.b')).toBeTrue();
    // Siblings outside the subtree are unchanged.
    expect(expanded.has('$.e')).toBeFalse();
  });

  it('expandToDepthFromHere(node, K) expands the start node + K-1 levels below it', async () => {
    // Contract (from the implementation walk in json-tree.component.ts:
    // ~3093-3115): walking stops BEFORE expanding the level-K container,
    // so K=1 expands only the start node itself; its direct children are
    // rendered (visible) but not themselves expanded.
    await createWith({ a: { b: { c: { d: 1 } }, e: 2 } });
    cmp.collapseAll();
    fixture.detectChanges();
    const aNode = findNodeByPath('$.a');
    cmp.expandToDepthFromHere(aNode, 2);
    fixture.detectChanges();
    const expanded = readExpanded();
    expect(expanded.has('$.a')).toBeTrue();
    expect(expanded.has('$.a.b')).toBeTrue();
    // Depth K (= 2) container stays collapsed.
    expect(expanded.has('$.a.b.c')).toBeFalse();
  });

  it('isolateRow() collapses siblings and ancestor siblings, keeping only the target path open', async () => {
    await createWith({ a: { b: { c: 1 } }, d: { e: 2 } });
    cmp.expandAll();
    fixture.detectChanges();
    const target = findNodeByPath('$.a.b');
    cmp.isolateRow(target, 'single');
    fixture.detectChanges();
    const expanded = readExpanded();
    // Ancestor chain to the target remains expanded.
    expect(expanded.has('$')).toBeTrue();
    expect(expanded.has('$.a')).toBeTrue();
    expect(expanded.has('$.a.b')).toBeTrue();
    // Sibling subtree under root is collapsed.
    expect(expanded.has('$.d')).toBeFalse();
  });

  it('collapseSiblings() collapses all sibling containers of the node, leaving the node alone', async () => {
    await createWith({ a: { x: 1 }, b: { y: 2 }, c: { z: 3 } });
    cmp.expandAll();
    fixture.detectChanges();
    const aNode = findNodeByPath('$.a');
    cmp.collapseSiblings(aNode);
    fixture.detectChanges();
    const expanded = readExpanded();
    expect(expanded.has('$.a')).toBeTrue();
    expect(expanded.has('$.b')).toBeFalse();
    expect(expanded.has('$.c')).toBeFalse();
  });

  it('expandedPaths survives a root() change (paths persist across re-parse)', async () => {
    await createWith({ a: { b: 1 } });
    cmp.expandAll();
    fixture.detectChanges();
    const before = new Set(readExpanded());
    // Re-emit the same value via the signal-input shape; expandedPaths
    // is path-keyed and intentionally NOT reset on root change.
    fixture.componentRef.setInput('value', { a: { b: 1 }, c: 2 });
    fixture.detectChanges();
    await Promise.resolve();
    fixture.detectChanges();
    const after = readExpanded();
    for (const path of before) {
      expect(after.has(path))
        .withContext(`path ${path} should persist across root change`)
        .toBeTrue();
    }
  });
});
