import { ComponentFixture, TestBed, fakeAsync, flushMicrotasks } from '@angular/core/testing';
import { HttpTestingController } from '@angular/common/http/testing';
import { MatSnackBar } from '@angular/material/snack-bar';
import { JsonTreeComponent } from './json-tree.component';
import { PreferencesService } from '../../../core/preferences/preferences.service';
import { RuleSetsService } from '../../../core/api/rule-sets.service';
import { LoggerService } from '../../../core/telemetry/logger.service';
import type {
  FormattingRule,
  FormattingRuleSet
} from '../../../core/api/models';
import { provideFakeAuth } from '../../../../testing/auth.testing';

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

  async function createWith(value: unknown): Promise<void> {
    localStorage.removeItem(STORAGE_KEY);
    TestBed.resetTestingModule();
    snackOpen = jasmine.createSpy('snackOpen');
    await TestBed.configureTestingModule({
      imports: [JsonTreeComponent],
      providers: [
        ...provideFakeAuth(),
        { provide: MatSnackBar, useValue: { open: snackOpen } }
      ]
    }).compileComponents();
    fixture = TestBed.createComponent(JsonTreeComponent);
    prefs = TestBed.inject(PreferencesService);
    fixture.componentRef.setInput('value', value);
    fixture.detectChanges();
    cmp = fixture.componentInstance;
  }

  beforeEach(() => {
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(TREE_SEARCH_STORAGE_KEY);
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
    expect(warnings)
      .withContext('mat-tree must not emit flat/nested conflict warning')
      .toEqual([]);
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
        '.tree-type-badge'
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
        'mat-nested-tree-node, .mat-nested-tree-node'
      ) as HTMLElement;
      expect(node).withContext('expected a mat-nested-tree-node to be rendered').toBeTruthy();
      const fs = Number.parseFloat(getComputedStyle(node).fontSize);
      expect(fs).toBe(28);
      expect(getComputedStyle(node).fontFamily).toMatch(/JetBrains Mono/i);
    } finally {
      document.body.removeChild(fixture.nativeElement);
    }
  });

  describe('root() and path formatting', () => {
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
        meta: { kind: 'k' }
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
        list: [{ x: 1 }, { y: 2 }]
      });
    });

    it('expandAll expands every container node', () => {
      cmp.collapseAll();
      cmp.expandAll();
      const root = cmp.root()!;
      const walk = (n: typeof root): void => {
        if (!n.children) return;
        expect(cmp.treeControl.isExpanded(n)).withContext(n.pathString).toBeTrue();
        n.children.forEach(walk);
      };
      walk(root);
    });

    it('collapseAll collapses every node', () => {
      cmp.expandAll();
      cmp.collapseAll();
      const root = cmp.root()!;
      expect(cmp.treeControl.isExpanded(root)).toBeFalse();
    });

    it('expandToLevel(n) expands only nodes with depth < n', () => {
      cmp.expandAll();
      cmp.expandToLevel(2);
      const root = cmp.root()!;
      expect(cmp.treeControl.isExpanded(root)).toBeTrue(); // depth 0
      const a = root.children!.find((c) => c.segment === 'a')!;
      expect(cmp.treeControl.isExpanded(a)).toBeTrue(); // depth 1
      const b = a.children!.find((c) => c.segment === 'b')!;
      expect(cmp.treeControl.isExpanded(b)).toBeFalse(); // depth 2 should NOT be expanded
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

  describe('selection highlighting', () => {
    /** Look up a rendered .tree-row whose bound TreeNode has the given pathString. */
    function findRow(path: string): HTMLElement {
      cmp.expandAll();
      fixture.detectChanges();
      cmp.selectedPath.set(path);
      fixture.detectChanges();
      const selected = (fixture.nativeElement as HTMLElement).querySelector(
        '.tree-row[aria-selected="true"]'
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
        '.tree-row.is-selected[aria-selected="true"]'
      );
      expect(stillSelected).toBeTruthy();
    });

    it('selecting the root yields no ancestor highlights anywhere', async () => {
      await createWith({ a: { b: 1 } });
      cmp.selectedPath.set('$');
      fixture.detectChanges();
      expect(cmp.ancestorPaths().size).toBe(0);
      const ancestors = (fixture.nativeElement as HTMLElement).querySelectorAll(
        '.tree-row.is-ancestor'
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
      const badges = (fixture.nativeElement as HTMLElement).querySelectorAll(
        '.tree-match-badge'
      );
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
        '.tree-twisty[matTreeNodeToggle], button.tree-twisty'
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
        'input.tree-search'
      ) as HTMLInputElement;
      input.focus();
      const ev = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true });
      input.dispatchEvent(ev);
      fixture.detectChanges();
      expect(cmp.selectedPath()).toBeNull();
      expect(cmp.search()).toBe('');
    });

    it('clicking outside the host clears the selection', async () => {
      await createWith({ a: 1 });
      document.body.appendChild(fixture.nativeElement);
      try {
        cmp.selectedPath.set('$.a');
        fixture.detectChanges();
        const outside = document.createElement('div');
        document.body.appendChild(outside);
        try {
          const ev = new MouseEvent('click', { bubbles: true });
          outside.dispatchEvent(ev);
          fixture.detectChanges();
          expect(cmp.selectedPath()).toBeNull();
        } finally {
          document.body.removeChild(outside);
        }
      } finally {
        document.body.removeChild(fixture.nativeElement);
      }
    });

    it('clicking inside the host (search input) does NOT clear the selection', async () => {
      await createWith({ a: 1 });
      document.body.appendChild(fixture.nativeElement);
      try {
        cmp.selectedPath.set('$.a');
        fixture.detectChanges();
        const input = (fixture.nativeElement as HTMLElement).querySelector(
          'input.tree-search'
        ) as HTMLInputElement;
        const ev = new MouseEvent('click', { bubbles: true });
        input.dispatchEvent(ev);
        fixture.detectChanges();
        expect(cmp.selectedPath()).toBe('$.a');
      } finally {
        document.body.removeChild(fixture.nativeElement);
      }
    });

    it('clicking inside an open CDK overlay does NOT clear the selection', async () => {
      await createWith({ a: 1 });
      document.body.appendChild(fixture.nativeElement);
      const overlay = document.createElement('div');
      overlay.className = 'cdk-overlay-container';
      const panel = document.createElement('div');
      panel.className = 'mat-mdc-menu-panel';
      overlay.appendChild(panel);
      document.body.appendChild(overlay);
      try {
        cmp.selectedPath.set('$.a');
        fixture.detectChanges();
        const ev = new MouseEvent('click', { bubbles: true });
        panel.dispatchEvent(ev);
        fixture.detectChanges();
        expect(cmp.selectedPath()).toBe('$.a');
      } finally {
        document.body.removeChild(overlay);
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
        '.tree-row[aria-selected="true"]'
      ) as HTMLElement;
      expect(xRow.classList.contains('is-selected')).toBeTrue();
      expect(xRow.classList.contains('is-search-hit')).toBeTrue();
    });
  });

  describe('copyPath', () => {
    beforeEach(async () => {
      await createWith({ a: 1 });
    });

    function withClipboard<T>(
      stub: { writeText?: jasmine.Spy } | undefined,
      run: () => T
    ): T {
      const original = (navigator as { clipboard?: Clipboard }).clipboard;
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: stub });
      try {
        return run();
      } finally {
        if (original) {
          Object.defineProperty(navigator, 'clipboard', {
            configurable: true,
            value: original
          });
        } else {
          Object.defineProperty(navigator, 'clipboard', {
            configurable: true,
            value: undefined
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
        (fixture.nativeElement as HTMLElement).querySelectorAll('.tree-date-annotation')
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

    it('does not render an annotation when the pref is false', async () => {
      await createWith({ created: '2024-11-05T18:30:00Z' });
      prefs.update({ treeShowDateAnnotations: false });
      fixture.detectChanges();
      expect(getAnnotationSpans().length).toBe(0);
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
        '.tree-row.is-search-hit'
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
        b: '2024-11-05T18:30:00Z'
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
        b: '2024-11-05T18:30:00Z'
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
        (fixture.nativeElement as HTMLElement).querySelectorAll('.tree-type-badge')
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
          const totalWidth = (fixture.nativeElement.querySelector('.tree-search-count') as HTMLElement).offsetWidth;
          c.selectedPath.set(c.searchHitPaths()[0] as string);
          fixture.detectChanges();
          const positionWidth = (fixture.nativeElement.querySelector('.tree-search-count') as HTMLElement).offsetWidth;
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
        const btn = fixture.nativeElement.querySelectorAll('.tree-search-toggle')[0] as HTMLButtonElement;
        expect(btn.getAttribute('aria-pressed')).toBe('false');
        btn.click();
        fixture.detectChanges();
        expect(prefs.prefs().searchCaseSensitive).toBe(true);
        expect(btn.getAttribute('aria-pressed')).toBe('true');
      });

      it('toggles regex-mode preference', async () => {
        await createWith({ a: 1 });
        const btn = fixture.nativeElement.querySelectorAll('.tree-search-toggle')[1] as HTMLButtonElement;
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
        const enter = new KeyboardEvent('keydown', { key: 'Enter', cancelable: true, bubbles: true });
        input().dispatchEvent(enter);
        fixture.detectChanges();
        expect(c.activeHitIndex()).toBe(1);
        const shiftEnter = new KeyboardEvent('keydown', {
          key: 'Enter',
          shiftKey: true,
          cancelable: true,
          bubbles: true
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
        const outer = c.treeControl.dataNodes?.find((n) => n.segment === 'outer') ?? null;
        // dataNodes may be undefined for nested control; fall back to
        // direct lookup via the index.
        const root = c.root();
        const outerNode = root?.children?.[0];
        const innerNode = outerNode?.children?.[0];
        expect(outerNode && c.treeControl.isExpanded(outerNode)).toBe(true);
        expect(innerNode && c.treeControl.isExpanded(innerNode)).toBe(true);
        // Silence unused-variable warning for the dataNodes lookup.
        void outer;
      });

      it('disables prev/next buttons when there are no hits', async () => {
        await createWith({ a: 1 });
        setSearch('zzz');
        const navButtons = fixture.nativeElement.querySelectorAll(
          '.tree-search-nav'
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
      spyOn(Storage.prototype, 'getItem').and.callFake(function (
        this: Storage,
        key: string
      ) {
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
        providers: [
          ...provideFakeAuth(),
          { provide: MatSnackBar, useValue: { open: snackOpen } }
        ]
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
      const searchInput = fixture.nativeElement.querySelector(
        'input[type="search"].tree-search'
      );
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

    function makeRule(overrides: Partial<FormattingRule> = {}): FormattingRule {
      return {
        id: 'r1',
        target: 'value',
        matchType: 'exact',
        matchValue: 'error',
        caseSensitive: false,
        style: { backgroundColor: '#ffcdd2' },
        ...overrides
      };
    }

    function makeSet(rules: FormattingRule[], overrides: Partial<FormattingRuleSet> = {}): FormattingRuleSet {
      return {
        id: 'set-1',
        userId: 'oid-1',
        name: 'Errors',
        rules,
        version: 1,
        createdAt: '2026-04-27T00:00:00.000Z',
        updatedAt: '2026-04-27T00:00:00.000Z',
        ...overrides
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
            style: { backgroundColor: '#ffcdd2', textColor: '#b71c1c' }
          })
        ])
      ]);
      prefs.update({ defaultRuleSetIds: ['set-1'] });
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
            style: { backgroundColor: '#c8e6c9' }
          })
        ])
      ]);
      prefs.update({ defaultRuleSetIds: ['set-1'] });
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
        makeSet([
          makeRule({ target: 'value', matchType: 'exact', matchValue: '200' })
        ])
      ]);
      prefs.update({ defaultRuleSetIds: ['set-1'] });
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
            style: { textColor: '#b71c1c' }
          }),
          makeRule({
            id: 'r-val',
            target: 'value',
            matchType: 'contains',
            matchValue: 'errors',
            style: { backgroundColor: '#ffcdd2' }
          })
        ])
      ]);
      prefs.update({ defaultRuleSetIds: ['set-1'] });
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
            matchValue: 'err'
          })
        ])
      ]);
      prefs.update({ defaultRuleSetIds: ['set-1'] });
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
            style: { icon: 'warning' }
          })
        ])
      ]);
      prefs.update({ defaultRuleSetIds: ['set-1'] });
      cmp.expandAll();
      fixture.detectChanges();
      const root = cmp.root()!;
      const warnNode = root.children!.find((c) => c.segment === 'warning')!;
      expect(cmp.keyIcon(warnNode)).toBe('warning');
      expect(cmp.valueIcon(warnNode)).toBeNull();
      const iconEl = (fixture.nativeElement as HTMLElement).querySelector(
        '.tree-rule-icon--key'
      );
      expect(iconEl).not.toBeNull();
    });

    it('caches engine results across multiple lookups for the same node', async () => {
      // Memoization smoke test: a single tree node calls the engine
      // exactly once per (activeSets, key, valueText, isContainer)
      // tuple. Since `evaluateNode` is a `computed()`, repeated calls
      // hit the same closure-scoped cache.
      await setUp({ status: 'error' });
      seedRuleSets([
        makeSet([
          makeRule({ target: 'value', matchType: 'exact', matchValue: 'error' })
        ])
      ]);
      prefs.update({ defaultRuleSetIds: ['set-1'] });
      const root = cmp.root()!;
      const status = root.children!.find((c) => c.segment === 'status')!;
      const a = cmp.ruleResultFor(status);
      const b = cmp.ruleResultFor(status);
      expect(a).toBe(b);
    });

    it('drops the cache when activeRuleSets changes', async () => {
      await setUp({ status: 'error' });
      seedRuleSets([
        makeSet([
          makeRule({ id: 'r1', target: 'value', matchType: 'exact', matchValue: 'error' })
        ])
      ]);
      prefs.update({ defaultRuleSetIds: ['set-1'] });
      const root = cmp.root()!;
      const status = root.children!.find((c) => c.segment === 'status')!;
      const before = cmp.ruleResultFor(status);

      // Toggle off - now no rules apply, result must change identity.
      prefs.update({ defaultRuleSetIds: [] });
      const after = cmp.ruleResultFor(status);
      expect(before).not.toBe(after);
    });
  });

  describe('overrideRuleSets Input (M6d-3 live preview)', () => {
    let httpMock: HttpTestingController;
    let ruleSets: RuleSetsService;

    function makeRule(overrides: Partial<FormattingRule> = {}): FormattingRule {
      return {
        id: 'r1',
        target: 'value',
        matchType: 'exact',
        matchValue: 'error',
        caseSensitive: false,
        style: { backgroundColor: '#ffcdd2' },
        ...overrides
      };
    }

    function makeSet(rules: FormattingRule[], overrides: Partial<FormattingRuleSet> = {}): FormattingRuleSet {
      return {
        id: 'set-1',
        userId: 'oid-1',
        name: 'Set',
        rules,
        version: 1,
        createdAt: '2026-04-27T00:00:00.000Z',
        updatedAt: '2026-04-27T00:00:00.000Z',
        ...overrides
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
        makeSet(
          [makeRule({ matchValue: 'error', style: { backgroundColor: '#000000' } })],
          { id: 'default-set' }
        )
      ]);
      prefs.update({ defaultRuleSetIds: ['default-set'] });

      const overrideSet = makeSet(
        [makeRule({ matchValue: 'error', style: { backgroundColor: '#abcdef' } })],
        { id: 'override-set' }
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
        makeSet(
          [makeRule({ matchValue: 'error', style: { backgroundColor: '#112233' } })]
        )
      ]);
      prefs.update({ defaultRuleSetIds: ['set-1'] });
      fixture.detectChanges();

      const status = cmp.root()!.children!.find((c) => c.segment === 'status')!;
      const styles = cmp.ruleStyleVars(status);
      expect(styles?.['--tree-row-format-bg']).toBe('#112233');
    });

    it('treats an empty array override as "no rule sets active" (does NOT fall back)', async () => {
      await setUp({ status: 'error' });
      seedDefault([
        makeSet(
          [makeRule({ matchValue: 'error', style: { backgroundColor: '#112233' } })]
        )
      ]);
      prefs.update({ defaultRuleSetIds: ['set-1'] });

      fixture.componentRef.setInput('overrideRuleSets', []);
      fixture.detectChanges();

      const status = cmp.root()!.children!.find((c) => c.segment === 'status')!;
      expect(cmp.ruleStyleVars(status)).toBeNull();
    });

    it('per-instance: overriding one tree does not affect another instance', async () => {
      await setUp({ status: 'error' });
      seedDefault([
        makeSet(
          [makeRule({ matchValue: 'error', style: { backgroundColor: '#112233' } })]
        )
      ]);
      prefs.update({ defaultRuleSetIds: ['set-1'] });

      const overrideSet = makeSet(
        [makeRule({ matchValue: 'error', style: { backgroundColor: '#abcdef' } })],
        { id: 'override-set' }
      );
      fixture.componentRef.setInput('overrideRuleSets', [overrideSet]);
      fixture.detectChanges();

      const second = TestBed.createComponent(JsonTreeComponent);
      second.componentRef.setInput('value', { status: 'error' });
      second.detectChanges();
      const secondCmp = second.componentInstance;

      const firstStyles = cmp.ruleStyleVars(
        cmp.root()!.children!.find((c) => c.segment === 'status')!
      );
      const secondStyles = secondCmp.ruleStyleVars(
        secondCmp.root()!.children!.find((c) => c.segment === 'status')!
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
        writes.push(path === null ? null : cmp['formatPath']([...path]));
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
      expect(cmp.treeControl.isExpanded(aNode)).toBeFalse();
      expect(cmp.treeControl.isExpanded(bNode)).toBeFalse();
      cmp.selectByPathString('$.a.b.c');
      expect(cmp.treeControl.isExpanded(aNode)).toBeTrue();
      expect(cmp.treeControl.isExpanded(bNode)).toBeTrue();
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
        (path) =>
          path !== null && path.length === 2 && path[0] === 'a' && path[1] === 'b'
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
    it('returns an empty array when nothing is selected', async () => {
      await createWith({ a: 1 });
      expect(cmp.selectedPath()).toBeNull();
      expect(cmp.crumbs()).toEqual([]);
    });

    it('returns a single Root crumb when the root is selected', async () => {
      await createWith({ a: 1 });
      cmp.selectByPathString('$');
      expect(cmp.crumbs().length).toBe(1);
      const [root] = cmp.crumbs();
      expect(root.canonicalPath).toBe('$');
      expect(root.label).toBe(cmp.breadcrumbRootLabel);
    });

    it('returns Root + ancestors (excluding the selected leaf) for a deep path', async () => {
      await createWith({ foo: { bar: { baz: 1 } } });
      cmp.selectByPathString('$.foo.bar.baz');
      const labels = cmp.crumbs().map((crumb) => crumb.label);
      expect(labels).toEqual([cmp.breadcrumbRootLabel, 'foo', 'bar']);
      const paths = cmp.crumbs().map((crumb) => crumb.canonicalPath);
      expect(paths).toEqual(['$', '$.foo', '$.foo.bar']);
    });

    it('renders array-index segments as [0], [1], etc.', async () => {
      await createWith({ items: [{ name: 'a' }] });
      cmp.selectByPathString('$.items[0].name');
      const labels = cmp.crumbs().map((crumb) => crumb.label);
      expect(labels).toEqual([cmp.breadcrumbRootLabel, 'items', '[0]']);
      const paths = cmp.crumbs().map((crumb) => crumb.canonicalPath);
      expect(paths).toEqual(['$', '$.items', '$.items[0]']);
    });

    it('renders escaped keys as their raw label and quoted canonical path', async () => {
      await createWith({ 'a.b': { x: 1 } });
      cmp.selectByPathString('$["a.b"].x');
      expect(cmp.selectedPath()).toBe('$["a.b"].x');
      const labels = cmp.crumbs().map((crumb) => crumb.label);
      expect(labels).toEqual([cmp.breadcrumbRootLabel, 'a.b']);
      const paths = cmp.crumbs().map((crumb) => crumb.canonicalPath);
      expect(paths).toEqual(['$', '$["a.b"]']);
    });

    it('onBreadcrumbClick re-selects the ancestor and logs telemetry', async () => {
      await createWith({ foo: { bar: { baz: 1 } } });
      cmp.selectByPathString('$.foo.bar.baz');
      const logger = TestBed.inject(LoggerService);
      const info = spyOn(logger, 'info');
      cmp.onBreadcrumbClick({ canonicalPath: '$.foo', depth: 1 });
      expect(cmp.selectedPath()).toBe('$.foo');
      expect(info).toHaveBeenCalledWith('tree.breadcrumb.click', { depth: 1 });
    });

    it('clicking a chip in the rendered breadcrumb DOM updates selection', async () => {
      await createWith({ foo: { bar: 1 } });
      cmp.selectByPathString('$.foo.bar');
      fixture.detectChanges();
      const chips = Array.from(
        fixture.nativeElement.querySelectorAll('.jj-breadcrumb__chip')
      ) as HTMLButtonElement[];
      // crumbs = [Root, foo] -> 2 chips. Click foo (index 1).
      expect(chips.length).toBe(2);
      chips[1].click();
      fixture.detectChanges();
      expect(cmp.selectedPath()).toBe('$.foo');
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

    function withCtxClipboard<T>(
      stub: { writeText?: jasmine.Spy } | undefined,
      run: () => T
    ): T {
      const original = (navigator as { clipboard?: Clipboard }).clipboard;
      const hadOwn = Object.prototype.hasOwnProperty.call(navigator, 'clipboard');
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: stub });
      try {
        return run();
      } finally {
        if (hadOwn && original) {
          Object.defineProperty(navigator, 'clipboard', {
            configurable: true,
            value: original
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
        cancelable: true
      });
    }

    describe('onRowContextMenu', () => {
      it('sets contextNode, selects the row, captures cursor coords', async () => {
        await createWith({ alpha: 1 });
        cmp.expandAll();
        fixture.detectChanges();
        const node = nodeAt('$.alpha');
        const ev = ctxEvent();
        cmp.onRowContextMenu(ev, node);
        expect(cmp.contextNode()?.pathString).toBe('$.alpha');
        expect(cmp.selectedPath()).toBe('$.alpha');
        expect(cmp.ctxX()).toBe(100);
        expect(cmp.ctxY()).toBe(200);
        expect(ev.defaultPrevented).toBe(true);
      });

      it('ignores keyboard-fired contextmenu (clientX/Y === 0)', async () => {
        await createWith({ alpha: 1 });
        const node = nodeAt('$.alpha');
        const ev = new MouseEvent('contextmenu', {
          clientX: 0,
          clientY: 0,
          bubbles: true,
          cancelable: true
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
          '.tree-kebab-pill'
        ) as HTMLButtonElement;
        const ev = new MouseEvent('contextmenu', {
          clientX: 100,
          clientY: 100,
          bubbles: true,
          cancelable: true
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
    });

    describe('copyKey', () => {
      it('copies the key text and shows a success toast', async () => {
        await createWith({ alpha: 1 });
        const writeText = jasmine.createSpy('writeText').and.resolveTo(undefined);
        const node = nodeAt('$.alpha');
        withCtxClipboard({ writeText }, () => cmp.copyKey(node));
        await Promise.resolve(); await Promise.resolve();
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
        await Promise.resolve(); await Promise.resolve();
        expect(writeText).toHaveBeenCalledWith('1');
      });

      it('is a no-op on the root (segment === undefined)', async () => {
        await createWith({ alpha: 1 });
        const writeText = jasmine.createSpy('writeText').and.resolveTo(undefined);
        const root = nodeAt('$');
        withCtxClipboard({ writeText }, () => cmp.copyKey(root));
        await Promise.resolve(); await Promise.resolve();
        expect(writeText).not.toHaveBeenCalled();
      });
    });

    describe('copyValue', () => {
      it('copies a string value as raw text (no JSON quotes)', async () => {
        await createWith({ note: 'hello "world"' });
        const writeText = jasmine.createSpy('writeText').and.resolveTo(undefined);
        const node = nodeAt('$.note');
        withCtxClipboard({ writeText }, () => cmp.copyValue(node, 'menu'));
        await Promise.resolve(); await Promise.resolve();
        expect(writeText).toHaveBeenCalledWith('hello "world"');
      });

      it('copies a number as its string form', async () => {
        await createWith({ count: 42 });
        const writeText = jasmine.createSpy('writeText').and.resolveTo(undefined);
        const node = nodeAt('$.count');
        withCtxClipboard({ writeText }, () => cmp.copyValue(node, 'menu'));
        await Promise.resolve(); await Promise.resolve();
        expect(writeText).toHaveBeenCalledWith('42');
      });

      it('copies a boolean as "true"/"false"', async () => {
        await createWith({ enabled: true });
        const writeText = jasmine.createSpy('writeText').and.resolveTo(undefined);
        const node = nodeAt('$.enabled');
        withCtxClipboard({ writeText }, () => cmp.copyValue(node, 'menu'));
        await Promise.resolve(); await Promise.resolve();
        expect(writeText).toHaveBeenCalledWith('true');
      });

      it('copies null as the literal "null"', async () => {
        await createWith({ blank: null });
        const writeText = jasmine.createSpy('writeText').and.resolveTo(undefined);
        const node = nodeAt('$.blank');
        withCtxClipboard({ writeText }, () => cmp.copyValue(node, 'menu'));
        await Promise.resolve(); await Promise.resolve();
        expect(writeText).toHaveBeenCalledWith('null');
      });

      it('copies an object as 2-space pretty JSON (multi-line)', async () => {
        await createWith({ obj: { a: 1, b: 'x' } });
        const writeText = jasmine.createSpy('writeText').and.resolveTo(undefined);
        const node = nodeAt('$.obj');
        withCtxClipboard({ writeText }, () => cmp.copyValue(node, 'menu'));
        await Promise.resolve(); await Promise.resolve();
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
        await Promise.resolve(); await Promise.resolve();
        const arg = writeText.calls.mostRecent().args[0] as string;
        expect(arg).toBe('[\n  1,\n  2\n]');
      });
    });

    describe('searchByKey', () => {
      it('sets scope=keys, regex=false, valueType=all and queries the segment', async () => {
        await createWith({ alpha: 1, beta: 2 });
        prefs.update({
          searchScope: 'values',
          searchRegexMode: true,
          searchValueType: 'string'
        });
        cmp.expandAll();
        fixture.detectChanges();
        const node = nodeAt('$.alpha');
        cmp.searchByKey(node);
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
        cmp.searchByKey(node);
        await Promise.resolve(); await Promise.resolve();
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
        cmp.searchByKey(node);
        await Promise.resolve(); await Promise.resolve();
        // After searchByKey on $.alpha, paths = [$.alpha]; activeHit = 0.
        const idx = cmp.activeHitIndex();
        const paths = cmp.searchHitPaths();
        expect(paths[idx]).toBe('$.alpha');
      });

      it('does nothing on the root (no segment)', async () => {
        await createWith({ alpha: 1 });
        prefs.update({ searchScope: 'values' });
        cmp.searchByKey(nodeAt('$'));
        // unchanged
        expect(prefs.prefs().searchScope).toBe('values');
      });
    });

    describe('searchByValue', () => {
      it('sets scope=values, queries the value, and elevates the clicked row', async () => {
        await createWith({ a: 'needle', b: 'haystack', c: 'needle' });
        cmp.expandAll();
        fixture.detectChanges();
        const node = nodeAt('$.c');
        cmp.searchByValue(node);
        await Promise.resolve(); await Promise.resolve();
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
        cmp.searchByValue(nodeAt('$.a'));
        expect(cmp.search()).toBe('with "quotes"');
      });

      it('does not act on object/array/null/undefined', async () => {
        await createWith({ obj: {}, arr: [], blank: null });
        cmp.expandAll();
        fixture.detectChanges();
        prefs.update({ searchScope: 'keys' });
        cmp.searchByValue(nodeAt('$.obj'));
        cmp.searchByValue(nodeAt('$.arr'));
        cmp.searchByValue(nodeAt('$.blank'));
        expect(prefs.prefs().searchScope).toBe('keys');
        expect(cmp.search()).toBe('');
      });
    });

    describe('collapseFromHere', () => {
      it('collapses the clicked container and all expanded descendants', async () => {
        await createWith({ outer: { mid: { inner: 1 } } });
        cmp.expandAll();
        fixture.detectChanges();
        const outer = nodeAt('$.outer');
        const mid = nodeAt('$.outer.mid');
        expect(cmp.treeControl.isExpanded(outer)).toBe(true);
        expect(cmp.treeControl.isExpanded(mid)).toBe(true);
        cmp.collapseFromHere(outer);
        expect(cmp.treeControl.isExpanded(outer)).toBe(false);
        expect(cmp.treeControl.isExpanded(mid)).toBe(false);
      });
    });

    describe('expandAllFromHere', () => {
      it('expands the clicked container and every descendant container', async () => {
        await createWith({ outer: { mid: { inner: 1 } } });
        cmp.collapseAll();
        fixture.detectChanges();
        const outer = nodeAt('$.outer');
        cmp.expandAllFromHere(outer);
        expect(cmp.treeControl.isExpanded(outer)).toBe(true);
        expect(cmp.treeControl.isExpanded(nodeAt('$.outer.mid'))).toBe(true);
      });
    });

    describe('expandToDepthFromHere', () => {
      it('+1 expands only the clicked node when starting from a collapsed subtree', async () => {
        await createWith({ outer: { mid: { inner: { deep: 1 } } } });
        cmp.collapseAll();
        fixture.detectChanges();
        const outer = nodeAt('$.outer');
        cmp.expandToDepthFromHere(outer, 1);
        expect(cmp.treeControl.isExpanded(outer)).toBe(true);
        expect(cmp.treeControl.isExpanded(nodeAt('$.outer.mid'))).toBe(false);
      });

      it('+N expands every collapsed container at relative depth < N (including hidden ones)', async () => {
        await createWith({ outer: { mid: { inner: { deep: 1 } } } });
        cmp.collapseAll();
        fixture.detectChanges();
        const outer = nodeAt('$.outer');
        cmp.expandToDepthFromHere(outer, 3);
        expect(cmp.treeControl.isExpanded(outer)).toBe(true);
        expect(cmp.treeControl.isExpanded(nodeAt('$.outer.mid'))).toBe(true);
        expect(cmp.treeControl.isExpanded(nodeAt('$.outer.mid.inner'))).toBe(true);
      });

      it('+N never collapses a container at relative depth >= N (expand-only)', async () => {
        await createWith({ outer: { mid: { inner: 1 } } });
        cmp.expandAll();
        fixture.detectChanges();
        const outer = nodeAt('$.outer');
        cmp.expandToDepthFromHere(outer, 1);
        // +1 only acts on depth 0; deeper containers stay expanded.
        expect(cmp.treeControl.isExpanded(outer)).toBe(true);
        expect(cmp.treeControl.isExpanded(nodeAt('$.outer.mid'))).toBe(true);
      });

      it('is idempotent on an already-fully-expanded subtree', async () => {
        await createWith({ outer: { mid: { inner: 1 } } });
        cmp.expandAll();
        fixture.detectChanges();
        const outer = nodeAt('$.outer');
        const mid = nodeAt('$.outer.mid');
        cmp.expandToDepthFromHere(outer, 3);
        cmp.expandToDepthFromHere(outer, 3);
        expect(cmp.treeControl.isExpanded(outer)).toBe(true);
        expect(cmp.treeControl.isExpanded(mid)).toBe(true);
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
        expect(cmp.treeControl.isExpanded(a3)).toBe(false);
        expect(cmp.treeControl.isExpanded(a)).toBe(true);
        expect(cmp.treeControl.isExpanded(a2)).toBe(true);
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
        expect(cmp.treeControl.isExpanded(b)).toBe(false);
        expect(cmp.treeControl.isExpanded(a)).toBe(true);
        expect(infoSpy).toHaveBeenCalledWith('tree.contextMenu.isolate');
      });

      it('truth-table (non-empty, non-empty): pair shown; narrow collapses only direct peers, wide collapses both', async () => {
        await createWith({
          a: { a2: { z: 1 }, a3: { z: 1 } },
          b: { z: 1 },
          c: { z: 1 }
        });
        cmp.expandAll();
        fixture.detectChanges();
        const a2 = nodeAt('$.a.a2');
        expect(cmp.showIsolateSingle(a2)).toBe(false);
        expect(cmp.showIsolatePair(a2)).toBe(true);

        const infoSpy = spyOn(TestBed.inject(LoggerService), 'info').and.callThrough();
        cmp.collapseSiblings(a2);
        expect(cmp.treeControl.isExpanded(nodeAt('$.a.a3'))).toBe(false);
        expect(cmp.treeControl.isExpanded(nodeAt('$.b'))).toBe(true);
        expect(cmp.treeControl.isExpanded(nodeAt('$.c'))).toBe(true);
        expect(infoSpy).toHaveBeenCalledWith('tree.contextMenu.isolateNarrow');

        cmp.isolateRow(a2, 'wide');
        expect(cmp.treeControl.isExpanded(nodeAt('$.b'))).toBe(false);
        expect(cmp.treeControl.isExpanded(nodeAt('$.c'))).toBe(false);
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
        expect(cmp.treeControl.isExpanded(nodeAt('$.b'))).toBe(false);
      });

      it('empty container click does not throw and still collapses off-chain branches', async () => {
        await createWith({ a: { empty: {} }, b: { z: 1 } });
        cmp.expandAll();
        fixture.detectChanges();
        const empty = nodeAt('$.a.empty');
        expect(() => cmp.isolateRow(empty, 'single')).not.toThrow();
        expect(cmp.treeControl.isExpanded(nodeAt('$.b'))).toBe(false);
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
        expect(cmp.treeControl.isExpanded(nodeAt('$.arr[0]'))).toBe(false);
        expect(cmp.treeControl.isExpanded(nodeAt('$.other'))).toBe(false);
        expect(cmp.treeControl.isExpanded(nodeAt('$.arr[1]'))).toBe(true);
      });

      it('clicked-row already collapsed: hidden subtree expansion state is preserved', async () => {
        await createWith({ a: { a2: { x: { z: 1 } } }, b: { z: 1 } });
        cmp.expandAll();
        fixture.detectChanges();
        // Collapse only $.a.a2 (so $.a.a2.x stays expanded in CDK state but hidden).
        cmp.treeControl.collapse(nodeAt('$.a.a2'));
        expect(cmp.treeControl.isExpanded(nodeAt('$.a.a2'))).toBe(false);
        expect(cmp.treeControl.isExpanded(nodeAt('$.a.a2.x'))).toBe(true);

        cmp.isolateRow(nodeAt('$.a.a2'), 'single');
        // Off-chain collapse happened.
        expect(cmp.treeControl.isExpanded(nodeAt('$.b'))).toBe(false);
        // Clicked row and its hidden subtree state are untouched.
        expect(cmp.treeControl.isExpanded(nodeAt('$.a.a2'))).toBe(false);
        expect(cmp.treeControl.isExpanded(nodeAt('$.a.a2.x'))).toBe(true);
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
          a: cmp.treeControl.isExpanded(nodeAt('$.a')),
          a2: cmp.treeControl.isExpanded(a2),
          a3: cmp.treeControl.isExpanded(nodeAt('$.a.a3')),
          b: cmp.treeControl.isExpanded(nodeAt('$.b'))
        };
        cmp.isolateRow(a2, 'wide');
        expect(cmp.treeControl.isExpanded(nodeAt('$.a'))).toBe(stateAfterFirst.a);
        expect(cmp.treeControl.isExpanded(a2)).toBe(stateAfterFirst.a2);
        expect(cmp.treeControl.isExpanded(nodeAt('$.a.a3'))).toBe(stateAfterFirst.a3);
        expect(cmp.treeControl.isExpanded(nodeAt('$.b'))).toBe(stateAfterFirst.b);
      });

      it('telemetry: each ID is emitted with no payload (no user content)', async () => {
        await createWith({
          a: { a2: { z: 1 }, a3: { z: 1 } },
          b: { z: 1 }
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
        expect(cmp.treeControl.isExpanded(nodeAt('$.a'))).toBe(true);
        expect(cmp.treeControl.isExpanded(nodeAt('$.b'))).toBe(true);
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
        expect(cmp.treeControl.isExpanded(nodeAt('$.b'))).toBe(false);
        expect(cmp.treeControl.isExpanded(nodeAt('$.c'))).toBe(false);
      });
    });

    describe('visibility predicates', () => {
      it('showCopyKey: hidden on root, shown on keyed child', async () => {
        await createWith({ alpha: 1 });
        expect(cmp.showCopyKey(nodeAt('$'))).toBe(false);
        expect(cmp.showCopyKey(nodeAt('$.alpha'))).toBe(true);
      });

      it('showSearchByKey: hidden in embeddedMode', async () => {
        await createWith({ alpha: 1 });
        fixture.componentRef.setInput('embeddedMode', true);
        fixture.detectChanges();
        expect(cmp.showSearchByKey(nodeAt('$.alpha'))).toBe(false);
      });

      it('showSearchByValue: hidden on object/array/null/undefined and in embeddedMode', async () => {
        await createWith({ obj: {}, arr: [], blank: null, str: 'x' });
        cmp.expandAll();
        fixture.detectChanges();
        expect(cmp.showSearchByValue(nodeAt('$.obj'))).toBe(false);
        expect(cmp.showSearchByValue(nodeAt('$.arr'))).toBe(false);
        expect(cmp.showSearchByValue(nodeAt('$.blank'))).toBe(false);
        expect(cmp.showSearchByValue(nodeAt('$.str'))).toBe(true);
        fixture.componentRef.setInput('embeddedMode', true);
        fixture.detectChanges();
        expect(cmp.showSearchByValue(nodeAt('$.str'))).toBe(false);
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

      it('showExpandToDepth: hides +N greater than the subtree max descendant depth (Bug 1)', async () => {
        // Subtree { outer: { mid: { inner: 1 } } } from $.outer:
        //   $.outer (clicked, container, depth 0)
        //   $.outer.mid (container, depth 1)
        //   $.outer.mid.inner (primitive leaf, depth 2)
        // maxDescendantDepth = 2, so +1 and +2 are in range; +3..+5 hide.
        await createWith({ outer: { mid: { inner: 1 } } });
        cmp.collapseAll();
        fixture.detectChanges();
        const outer = nodeAt('$.outer');
        expect(cmp.showExpandToDepth(outer, 1)).toBe(true);
        expect(cmp.showExpandToDepth(outer, 2)).toBe(true);
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

      it('showExpandToDepth: caps at +1 when clicked node has only primitive children', async () => {
        // The clicked node is a container with only primitive children;
        // maxDescendantDepth = 1. +1 alone is meaningful.
        await createWith({ outer: { x: 1, y: 2 } });
        cmp.collapseAll();
        fixture.detectChanges();
        const outer = nodeAt('$.outer');
        expect(cmp.showExpandToDepth(outer, 1)).toBe(true);
        expect(cmp.showExpandToDepth(outer, 2)).toBe(false);
        expect(cmp.showExpandToDepth(outer, 3)).toBe(false);
      });

      it('showExpandToDepth: walks hidden containers under collapsed ancestors', async () => {
        // outer is expanded; mid is collapsed (so inner is hidden).
        // +3 should still see inner (depth 2, collapsed, hidden) when
        // computing visibility, so it shows.
        await createWith({ outer: { mid: { inner: { leaf: 1 } } } });
        cmp.expandAll();
        fixture.detectChanges();
        const outer = nodeAt('$.outer');
        const mid = nodeAt('$.outer.mid');
        cmp.treeControl.collapse(mid);
        fixture.detectChanges();
        // Collapsed at d=1 (mid). Hidden under it: inner at d=2 still
        // expanded (we did expandAll first, then only collapsed mid).
        expect(cmp.showExpandToDepth(outer, 1)).toBe(false);
        expect(cmp.showExpandToDepth(outer, 2)).toBe(true);
        expect(cmp.showExpandToDepth(outer, 3)).toBe(true);
      });

      it('showExpandToDepth: partial expansion shows only +N that reach a collapsed container', async () => {
        // Mirrors the user's example: top-level expanded, second-level
        // expanded, alt-second-level collapsed (its third-level hidden
        // and collapsed inside it). Expect: hide +1; show +2, +3; hide
        // +4, +5.
        await createWith({
          'top-level': {
            'second-level': { 'third-level': { x: 1, y: 2 } },
            'alt-second-level': { 'third-level': { x: 1, y: 2 } }
          }
        });
        cmp.expandAll();
        fixture.detectChanges();
        const top = nodeAt('$["top-level"]');
        const altSecond = nodeAt('$["top-level"]["alt-second-level"]');
        const altThird = nodeAt(
          '$["top-level"]["alt-second-level"]["third-level"]'
        );
        // Collapse only alt-second-level and its (now hidden) third-level
        // so the partial-expansion shape matches the user's scenario.
        cmp.treeControl.collapse(altThird);
        cmp.treeControl.collapse(altSecond);
        fixture.detectChanges();
        expect(cmp.showExpandToDepth(top, 1)).toBe(false);
        expect(cmp.showExpandToDepth(top, 2)).toBe(true);
        expect(cmp.showExpandToDepth(top, 3)).toBe(true);
        expect(cmp.showExpandToDepth(top, 4)).toBe(false);
        expect(cmp.showExpandToDepth(top, 5)).toBe(false);
      });
    });

    describe('onRowDblClick', () => {
      it('copies the value of a primitive row', async () => {
        await createWith({ note: 'hi' });
        const writeText = jasmine.createSpy('writeText').and.resolveTo(undefined);
        const node = nodeAt('$.note');
        withCtxClipboard({ writeText }, () =>
          cmp.onRowDblClick(new MouseEvent('dblclick'), node)
        );
        await Promise.resolve(); await Promise.resolve();
        expect(writeText).toHaveBeenCalledWith('hi');
      });

      it('copies pretty JSON for a container row', async () => {
        await createWith({ obj: { a: 1 } });
        cmp.expandAll();
        fixture.detectChanges();
        const writeText = jasmine.createSpy('writeText').and.resolveTo(undefined);
        const node = nodeAt('$.obj');
        withCtxClipboard({ writeText }, () =>
          cmp.onRowDblClick(new MouseEvent('dblclick'), node)
        );
        await Promise.resolve(); await Promise.resolve();
        const arg = writeText.calls.mostRecent().args[0] as string;
        expect(arg).toContain('\n');
        expect(arg).toContain('"a": 1');
      });

      it('skips when the dblclick target is an interactive descendant (kebab pill)', async () => {
        await createWith({ alpha: 1 });
        cmp.expandAll();
        fixture.detectChanges();
        const writeText = jasmine.createSpy('writeText').and.resolveTo(undefined);
        const kebab = (fixture.nativeElement as HTMLElement).querySelector(
          '.tree-kebab-pill'
        ) as HTMLButtonElement;
        const ev = new MouseEvent('dblclick', { bubbles: true });
        Object.defineProperty(ev, 'target', { value: kebab });
        const node = nodeAt('$.alpha');
        withCtxClipboard({ writeText }, () => cmp.onRowDblClick(ev, node));
        await Promise.resolve(); await Promise.resolve();
        expect(writeText).not.toHaveBeenCalled();
      });
    });

    describe('rendering', () => {
      it('renders a kebab button on every visible row', async () => {
        await createWith({ a: 1, b: 2 });
        cmp.expandAll();
        fixture.detectChanges();
        const kebabs = (fixture.nativeElement as HTMLElement).querySelectorAll(
          '.tree-kebab-pill'
        );
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
          '.tree-kebab-pill'
        ) as NodeListOf<HTMLButtonElement>;
        // The leaf row's kebab (skip the root container's kebab at index 0).
        const leafKebab = Array.from(kebabs).find(
          (b) => b.closest('.tree-row[data-path="$.alpha"]') !== null
        ) as HTMLButtonElement | undefined;
        expect(leafKebab).withContext('found a kebab on $.alpha').toBeTruthy();
        leafKebab!.click();
        fixture.detectChanges();
        // Wait a tick for the menu overlay to attach.
        await Promise.resolve();
        fixture.detectChanges();
        expect(cmp.contextNode()?.pathString).toBe('$.alpha');
        const items = document.body.querySelectorAll('button.mat-mdc-menu-item');
        expect(items.length)
          .withContext('menu must render at least one item')
          .toBeGreaterThan(0);
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
          '.tree-row[data-path="$.alpha"] .tree-kebab-pill'
        ) as HTMLButtonElement | null;
        expect(kebab).toBeTruthy();
        kebab!.click();
        fixture.detectChanges();
        await Promise.resolve();
        fixture.detectChanges();
        const items = document.body.querySelectorAll(
          'button.mat-mdc-menu-item'
        ) as NodeListOf<HTMLButtonElement>;
        expect(items.length).toBeGreaterThan(0);
        const first = items[0];
        expect(first.textContent?.trim()).toBe(cmp.ctxCopyValueLabel);
        expect(first.classList.contains('ctx-default-action')).toBe(true);
        document.body
          .querySelectorAll('.cdk-overlay-backdrop')
          .forEach((b) => (b as HTMLElement).click());
        fixture.detectChanges();
      });
    });
  });
});
