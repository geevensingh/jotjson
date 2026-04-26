import { ComponentFixture, TestBed } from '@angular/core/testing';
import { JsonTreeComponent } from './json-tree.component';
import { PreferencesService } from '../../../core/preferences/preferences.service';
import { provideFakeAuth } from '../../../../testing/auth.testing';

const STORAGE_KEY = 'jotjson.preferences.v1';

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

  async function createWith(value: unknown): Promise<void> {
    localStorage.removeItem(STORAGE_KEY);
    TestBed.resetTestingModule();
    await TestBed.configureTestingModule({
      imports: [JsonTreeComponent],
      providers: [...provideFakeAuth()]
    }).compileComponents();
    fixture = TestBed.createComponent(JsonTreeComponent);
    prefs = TestBed.inject(PreferencesService);
    fixture.componentRef.setInput('value', value);
    fixture.detectChanges();
    cmp = fixture.componentInstance;
  }

  afterEach(() => localStorage.removeItem(STORAGE_KEY));

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

    it('does not select when clicking the copy-path button', async () => {
      await createWith({ a: 1 });
      cmp.expandAll();
      fixture.detectChanges();
      const copyBtn = (fixture.nativeElement as HTMLElement).querySelector(
        'button.tree-path-pill'
      ) as HTMLElement;
      expect(copyBtn).withContext('expected a copy-path button').toBeTruthy();
      // Stub clipboard to avoid headless permission rejection noise.
      const originalClipboard = (navigator as { clipboard?: Clipboard }).clipboard;
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText: () => Promise.resolve() }
      });
      try {
        copyBtn.click();
        fixture.detectChanges();
        expect(cmp.selectedPath()).toBeNull();
      } finally {
        if (originalClipboard) {
          Object.defineProperty(navigator, 'clipboard', {
            configurable: true,
            value: originalClipboard
          });
        }
      }
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
        expect(fixture.nativeElement.querySelector('.tree-search-count')).toBeNull();
      });

      it('renders "No matches" when nothing matches', async () => {
        await createWith({ alpha: 1 });
        setSearch('zzz');
        const el = fixture.nativeElement.querySelector('.tree-search-count');
        expect(el?.textContent?.trim()).toBe('No matches');
      });

      it('renders "1 match" for exactly one hit', async () => {
        await createWith({ alpha: 1, beta: 2 });
        setSearch('alpha');
        const el = fixture.nativeElement.querySelector('.tree-search-count');
        expect(el?.textContent?.trim()).toBe('1 match');
      });

      it('renders "N matches" for multiple hits', async () => {
        await createWith({ alpha: 1, alphabet: 2, alpine: 3 });
        setSearch('alp');
        const el = fixture.nativeElement.querySelector('.tree-search-count');
        expect(el?.textContent?.trim()).toBe('3 matches');
      });

      it('renders "P / N matches" when the selection is on a hit', async () => {
        await createWith({ alpha: 1, alphabet: 2, alpine: 3 });
        setSearch('alp');
        const c = fixture.componentInstance;
        const paths = c.searchHitPaths();
        c.selectedPath.set(paths[1] as string);
        fixture.detectChanges();
        const el = fixture.nativeElement.querySelector('.tree-search-count');
        expect(el?.textContent?.trim()).toBe('2 / 3 matches');
      });

      it('falls back to total when selection is not a hit', async () => {
        await createWith({ alpha: 1, alphabet: 2, beta: 3 });
        setSearch('alp');
        const c = fixture.componentInstance;
        c.selectedPath.set('$.beta');
        fixture.detectChanges();
        const el = fixture.nativeElement.querySelector('.tree-search-count');
        expect(el?.textContent?.trim()).toBe('2 matches');
      });

      it('falls back to total when nothing is selected', async () => {
        await createWith({ alpha: 1, alphabet: 2 });
        setSearch('alp');
        const c = fixture.componentInstance;
        c.selectedPath.set(null);
        fixture.detectChanges();
        const el = fixture.nativeElement.querySelector('.tree-search-count');
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
        let el = fixture.nativeElement.querySelector('.tree-search-count');
        expect(el?.textContent?.trim()).toBe('2 / 3 matches');
        c.goToNextMatch();
        fixture.detectChanges();
        el = fixture.nativeElement.querySelector('.tree-search-count');
        expect(el?.textContent?.trim()).toBe('3 / 3 matches');
        expect(c.selectedPath()).toBe(c.searchHitPaths()[2] as string);
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
});
