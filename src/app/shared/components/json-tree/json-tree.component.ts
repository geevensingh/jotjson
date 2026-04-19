import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  signal
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatMenuModule } from '@angular/material/menu';
import { MatTreeModule, MatTreeNestedDataSource } from '@angular/material/tree';
import { NestedTreeControl } from '@angular/cdk/tree';
import { PreferencesService } from '../../../core/preferences/preferences.service';
import { jsonTypeOf, JsonValueType } from '../../pipes/json-type.pipe';
import { IconComponent } from '../icon/icon.component';

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

  readonly value = input<unknown>(undefined);

  readonly search = signal('');

  readonly expandLabel = $localize`:@@tree.node.expand:Expand`;
  readonly collapseLabel = $localize`:@@tree.node.collapse:Collapse`;

  readonly expandMenuButtonLabel = $localize`:@@tree.expand.menu.button:Expand to…`;

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

  private hasInitializedExpansion = false;

  constructor() {
    effect(() => {
      const r = this.root();
      this.dataSource.data = r ? [r] : [];
      if (!r) {
        this.hasInitializedExpansion = false;
        return;
      }
      if (!this.hasInitializedExpansion) {
        this.hasInitializedExpansion = true;
        this.expandToLevel(this.prefs.prefs().defaultTreeExpansionDepth);
      }
    });
  }

  hasChild = (_: number, node: TreeNode): boolean =>
    !!node.children && node.children.length > 0;

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

  containerSummary(node: TreeNode): string {
    if (node.type === 'array') {
      const n = (node.value as unknown[]).length;
      return `[ ${n === 0 ? '' : '…'} ]`;
    }
    if (node.type === 'object') {
      const keys = Object.keys(node.value as Record<string, unknown>);
      return `{ ${keys.length === 0 ? '' : '…'} }`;
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
