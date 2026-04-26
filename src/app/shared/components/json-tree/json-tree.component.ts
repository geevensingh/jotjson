import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  HostListener,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatMenuModule } from '@angular/material/menu';
import { MatTreeModule, MatTreeNestedDataSource } from '@angular/material/tree';
import { NestedTreeControl } from '@angular/cdk/tree';
import { PreferencesService } from '../../../core/preferences/preferences.service';
import { jsonTypeOf, JsonValueType } from '../../pipes/json-type.pipe';
import { IconComponent } from '../icon/icon.component';
import {
  ParsedDate,
  formatDateAnnotation,
  parseAsDate
} from '../../utils/date-detect';
import { classifyValue, ValueClassification } from '../../utils/value-classifier';

const TYPE_LABELS: Record<ValueClassification, string> = {
  date: $localize`:@@tree.type.date:date`,
  'date/time': $localize`:@@tree.type.dateTime:date/time`,
  uuid: $localize`:@@tree.type.uuid:uuid`,
  url: $localize`:@@tree.type.url:url`,
  email: $localize`:@@tree.type.email:email`,
  ipv4: $localize`:@@tree.type.ipv4:ipv4`,
  ipv6: $localize`:@@tree.type.ipv6:ipv6`,
  integer: $localize`:@@tree.type.integer:integer`,
  number: $localize`:@@tree.type.number:number`,
  string: $localize`:@@tree.type.string:string`,
  boolean: $localize`:@@tree.type.boolean:boolean`,
  null: $localize`:@@tree.type.null:null`,
  array: $localize`:@@tree.type.array:array`,
  object: $localize`:@@tree.type.object:object`,
  undefined: $localize`:@@tree.type.undefined:undefined`
};

interface TreeNode {
  segment: string | number | undefined;
  path: (string | number)[];
  pathString: string;
  value: unknown;
  type: JsonValueType;
  depth: number;
  children?: TreeNode[];
}

/**
 * Interactive tree viewer for parsed JSON, built on Angular Material's
 * mat-tree (nested variant). JsonParserService is the source of the value.
 */
@Component({
  selector: 'jj-json-tree',
  standalone: true,
  imports: [FormsModule, MatMenuModule, MatTreeModule, IconComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './json-tree.component.html',
  styleUrl: './json-tree.component.scss'
})
export class JsonTreeComponent {
  private readonly prefs = inject(PreferencesService);
  private readonly host = inject(ElementRef<HTMLElement>);
  private readonly destroyRef = inject(DestroyRef);

  readonly value = input<unknown>(undefined);

  readonly search = signal('');

  /**
   * Path of the currently-selected tree row, or `null` for no selection.
   * Stored as `pathString` (display form) so the value survives mat-tree
   * re-renders that recreate node objects. We never reverse-parse it - all
   * lookups go through `nodeIndex`.
   */
  readonly selectedPath = signal<string | null>(null);

  readonly expandLabel = $localize`:@@tree.node.expand:Expand`;
  readonly collapseLabel = $localize`:@@tree.node.collapse:Collapse`;

  readonly expandMenuButtonLabel = $localize`:@@tree.expand.menu.button:Expand to...`;
  readonly matchingValueAriaLabel = $localize`:@@tree.matchValue.aria:Matches the selected value`;

  readonly treeControl = new NestedTreeControl<TreeNode, string>(
    (n) => n.children ?? [],
    { trackBy: (n) => n.pathString }
  );
  readonly dataSource = new MatTreeNestedDataSource<TreeNode>();

  readonly root = computed<TreeNode | undefined>(() => {
    const raw = this.value();
    if (raw === undefined) return undefined;
    const root: TreeNode = {
      segment: undefined,
      path: [],
      pathString: '$',
      value: raw,
      type: jsonTypeOf(raw),
      depth: 0
    };
    if (root.type === 'object' || root.type === 'array') {
      root.children = this.buildChildren(raw, []);
    }
    return root;
  });

  readonly showTypeBadges = computed(() => this.prefs.prefs().treeShowTypeLabels);
  readonly showDateAnnotations = computed(
    () => this.prefs.prefs().treeShowDateAnnotations
  );
  readonly treeFontSize = computed(() => this.prefs.prefs().treeFontSize);
  readonly treeFontSizePx = computed(() => `${this.treeFontSize()}px`);

  /**
   * Tick signal used to refresh relative-time annotations. Updated every
   * 60s while the component is alive. Fine-grained enough for "5 minutes
   * ago" -> "6 minutes ago"; cheap enough that it does not show up on a
   * profile.
   */
  private readonly nowSignal = signal(Date.now());

  readonly searchHits = computed<ReadonlySet<string>>(() => {
    const q = this.search().trim();
    if (!q) return new Set();
    const scope = this.prefs.prefs().searchScope;
    const caseSensitive = this.prefs.prefs().searchCaseSensitive;
    const regexMode = this.prefs.prefs().searchRegexMode;
    const needle = caseSensitive ? q : q.toLowerCase();
    let regex: RegExp | undefined;
    if (regexMode) {
      try {
        regex = new RegExp(q, caseSensitive ? '' : 'i');
      } catch {
        return new Set();
      }
    }
    const matches = new Set<string>();
    const test = (hay: string): boolean =>
      regex ? regex.test(hay) : (caseSensitive ? hay : hay.toLowerCase()).includes(needle);
    const walk = (node: TreeNode | undefined): void => {
      if (!node) return;
      if (node.segment !== undefined && (scope === 'keys' || scope === 'both')) {
        if (test(String(node.segment))) matches.add(node.pathString);
      }
      if (scope === 'values' || scope === 'both') {
        if (node.type !== 'object' && node.type !== 'array') {
          if (test(this.renderLeaf(node.value, node.type))) matches.add(node.pathString);
        }
      }
      node.children?.forEach(walk);
    };
    walk(this.root());
    return matches;
  });

  /**
   * `pathString -> TreeNode` map rebuilt whenever the tree root changes.
   * Used as the only safe way to resolve `selectedPath()` back to a node;
   * `pathString` is a display form (`$.foo["a.b"]`) and ambiguous to
   * reverse-parse, so we lookup instead.
   */
  private readonly nodeIndex = computed<ReadonlyMap<string, TreeNode>>(() => {
    const map = new Map<string, TreeNode>();
    const walk = (node: TreeNode | undefined): void => {
      if (!node) return;
      map.set(node.pathString, node);
      node.children?.forEach(walk);
    };
    walk(this.root());
    return map;
  });

  /**
   * Paths of all rows that share the selected row's primitive value
   * (type-aware: `1 !== "1"`). Empty when nothing is selected, when the
   * selected node is missing from the index, or when it's a container or
   * `undefined`. Excludes the selected node itself.
   *
   * Per spec: container selections (object/array) do not compute matches.
   */
  readonly matchingPaths = computed<ReadonlySet<string>>(() => {
    const sp = this.selectedPath();
    if (sp === null) return new Set();
    const selected = this.nodeIndex().get(sp);
    if (!selected) return new Set();
    if (selected.type === 'object' || selected.type === 'array' || selected.type === 'undefined') {
      return new Set();
    }
    const targetType = selected.type;
    const targetValue = selected.value;
    const matches = new Set<string>();
    const walk = (node: TreeNode | undefined): void => {
      if (!node) return;
      if (
        node.pathString !== sp &&
        node.type === targetType &&
        node.value === targetValue
      ) {
        matches.add(node.pathString);
      }
      node.children?.forEach(walk);
    };
    walk(this.root());
    return matches;
  });

  /**
   * Paths of every ancestor of the selected row, root inclusive. Empty
   * when the root itself is selected (root never self-highlights as its
   * own ancestor).
   */
  readonly ancestorPaths = computed<ReadonlySet<string>>(() => {
    const sp = this.selectedPath();
    if (sp === null) return new Set();
    const selected = this.nodeIndex().get(sp);
    if (!selected) return new Set();
    const ancestors = new Set<string>();
    const partial: (string | number)[] = [];
    // Always include the synthetic root path '$' as an ancestor of any
    // non-root selection. Root has empty `path[]` so the loop below adds
    // nothing in that case, leaving the set empty.
    if (selected.path.length > 0) {
      ancestors.add('$');
    }
    for (let i = 0; i < selected.path.length - 1; i++) {
      partial.push(selected.path[i] as string | number);
      ancestors.add(this.formatPath(partial));
    }
    return ancestors;
  });

  private hasInitializedExpansion = false;

  constructor() {
    const NOW_TICK_MS = 60_000;
    const handle = setInterval(() => this.nowSignal.set(Date.now()), NOW_TICK_MS);
    this.destroyRef.onDestroy(() => clearInterval(handle));

    effect(() => {
      const r = this.root();
      this.dataSource.data = r ? [r] : [];
      if (!r) {
        this.hasInitializedExpansion = false;
        // Use untracked to avoid creating a dependency on selectedPath
        // here - we only want to react to value changes.
        untracked(() => this.selectedPath.set(null));
        return;
      }
      if (!this.hasInitializedExpansion) {
        this.hasInitializedExpansion = true;
        this.expandToLevel(this.prefs.prefs().defaultTreeExpansionDepth);
      }
      // Whenever the underlying value changes (and the resulting tree
      // root re-renders), drop any stale selection. Predictable, no
      // zombie state.
      untracked(() => this.selectedPath.set(null));
    });
  }

  hasChild = (_: number, node: TreeNode): boolean =>
    !!node.children && node.children.length > 0;

  /**
   * Click handler for `.tree-row`. Selects the row unless the click
   * target is an interactive child (twisty toggle, copy-path button,
   * etc.) in which case the child's own handler takes precedence.
   */
  onSelect(node: TreeNode, event: Event): void {
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (target.closest('button, [matTreeNodeToggle], a, input, [role="button"]')) {
      return;
    }
    this.selectedPath.set(node.pathString);
    event.stopPropagation();
  }

  clearSelection(): void {
    this.selectedPath.set(null);
  }

  /**
   * Outside-click clear. Fires on every document click; ignores clicks
   * that landed inside this component or inside any open CDK overlay
   * (mat-menu, future popovers) - those interactions should preserve
   * the user's selection.
   */
  @HostListener('document:click', ['$event'])
  onDocumentClick(event: MouseEvent): void {
    if (this.selectedPath() === null) return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (this.host.nativeElement.contains(target)) return;
    if (target.closest('.cdk-overlay-container')) return;
    this.clearSelection();
  }

  /**
   * Escape clears the active selection. We do not call preventDefault()
   * so the search input's own Esc binding can also clear the search
   * query when it has focus - one Esc press exits both at once.
   */
  @HostListener('document:keydown.escape')
  onDocumentEscape(): void {
    if (this.selectedPath() !== null) {
      this.clearSelection();
    }
  }

  onSearchEsc(): void {
    this.search.set('');
  }

  expandAll(): void {
    const walk = (node: TreeNode | undefined): void => {
      if (!node || !node.children) return;
      this.treeControl.expand(node);
      for (const c of node.children) walk(c);
    };
    walk(this.root());
  }

  collapseAll(): void {
    this.treeControl.collapseAll();
  }

  expandToLevel(depth: number): void {
    this.treeControl.collapseAll();
    const walk = (node: TreeNode | undefined): void => {
      if (!node || !node.children) return;
      if (node.depth < depth) {
        this.treeControl.expand(node);
        for (const c of node.children) walk(c);
      }
    };
    walk(this.root());
  }

  onSearchInput(ev: Event): void {
    this.search.set((ev.target as HTMLInputElement).value);
  }

  copyPath(node: TreeNode): void {
    try {
      void navigator.clipboard?.writeText(node.pathString);
    } catch {
      /* ignore */
    }
  }

  renderLeaf(value: unknown, type: JsonValueType): string {
    switch (type) {
      case 'null':
        return 'null';
      case 'undefined':
        return 'undefined';
      case 'string':
        return JSON.stringify(value as string);
      case 'number':
      case 'boolean':
        return String(value);
      default:
        return '';
    }
  }

  /**
   * Returns the parenthetical body for the date annotation, or null if
   * the node's value is not a recognized date string. Reads `nowSignal`
   * so the relative-time portion refreshes on each 60s tick.
   *
   * Intentionally does NOT participate in `renderLeaf`: search must match
   * the raw value, not the localized annotation.
   */
  dateAnnotation(node: TreeNode): string | null {
    if (node.type !== 'string') return null;
    const prefs = this.prefs.prefs();
    const parsed: ParsedDate | null = parseAsDate(node.value, undefined, {
      assumeUtcForIsoDateTime: prefs.treeAssumeUtcForIsoDateTime,
      assumeUtcForIsoDateOnly: prefs.treeAssumeUtcForIsoDateOnly
    });
    if (!parsed) return null;
    return formatDateAnnotation(parsed, new Date(this.nowSignal()));
  }

  /**
   * Localized label for the type-badge. Returns a richer descriptor
   * than the raw JSON type when we can detect one (uuid, url, email,
   * ipv4, ipv6, integer, date, date/time). Date detection is gated by
   * the `treeShowDateAnnotations` master toggle so the badge text stays
   * in sync with the annotation visibility.
   */
  typeLabel(node: TreeNode): string {
    const prefs = this.prefs.prefs();
    const classification = classifyValue(node.type, node.value, {
      detectDates: prefs.treeShowDateAnnotations,
      assumeUtcForIsoDateTime: prefs.treeAssumeUtcForIsoDateTime,
      assumeUtcForIsoDateOnly: prefs.treeAssumeUtcForIsoDateOnly
    });
    return TYPE_LABELS[classification];
  }

  containerSummary(node: TreeNode): string {
    if (node.type === 'array') {
      const n = (node.value as unknown[]).length;
      return `[ ${n === 0 ? '' : '...'} ]`;
    }
    if (node.type === 'object') {
      const keys = Object.keys(node.value as Record<string, unknown>);
      return `{ ${keys.length === 0 ? '' : '...'} }`;
    }
    return '';
  }

  containerCountText(node: TreeNode): string {
    if (node.type === 'array') {
      const n = (node.value as unknown[]).length;
      return n === 1 ? '1 item' : `${n} items`;
    }
    if (node.type === 'object') {
      const n = Object.keys(node.value as Record<string, unknown>).length;
      return n === 1 ? '1 key' : `${n} keys`;
    }
    return '';
  }

  segmentIsIndex(node: TreeNode): boolean {
    return typeof node.segment === 'number';
  }

  private buildChildren(
    value: unknown,
    parentPath: (string | number)[]
  ): TreeNode[] {
    if (Array.isArray(value)) {
      return value.map((child, i) => this.buildNode(i, child, [...parentPath, i]));
    }
    if (value && typeof value === 'object') {
      const obj = value as Record<string, unknown>;
      return Object.keys(obj).map((k) => this.buildNode(k, obj[k], [...parentPath, k]));
    }
    return [];
  }

  private buildNode(
    segment: string | number,
    value: unknown,
    path: (string | number)[]
  ): TreeNode {
    const type = jsonTypeOf(value);
    const node: TreeNode = {
      segment,
      path,
      pathString: this.formatPath(path),
      value,
      type,
      depth: path.length
    };
    if (type === 'object' || type === 'array') {
      node.children = this.buildChildren(value, path);
    }
    return node;
  }

  private formatPath(path: (string | number)[]): string {
    let out = '$';
    for (const seg of path) {
      if (typeof seg === 'number') {
        out += `[${seg}]`;
      } else if (/^[A-Za-z_$][\w$]*$/.test(seg)) {
        out += `.${seg}`;
      } else {
        out += `[${JSON.stringify(seg)}]`;
      }
    }
    return out;
  }
}
