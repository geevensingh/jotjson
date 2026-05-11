import { HttpErrorResponse } from '@angular/common/http';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  Injector,
  OnInit,
  afterNextRender,
  computed,
  inject,
  signal,
} from '@angular/core';
import { takeUntilDestroyed, toObservable } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatSelectModule } from '@angular/material/select';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { MatSnackBar } from '@angular/material/snack-bar';
import { MatTooltipModule } from '@angular/material/tooltip';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import {
  EMPTY,
  Observable,
  Subject,
  catchError,
  concatMap,
  debounceTime,
  filter,
  firstValueFrom,
  merge,
  of,
  tap,
} from 'rxjs';

import {
  FORMATTING_ICONS,
  FormattingIcon,
  FormattingRule,
  FormattingRuleMatchType,
  FormattingRulePair,
  FormattingRuleSet,
  FormattingRuleSimple,
  FormattingStyle,
  KeyMatch,
  ValueMatch,
  ValuePredicate,
} from '../../../core/api/models';
import { NAME_MAX } from '../../../core/api/models.constants';
import { RuleSetsService } from '../../../core/api/rule-sets.service';
import { AuthService } from '../../../core/auth/auth.service';
import { AppHeaderComponent } from '../../../shared/components/app-header/app-header.component';
import { IconComponent } from '../../../shared/components/icon/icon.component';
import { RulePreviewComponent } from './rule-preview/rule-preview.component';

type LoadState = 'loading' | 'ready' | 'not_found' | 'error';
type SaveState = 'idle' | 'saving' | 'error';

interface Editable {
  name: string;
  rules: FormattingRule[];
}

interface ServerMeta {
  id: string;
  version: number;
  userId: string;
  createdAt: string;
  updatedAt: string;
}

type Validity = { kind: 'valid' } | { kind: 'invalid'; reasons: string[] };

type PillState =
  | { kind: 'reloading' }
  | { kind: 'invalid'; reasons: string[] }
  | { kind: 'saving' }
  | { kind: 'error' }
  | { kind: 'saved' }
  | { kind: 'savedOffline' }
  | { kind: 'editing' }
  | { kind: 'idle' };

type RuleKind = 'simple' | 'pair' | 'unknown';
type SelectorMode = 'key' | 'value' | 'key_or_value' | 'pair';
type SimpleTarget = FormattingRuleSimple['target'];
type SimpleDraft = Pick<
  FormattingRuleSimple,
  'target' | 'matchType' | 'matchValue' | 'caseSensitive'
>;
type PairDraft = Pick<FormattingRulePair, 'keyMatch' | 'valueMatch'>;
type TextValueMatch = Extract<ValueMatch, { kind: 'text' }>;
type PairValueMatchMode = ValueMatch['kind'];

interface RuleDraftCache {
  simple: SimpleDraft | null;
  pair: PairDraft | null;
}

interface PredicateOption {
  value: ValuePredicate;
  label: string;
}

const HEX_COLOR = /^#[0-9a-f]{6}$/i;
const MATCH_VALUE_MAX = 200;
const MAX_RULES = 50;
const SAVE_DEBOUNCE_MS = 500;
const SAVED_FLASH_MS = 2000;

const DEFAULT_NEW_RULE_STYLE = (): FormattingStyle => ({
  backgroundColor: '#ffe4b5',
  textColor: '#1f2937',
});

const DEFAULT_SIMPLE_DRAFT = (target: SimpleTarget = 'value'): SimpleDraft => ({
  target,
  matchType: 'contains',
  matchValue: '',
  caseSensitive: false,
});

const DEFAULT_PAIR_DRAFT = (): PairDraft => ({
  keyMatch: {
    matchType: 'exact',
    matchValue: '',
    caseSensitive: false,
  },
  valueMatch: {
    kind: 'text',
    matchType: 'contains',
    matchValue: '',
    caseSensitive: false,
  },
});

/**
 * M6d-2 rule editor. Layers valid-only autosave + 412 conflict
 * banner on top of the M6d-1 scaffold.
 *
 * Why `concatMap` and not `switchMap`: cancelling an in-flight
 * `PUT /api/rule-sets/:id` does NOT guarantee the server discarded
 * it. If the server committed the write, the next save would PUT
 * with a stale `If-Match` version and 412 falsely. We therefore run
 * saves one-at-a-time and let any newer queued edit fire its own
 * save with the freshly-acknowledged version.
 *
 * State decomposition:
 *  - `serverMeta` is the last acknowledged server snapshot meta
 *    (id / version / timestamps). Saves always pass
 *    `serverMeta().version`, never a version cached in the editable
 *    payload.
 *  - `editable` is the user-editable payload (`name`, `rules`).
 *    Every form mutator writes here.
 *  - `lastSavedFingerprint` is `JSON.stringify(editable)` after the
 *    most recent successful save (or after initial load). The
 *    autosave gate compares `fingerprint(editable) !==
 *    lastSavedFingerprint` to detect dirtiness; identity / version
 *    comparisons are unreliable because every keystroke creates a
 *    new object.
 *
 * Late-response and routing guards:
 *  - The route's `:id` may change while a save is in flight. Each
 *    save captures the route id and the signed-in user id at
 *    issue-time and bails before mutating any signal if they no
 *    longer match.
 *  - Sign-out clears `auth.user()`. In-flight saves bail on the
 *    user-id check rather than re-seed the cleared cache.
 */
@Component({
  selector: 'app-rule-editor',
  standalone: true,
  imports: [
    AppHeaderComponent,
    FormsModule,
    IconComponent,
    MatButtonModule,
    MatButtonToggleModule,
    MatFormFieldModule,
    MatSelectModule,
    MatSlideToggleModule,
    MatTooltipModule,
    RouterLink,
    RulePreviewComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './rule-editor.component.html',
  styleUrl: './rule-editor.component.scss',
})
export class RuleEditorComponent implements OnInit {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly service = inject(RuleSetsService);
  private readonly auth = inject(AuthService);
  private readonly snack = inject(MatSnackBar);
  private readonly destroyRef = inject(DestroyRef);
  private readonly injector = inject(Injector);

  readonly loadState = signal<LoadState>('loading');
  readonly saveState = signal<SaveState>('idle');
  readonly editable = signal<Editable | null>(null);
  readonly serverMeta = signal<ServerMeta | null>(null);
  readonly lastSavedFingerprint = signal<string>('');
  readonly conflict = signal<boolean>(false);
  readonly reloading = signal<boolean>(false);
  readonly savedFlash = signal<boolean>(false);

  readonly icons: readonly FormattingIcon[] = FORMATTING_ICONS;
  readonly selectorModeOptions: readonly SelectorMode[] = ['key', 'value', 'key_or_value', 'pair'];
  readonly matchTypeOptions: readonly FormattingRuleMatchType[] = [
    'exact',
    'contains',
    'starts_with',
    'ends_with',
  ];
  readonly predicateOptions: readonly PredicateOption[] = [
    { value: 'is_null', label: $localize`:@@ruleEditor.predicate.isNull:is null` },
    { value: 'is_not_null', label: $localize`:@@ruleEditor.predicate.isNotNull:is not null` },
    {
      value: 'is_empty',
      label: $localize`:@@ruleEditor.predicate.isEmpty:is empty (empty string, [], {})`,
    },
    { value: 'is_not_empty', label: $localize`:@@ruleEditor.predicate.isNotEmpty:is not empty` },
    { value: 'is_string', label: $localize`:@@ruleEditor.predicate.isString:is a string` },
    {
      value: 'is_not_string',
      label: $localize`:@@ruleEditor.predicate.isNotString:is not a string`,
    },
    {
      value: 'is_number',
      label: $localize`:@@ruleEditor.predicate.isNumber:is a number (non-integer)`,
    },
    {
      value: 'is_not_number',
      label: $localize`:@@ruleEditor.predicate.isNotNumber:is not a number`,
    },
    { value: 'is_integer', label: $localize`:@@ruleEditor.predicate.isInteger:is an integer` },
    {
      value: 'is_not_integer',
      label: $localize`:@@ruleEditor.predicate.isNotInteger:is not an integer`,
    },
    { value: 'is_boolean', label: $localize`:@@ruleEditor.predicate.isBoolean:is a boolean` },
    {
      value: 'is_not_boolean',
      label: $localize`:@@ruleEditor.predicate.isNotBoolean:is not a boolean`,
    },
    { value: 'is_object', label: $localize`:@@ruleEditor.predicate.isObject:is an object` },
    {
      value: 'is_not_object',
      label: $localize`:@@ruleEditor.predicate.isNotObject:is not an object`,
    },
    { value: 'is_array', label: $localize`:@@ruleEditor.predicate.isArray:is an array` },
    { value: 'is_not_array', label: $localize`:@@ruleEditor.predicate.isNotArray:is not an array` },
    {
      value: 'has_content',
      label: $localize`:@@ruleEditor.predicate.hasContent:has content (not null and not empty)`,
    },
    {
      value: 'lacks_content',
      label: $localize`:@@ruleEditor.predicate.lacksContent:lacks content (null or empty)`,
    },
  ];
  readonly noneLabel = $localize`:@@ruleEditor.style.none:(none)`;

  private readonly ruleDrafts = signal<ReadonlyMap<string, RuleDraftCache>>(new Map());

  /** `true` while either a 412 conflict banner is up or a Reload is in flight. */
  readonly formDisabled = computed(() => this.conflict() || this.reloading());

  readonly selectorMode = computed<ReadonlyMap<string, SelectorMode>>(() => {
    const editable = this.editable();
    const modes = new Map<string, SelectorMode>();
    if (!editable) return modes;
    for (const rule of editable.rules) {
      const mode = this.selectorModeFromRule(rule);
      if (mode !== null) {
        modes.set(rule.id, mode);
      }
    }
    return modes;
  });

  readonly validity = computed<Validity>(() => {
    const e = this.editable();
    if (!e) return { kind: 'valid' };
    const reasons: string[] = [];
    if (!e.name.trim()) {
      reasons.push($localize`:@@ruleEditor.validity.nameEmpty:Name is required.`);
    } else if (e.name.length > NAME_MAX) {
      reasons.push(
        $localize`:@@ruleEditor.validity.nameLong:Name is too long (max 80 characters).`,
      );
    }
    if (e.rules.length > MAX_RULES) {
      reasons.push($localize`:@@ruleEditor.validity.tooManyRules:Too many rules (max 50).`);
    }
    let hasEmptyMatchValue = false;
    let hasLongMatchValue = false;
    let hasBadHex = false;
    let hasMalformedRule = false;
    for (const rule of e.rules) {
      if (this.isSimpleRule(rule)) {
        if (rule.matchValue.trim() === '') hasEmptyMatchValue = true;
        if (rule.matchValue.length > MATCH_VALUE_MAX) hasLongMatchValue = true;
      } else if (this.isPairRule(rule)) {
        if (rule.keyMatch.matchValue.trim() === '') hasEmptyMatchValue = true;
        if (rule.keyMatch.matchValue.length > MATCH_VALUE_MAX) hasLongMatchValue = true;
        if (rule.valueMatch.kind === 'text') {
          if (rule.valueMatch.matchValue.trim() === '') hasEmptyMatchValue = true;
          if (rule.valueMatch.matchValue.length > MATCH_VALUE_MAX) hasLongMatchValue = true;
        }
      } else {
        hasMalformedRule = true;
      }

      if (!this.isKnownRule(rule)) continue;
      const colors = [rule.style.backgroundColor, rule.style.textColor, rule.style.borderColor];
      for (const color of colors) {
        if (color && !HEX_COLOR.test(color)) hasBadHex = true;
      }
    }
    if (hasEmptyMatchValue) {
      reasons.push(
        $localize`:@@ruleEditor.validity.matchValueEmpty:One or more rules are missing a match value.`,
      );
    }
    if (hasLongMatchValue) {
      reasons.push(
        $localize`:@@ruleEditor.validity.matchValueLong:One or more rules have a match value that is too long (max 200 characters).`,
      );
    }
    if (hasMalformedRule) {
      reasons.push(
        $localize`:@@ruleEditor.validity.malformedRule:One or more rules use an unsupported format and must be removed or converted before saving.`,
      );
    }
    if (hasBadHex) {
      reasons.push(
        $localize`:@@ruleEditor.validity.badHex:One or more rules have an invalid color (must be #rrggbb).`,
      );
    }
    return reasons.length === 0 ? { kind: 'valid' } : { kind: 'invalid', reasons };
  });

  readonly isDirty = computed(() => {
    const e = this.editable();
    if (!e) return false;
    return this.fingerprint(e) !== this.lastSavedFingerprint();
  });

  readonly pillState = computed<PillState>(() => {
    if (this.reloading()) return { kind: 'reloading' };
    const v = this.validity();
    if (v.kind === 'invalid' && this.isDirty()) {
      return { kind: 'invalid', reasons: v.reasons };
    }
    if (this.saveState() === 'saving') return { kind: 'saving' };
    if (this.saveState() === 'error') return { kind: 'error' };
    if (this.savedFlash() && !this.isDirty()) {
      const meta = this.serverMeta();
      if (meta && this.service.pendingWriteIds().has(meta.id)) {
        return { kind: 'savedOffline' };
      }
      return { kind: 'saved' };
    }
    if (this.isDirty()) return { kind: 'editing' };
    return { kind: 'idle' };
  });

  /**
   * M6d-3 live preview draft. Builds a `FormattingRuleSet`-shaped
   * snapshot from the in-progress `editable` payload + the last
   * acknowledged `serverMeta` so the preview component can render
   * the production tree against the user's draft without any save.
   * Returns `null` while the form is still loading (no serverMeta) -
   * the template hides the preview in that state. Re-evaluates
   * automatically on every signal write to `editable`.
   */
  readonly previewDraft = computed<FormattingRuleSet | null>(() => {
    const e = this.editable();
    const meta = this.serverMeta();
    if (!e || !meta) return null;
    return {
      id: meta.id,
      userId: meta.userId,
      name: e.name,
      rules: e.rules,
      version: meta.version,
      createdAt: meta.createdAt,
      updatedAt: meta.updatedAt,
    };
  });

  /** Auto-generated label per F1: e.g. `key contains "error"`. */
  ruleLabel(rule: FormattingRule): string {
    if (this.isPairRule(rule)) {
      return `${this.textMatchLabel($localize`:@@ruleEditor.ruleLabel.target.key:key`, rule.keyMatch)} ${$localize`:@@ruleEditor.ruleLabel.and:AND`} ${this.valueMatchLabel(rule.valueMatch)}`;
    }
    if (this.isSimpleRule(rule)) {
      const targetLabel = this.simpleTargetLabel(rule.target);
      return this.textMatchLabel(targetLabel, rule);
    }
    return $localize`:@@ruleEditor.ruleLabel.unknown:Unknown rule (skipped)`;
  }

  selectorModeFor(rule: FormattingRule): SelectorMode | null {
    return this.selectorMode().get(rule.id) ?? null;
  }

  isSimpleRule(rule: FormattingRule): rule is FormattingRuleSimple {
    if (this.ruleKind(rule) !== 'simple') return false;
    if (
      !('target' in rule) ||
      !('matchType' in rule) ||
      !('matchValue' in rule) ||
      !('caseSensitive' in rule)
    ) {
      return false;
    }
    return (
      this.isSimpleTarget(rule.target) &&
      this.isMatchType(rule.matchType) &&
      typeof rule.matchValue === 'string' &&
      typeof rule.caseSensitive === 'boolean' &&
      this.hasStyleObject(rule)
    );
  }

  isPairRule(rule: FormattingRule): rule is FormattingRulePair {
    if (this.ruleKind(rule) !== 'pair') return false;
    if (!('keyMatch' in rule) || !('valueMatch' in rule)) return false;
    return (
      this.isTextMatchConfig(rule.keyMatch) &&
      this.isValueMatchConfig(rule.valueMatch) &&
      this.hasStyleObject(rule)
    );
  }

  isKnownRule(rule: FormattingRule): rule is FormattingRuleSimple | FormattingRulePair {
    return this.isSimpleRule(rule) || this.isPairRule(rule);
  }

  /** Joined list of validity reasons for the pill tooltip. */
  invalidReasonsText(reasons: readonly string[]): string {
    return reasons.join(' ');
  }

  private currentId: string | null = null;
  private savedFlashToken = 0;
  private readonly retryTrigger$ = new Subject<void>();

  // Capture the editable observable in field-initializer (injection)
  // context so `toObservable` is legal here. The subscription is
  // wired up in ngOnInit so destroyRef + auth are usable.
  private readonly editable$ = toObservable(this.editable);

  ngOnInit(): void {
    this.setupAutosave();

    // M6g-4: surface offline-drain conflict / error events from the
    // service. These fire when the user makes a change while offline,
    // we queue it, and the eventual replay fails.
    this.service.events$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((event) => this.handleSyncEvent(event));

    this.route.paramMap.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((params) => {
      const id = params.get('id');
      if (!id) {
        void this.router.navigate(['/formatting-rules']);
        return;
      }
      this.resetForId(id);
      void this.loadById(id);
    });
  }

  private handleSyncEvent(event: {
    kind: 'conflict' | 'error';
    id: string;
    status?: number;
  }): void {
    const meta = this.serverMeta();
    if (!meta || meta.id !== event.id) return;
    if (event.kind === 'conflict') {
      this.conflict.set(true);
      this.snack.open(
        $localize`:@@ruleEditor.offlineConflict:Your offline edit could not be saved - someone else changed this rule set.`,
        $localize`:@@common.dismiss:Dismiss`,
        { duration: 6000 },
      );
    } else {
      this.snack.open(
        $localize`:@@ruleEditor.offlineError:Your offline edit could not be saved.`,
        $localize`:@@common.dismiss:Dismiss`,
        { duration: 6000 },
      );
    }
  }

  private resetForId(id: string): void {
    this.currentId = id;
    this.loadState.set('loading');
    this.saveState.set('idle');
    this.editable.set(null);
    this.serverMeta.set(null);
    this.lastSavedFingerprint.set('');
    this.conflict.set(false);
    this.reloading.set(false);
    this.savedFlash.set(false);
    this.ruleDrafts.set(new Map());
    this.savedFlashToken += 1;
  }

  private hydrateFrom(set: FormattingRuleSet): void {
    const cloned = this.cloneRules(set.rules);
    this.ruleDrafts.set(this.draftCacheForRules(cloned));
    this.editable.set({ name: set.name, rules: cloned });
    this.serverMeta.set({
      id: set.id,
      version: set.version,
      userId: set.userId,
      createdAt: set.createdAt,
      updatedAt: set.updatedAt,
    });
    this.lastSavedFingerprint.set(this.fingerprint({ name: set.name, rules: cloned }));
  }

  private async loadById(id: string): Promise<void> {
    const cached = this.service.ruleSets()?.find((s) => s.id === id);
    if (cached) {
      this.hydrateFrom(cached);
      this.loadState.set('ready');
      return;
    }
    try {
      const set = await firstValueFrom(this.service.get(id));
      if (this.currentId !== id) return;
      this.hydrateFrom(set);
      this.loadState.set('ready');
    } catch (err) {
      if (this.currentId !== id) return;
      if (err instanceof HttpErrorResponse && err.status === 404) {
        this.loadState.set('not_found');
        this.snack.open(
          $localize`:@@ruleEditor.notFound:Rule set not found.`,
          $localize`:@@common.dismiss:Dismiss`,
          { duration: 4000 },
        );
        void this.router.navigate(['/formatting-rules']);
        return;
      }
      this.loadState.set('error');
    }
  }

  setName(value: string): void {
    if (this.formDisabled()) return;
    const current = this.editable();
    if (!current) return;
    this.editable.set({ ...current, name: value });
  }

  addRule(): void {
    if (this.formDisabled()) return;
    const current = this.editable();
    if (!current) return;
    const newRule: FormattingRuleSimple = {
      id: this.newRuleId(),
      kind: 'simple',
      ...DEFAULT_SIMPLE_DRAFT('value'),
      style: DEFAULT_NEW_RULE_STYLE(),
    };
    this.ruleDrafts.update((caches) => {
      const nextCaches = new Map(caches);
      nextCaches.set(newRule.id, { simple: this.simpleDraftFromRule(newRule), pair: null });
      return nextCaches;
    });
    this.editable.set({ ...current, rules: [...current.rules, newRule] });
    // M6g-2: focus the new rule's match-value input so users can start
    // typing immediately. afterNextRender waits for the @for to render
    // the new <li> before the focus call.
    this.focusElementById(`match-value-${newRule.id}`);
  }

  removeRule(index: number): void {
    if (this.formDisabled()) return;
    const current = this.editable();
    if (!current) return;
    const next = current.rules.slice();
    const [removed] = next.splice(index, 1);
    if (removed) {
      this.ruleDrafts.update((caches) => {
        const nextCaches = new Map(caches);
        nextCaches.delete(removed.id);
        return nextCaches;
      });
    }
    this.editable.set({ ...current, rules: next });
    // M6g-2: pick a sensible focus target so keyboard users do not lose
    // their place. Prefer the rule that filled index `index` (the next
    // surviving rule shifted up); fall back to the previous rule (if we
    // removed the last one); fall back to the "+ Add rule" button if
    // the list is now empty.
    const successor = next[index] ?? next[index - 1];
    const targetId = successor ? `remove-rule-${successor.id}` : 'add-rule-button';
    this.focusElementById(targetId);
  }

  moveRule(index: number, direction: -1 | 1): void {
    if (this.formDisabled()) return;
    const current = this.editable();
    if (!current) return;
    const target = index + direction;
    if (target < 0 || target >= current.rules.length) return;
    const next = current.rules.slice();
    const [moved] = next.splice(index, 1);
    next.splice(target, 0, moved);
    this.editable.set({ ...current, rules: next });
    // M6g-2: keep keyboard focus on the same direction button so
    // repeated keypresses keep working. If the moved rule has hit the
    // edge in that direction (button now disabled), fall back to the
    // opposite direction button which is still active.
    const sameDirAtEdge =
      (direction === -1 && target === 0) || (direction === 1 && target === next.length - 1);
    const focusDir: -1 | 1 = sameDirAtEdge ? (direction === -1 ? 1 : -1) : direction;
    const focusPrefix = focusDir === -1 ? 'move-up-' : 'move-down-';
    this.focusElementById(`${focusPrefix}${moved.id}`);
  }

  patchRule(index: number, patch: Partial<FormattingRule>): void {
    if (this.formDisabled()) return;
    const current = this.editable();
    if (!current) return;
    const next = current.rules.slice();
    const rule = next[index];
    if (!rule || !this.isSimpleRule(rule)) return;
    const merged: FormattingRuleSimple = {
      ...rule,
      kind: 'simple',
      target: 'target' in patch && this.isSimpleTarget(patch.target) ? patch.target : rule.target,
      matchType:
        'matchType' in patch && this.isMatchType(patch.matchType)
          ? patch.matchType
          : rule.matchType,
      matchValue:
        'matchValue' in patch && typeof patch.matchValue === 'string'
          ? patch.matchValue
          : rule.matchValue,
      caseSensitive:
        'caseSensitive' in patch && typeof patch.caseSensitive === 'boolean'
          ? patch.caseSensitive
          : rule.caseSensitive,
      style: patch.style ? { ...rule.style, ...patch.style } : { ...rule.style },
    };
    next[index] = merged;
    this.cacheActiveDraft(merged);
    this.editable.set({ ...current, rules: next });
  }

  patchPairKeyMatch(index: number, patch: Partial<KeyMatch>): void {
    if (this.formDisabled()) return;
    const current = this.editable();
    if (!current) return;
    const next = current.rules.slice();
    const rule = next[index];
    if (!rule || !this.isPairRule(rule)) return;
    const merged: FormattingRulePair = {
      ...rule,
      keyMatch: {
        ...rule.keyMatch,
        matchType: this.isMatchType(patch.matchType) ? patch.matchType : rule.keyMatch.matchType,
        matchValue:
          typeof patch.matchValue === 'string' ? patch.matchValue : rule.keyMatch.matchValue,
        caseSensitive:
          typeof patch.caseSensitive === 'boolean'
            ? patch.caseSensitive
            : rule.keyMatch.caseSensitive,
      },
      valueMatch: this.cloneValueMatch(rule.valueMatch),
      style: { ...rule.style },
    };
    next[index] = merged;
    this.cacheActiveDraft(merged);
    this.editable.set({ ...current, rules: next });
  }

  patchPairValueTextMatch(index: number, patch: Partial<TextValueMatch>): void {
    if (this.formDisabled()) return;
    const current = this.editable();
    if (!current) return;
    const next = current.rules.slice();
    const rule = next[index];
    if (!rule || !this.isPairRule(rule) || rule.valueMatch.kind !== 'text') return;
    const mergedValueMatch: TextValueMatch = {
      ...rule.valueMatch,
      matchType: this.isMatchType(patch.matchType) ? patch.matchType : rule.valueMatch.matchType,
      matchValue:
        typeof patch.matchValue === 'string' ? patch.matchValue : rule.valueMatch.matchValue,
      caseSensitive:
        typeof patch.caseSensitive === 'boolean'
          ? patch.caseSensitive
          : rule.valueMatch.caseSensitive,
    };
    const merged: FormattingRulePair = {
      ...rule,
      keyMatch: { ...rule.keyMatch },
      valueMatch: mergedValueMatch,
      style: { ...rule.style },
    };
    next[index] = merged;
    this.cacheActiveDraft(merged);
    this.editable.set({ ...current, rules: next });
  }

  setPairValueMatchMode(index: number, value: unknown): void {
    if (this.formDisabled()) return;
    const mode = this.asPairValueMatchMode(value);
    if (mode === null) return;
    const current = this.editable();
    if (!current) return;
    const next = current.rules.slice();
    const rule = next[index];
    if (!rule || !this.isPairRule(rule) || rule.valueMatch.kind === mode) return;
    const valueMatch: ValueMatch =
      mode === 'text'
        ? {
            kind: 'text',
            matchType: 'contains',
            matchValue: '',
            caseSensitive: false,
          }
        : {
            kind: 'predicate',
            predicate: 'is_not_null',
          };
    const merged: FormattingRulePair = {
      ...rule,
      keyMatch: { ...rule.keyMatch },
      valueMatch,
      style: { ...rule.style },
    };
    next[index] = merged;
    this.cacheActiveDraft(merged);
    this.editable.set({ ...current, rules: next });
  }

  setPairPredicate(index: number, value: unknown): void {
    if (this.formDisabled()) return;
    if (!this.isValuePredicate(value)) return;
    const current = this.editable();
    if (!current) return;
    const next = current.rules.slice();
    const rule = next[index];
    if (!rule || !this.isPairRule(rule) || rule.valueMatch.kind !== 'predicate') return;
    const merged: FormattingRulePair = {
      ...rule,
      keyMatch: { ...rule.keyMatch },
      valueMatch: { kind: 'predicate', predicate: value },
      style: { ...rule.style },
    };
    next[index] = merged;
    this.cacheActiveDraft(merged);
    this.editable.set({ ...current, rules: next });
  }

  setSelectorMode(index: number, value: unknown): void {
    if (this.formDisabled()) return;
    const mode = this.asSelectorMode(value);
    if (mode === null) return;
    const current = this.editable();
    if (!current) return;
    const next = current.rules.slice();
    const rule = next[index];
    if (!rule) return;

    const cache = this.cacheWithActiveDraft(rule);
    const style = this.styleFromRule(rule);
    const nextRule =
      mode === 'pair'
        ? this.ruleFromPairDraft(rule.id, cache.pair ?? DEFAULT_PAIR_DRAFT(), style)
        : this.ruleFromSimpleDraft(
            rule.id,
            {
              ...(cache.simple ?? DEFAULT_SIMPLE_DRAFT()),
              target: this.targetFromSelectorMode(mode),
            },
            style,
          );

    next[index] = nextRule;
    this.ruleDrafts.update((caches) => {
      const nextCaches = new Map(caches);
      nextCaches.set(nextRule.id, this.cacheWithActiveDraft(nextRule, cache));
      return nextCaches;
    });
    this.editable.set({ ...current, rules: next });
  }

  patchStyle(index: number, patch: Partial<FormattingStyle>): void {
    if (this.formDisabled()) return;
    const current = this.editable();
    if (!current) return;
    const next = current.rules.slice();
    const rule = next[index];
    if (!rule || !this.isKnownRule(rule)) return;
    const merged = { ...rule, style: { ...rule.style, ...patch } };
    next[index] = merged;
    this.cacheActiveDraft(merged);
    this.editable.set({ ...current, rules: next });
  }

  /** Set the icon dropdown; empty string clears the icon. */
  setIcon(index: number, value: string): void {
    if (this.formDisabled()) return;
    if (value === '') {
      this.patchStyle(index, { icon: undefined });
      return;
    }
    const icon = FORMATTING_ICONS.find((i) => i === value);
    if (!icon) return;
    this.patchStyle(index, { icon });
  }

  /**
   * M6g-2 focus helper. Schedules a focus call on the element with
   * `id === targetId` after Angular renders the next frame, so the
   * caller can mutate `editable()` and then ask for focus on a
   * just-rendered element without racing the change-detection cycle.
   *
   * No-ops when the element is missing (e.g., the list became empty
   * and the caller asked for an `add-rule-button` that is conditionally
   * rendered) and when running outside a DOM environment.
   */
  private focusElementById(targetId: string): void {
    afterNextRender(
      () => {
        const el = document.getElementById(targetId);
        if (el && typeof (el as HTMLElement).focus === 'function') {
          (el as HTMLElement).focus();
        }
      },
      { injector: this.injector },
    );
  }

  /** Manual retry from the `Save failed - retry` pill. */
  retrySave(): void {
    if (!this.canFireSave()) return;
    this.retryTrigger$.next();
  }

  /** Reload the rule set from the server, discarding local edits. */
  async reload(): Promise<void> {
    if (this.reloading()) return;
    const id = this.currentId;
    if (!id) return;
    const userId = this.auth.user()?.id ?? null;
    this.reloading.set(true);
    try {
      const set = await firstValueFrom(this.service.get(id));
      if (this.currentId !== id) return;
      if ((this.auth.user()?.id ?? null) !== userId) return;
      this.hydrateFrom(set);
      this.conflict.set(false);
      this.saveState.set('idle');
    } catch (err) {
      if (this.currentId !== id) return;
      if (err instanceof HttpErrorResponse && err.status === 404) {
        this.snack.open(
          $localize`:@@ruleEditor.deleted:This rule set was deleted.`,
          $localize`:@@common.dismiss:Dismiss`,
          { duration: 5000 },
        );
        void this.router.navigate(['/formatting-rules']);
        return;
      }
      // Banner stays up; surface a transient toast so the user knows
      // their click did something. Conflict remains true so they can
      // retry.
      this.snack.open(
        $localize`:@@ruleEditor.reloadFailed:Reload failed. Please try again.`,
        $localize`:@@common.dismiss:Dismiss`,
        { duration: 5000 },
      );
    } finally {
      if (this.currentId === id) this.reloading.set(false);
    }
  }

  trackByRule(_index: number, rule: FormattingRule): string {
    return rule.id;
  }

  private setupAutosave(): void {
    merge(this.editable$, this.retryTrigger$)
      .pipe(
        debounceTime(SAVE_DEBOUNCE_MS),
        filter(() => this.canFireSave()),
        concatMap(() => this.fireSave()),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe();
  }

  private canFireSave(): boolean {
    if (this.formDisabled()) return false;
    if (!this.auth.user()) return false;
    const meta = this.serverMeta();
    if (!meta) return false;
    if (this.validity().kind !== 'valid') return false;
    if (!this.isDirty()) return false;
    return true;
  }

  private fireSave(): Observable<unknown> {
    const editable = this.editable();
    const meta = this.serverMeta();
    const id = this.currentId;
    const userId = this.auth.user()?.id ?? null;
    if (!editable || !meta || !id) return of(null);
    const payload: Editable = {
      name: editable.name,
      rules: editable.rules,
    };
    const fingerprint = this.fingerprint(payload);

    this.saveState.set('saving');
    return this.service.update(id, payload, meta.version).pipe(
      tap((response) => {
        if (this.currentId !== id) return;
        if ((this.auth.user()?.id ?? null) !== userId) return;
        this.serverMeta.set({
          id: response.id,
          version: response.version,
          userId: response.userId,
          createdAt: response.createdAt,
          updatedAt: response.updatedAt,
        });
        this.lastSavedFingerprint.set(fingerprint);
        this.saveState.set('idle');
        this.flashSaved();
      }),
      catchError((err) => {
        if (this.currentId !== id) return EMPTY;
        if ((this.auth.user()?.id ?? null) !== userId) return EMPTY;
        if (err instanceof HttpErrorResponse) {
          if (err.status === 412) {
            this.conflict.set(true);
            this.saveState.set('idle');
            return EMPTY;
          }
          if (err.status === 404) {
            this.snack.open(
              $localize`:@@ruleEditor.deleted:This rule set was deleted.`,
              $localize`:@@common.dismiss:Dismiss`,
              { duration: 5000 },
            );
            void this.router.navigate(['/formatting-rules']);
            return EMPTY;
          }
        }
        this.saveState.set('error');
        return EMPTY;
      }),
    );
  }

  private rawRuleKind(rule: FormattingRule): unknown {
    return rule.kind ?? 'simple';
  }

  private ruleKind(rule: FormattingRule): RuleKind {
    const kind = this.rawRuleKind(rule);
    if (kind === 'simple' || kind === 'pair') return kind;
    return 'unknown';
  }

  private selectorModeFromRule(rule: FormattingRule): SelectorMode | null {
    if (this.isPairRule(rule)) return 'pair';
    if (!this.isSimpleRule(rule)) return null;
    switch (rule.target) {
      case 'key':
        return 'key';
      case 'value':
        return 'value';
      case 'key_and_value':
        return 'key_or_value';
      default:
        return null;
    }
  }

  private asSelectorMode(value: unknown): SelectorMode | null {
    switch (value) {
      case 'key':
      case 'value':
      case 'key_or_value':
      case 'pair':
        return value;
      default:
        return null;
    }
  }

  private asPairValueMatchMode(value: unknown): PairValueMatchMode | null {
    return value === 'text' || value === 'predicate' ? value : null;
  }

  private targetFromSelectorMode(mode: Exclude<SelectorMode, 'pair'>): SimpleTarget {
    switch (mode) {
      case 'key':
        return 'key';
      case 'value':
        return 'value';
      case 'key_or_value':
        return 'key_and_value';
    }
  }

  private simpleTargetLabel(target: SimpleTarget): string {
    switch (target) {
      case 'key':
        return $localize`:@@ruleEditor.ruleLabel.target.key:key`;
      case 'value':
        return $localize`:@@ruleEditor.ruleLabel.target.value:value`;
      case 'key_and_value':
        return $localize`:@@ruleEditor.ruleLabel.target.keyOrValue:key or value`;
    }
  }

  private textMatchLabel(label: string, match: KeyMatch | TextValueMatch): string {
    const verb = this.matchTypeLabel(match.matchType);
    const value = match.matchValue
      ? `"${match.matchValue}"`
      : $localize`:@@ruleEditor.ruleLabel.empty:(empty)`;
    return `${label} ${verb} ${value}`;
  }

  private matchTypeLabel(matchType: FormattingRuleMatchType): string {
    switch (matchType) {
      case 'exact':
        return $localize`:@@ruleEditor.ruleLabel.matchType.exact:exact`;
      case 'contains':
        return $localize`:@@ruleEditor.ruleLabel.matchType.contains:contains`;
      case 'starts_with':
        return $localize`:@@ruleEditor.ruleLabel.matchType.startsWith:starts with`;
      case 'ends_with':
        return $localize`:@@ruleEditor.ruleLabel.matchType.endsWith:ends with`;
    }
  }

  private valueMatchLabel(match: ValueMatch): string {
    const valueLabel = $localize`:@@ruleEditor.ruleLabel.target.value:value`;
    if (match.kind === 'text') return this.textMatchLabel(valueLabel, match);
    return `${valueLabel} ${this.predicateLabel(match.predicate)}`;
  }

  private predicateLabel(predicate: ValuePredicate): string {
    return this.predicateOptions.find((option) => option.value === predicate)?.label ?? predicate;
  }

  private isSimpleTarget(value: unknown): value is SimpleTarget {
    return value === 'key' || value === 'value' || value === 'key_and_value';
  }

  private isMatchType(value: unknown): value is FormattingRuleMatchType {
    return (
      value === 'exact' || value === 'contains' || value === 'starts_with' || value === 'ends_with'
    );
  }

  private isValuePredicate(value: unknown): value is ValuePredicate {
    return this.predicateOptions.some((option) => option.value === value);
  }

  private hasStyleObject(rule: FormattingRule): boolean {
    return rule.style !== null && typeof rule.style === 'object';
  }

  private isTextMatchConfig(value: unknown): value is KeyMatch | TextValueMatch {
    if (value === null || typeof value !== 'object') return false;
    if (!('matchType' in value) || !('matchValue' in value) || !('caseSensitive' in value)) {
      return false;
    }
    return (
      this.isMatchType(value.matchType) &&
      typeof value.matchValue === 'string' &&
      typeof value.caseSensitive === 'boolean'
    );
  }

  private isValueMatchConfig(value: unknown): value is ValueMatch {
    if (value === null || typeof value !== 'object' || !('kind' in value)) return false;
    if (value.kind === 'text') return this.isTextMatchConfig(value);
    return (
      value.kind === 'predicate' && 'predicate' in value && this.isValuePredicate(value.predicate)
    );
  }

  private cacheActiveDraft(rule: FormattingRule): void {
    this.ruleDrafts.update((caches) => {
      const nextCaches = new Map(caches);
      nextCaches.set(rule.id, this.cacheWithActiveDraft(rule));
      return nextCaches;
    });
  }

  private cacheWithActiveDraft(
    rule: FormattingRule,
    base: RuleDraftCache = this.ruleDrafts().get(rule.id) ?? { simple: null, pair: null },
  ): RuleDraftCache {
    if (this.isSimpleRule(rule)) {
      return { ...base, simple: this.simpleDraftFromRule(rule) };
    }
    if (this.isPairRule(rule)) {
      return { ...base, pair: this.pairDraftFromRule(rule) };
    }
    return base;
  }

  private simpleDraftFromRule(rule: FormattingRuleSimple): SimpleDraft {
    return {
      target: rule.target,
      matchType: rule.matchType,
      matchValue: rule.matchValue,
      caseSensitive: rule.caseSensitive,
    };
  }

  private pairDraftFromRule(rule: FormattingRulePair): PairDraft {
    return {
      keyMatch: { ...rule.keyMatch },
      valueMatch: this.cloneValueMatch(rule.valueMatch),
    };
  }

  private ruleFromSimpleDraft(
    id: string,
    draft: SimpleDraft,
    style: FormattingStyle,
  ): FormattingRuleSimple {
    return {
      id,
      kind: 'simple',
      target: draft.target,
      matchType: draft.matchType,
      matchValue: draft.matchValue,
      caseSensitive: draft.caseSensitive,
      style: { ...style },
    };
  }

  private ruleFromPairDraft(
    id: string,
    draft: PairDraft,
    style: FormattingStyle,
  ): FormattingRulePair {
    return {
      id,
      kind: 'pair',
      keyMatch: { ...draft.keyMatch },
      valueMatch: this.cloneValueMatch(draft.valueMatch),
      style: { ...style },
    };
  }

  private cloneValueMatch(match: ValueMatch): ValueMatch {
    if (match.kind === 'text') {
      return {
        kind: 'text',
        matchType: match.matchType,
        matchValue: match.matchValue,
        caseSensitive: match.caseSensitive,
      };
    }
    return { kind: 'predicate', predicate: match.predicate };
  }

  private styleFromRule(rule: FormattingRule): FormattingStyle {
    return this.hasStyleObject(rule) ? { ...rule.style } : DEFAULT_NEW_RULE_STYLE();
  }

  private draftCacheForRules(
    rules: readonly FormattingRule[],
  ): ReadonlyMap<string, RuleDraftCache> {
    const caches = new Map<string, RuleDraftCache>();
    for (const rule of rules) {
      caches.set(rule.id, this.cacheWithActiveDraft(rule, { simple: null, pair: null }));
    }
    return caches;
  }

  private flashSaved(): void {
    this.savedFlashToken += 1;
    const token = this.savedFlashToken;
    this.savedFlash.set(true);
    setTimeout(() => {
      if (this.savedFlashToken === token) this.savedFlash.set(false);
    }, SAVED_FLASH_MS);
  }

  private fingerprint(e: Editable): string {
    return JSON.stringify({
      name: e.name,
      rules: e.rules.map((rule) => this.ruleFingerprint(rule)),
    });
  }

  private ruleFingerprint(rule: FormattingRule): unknown {
    const ruleId = rule.id;
    const ruleKind = this.rawRuleKind(rule);
    if (this.isSimpleRule(rule)) {
      return {
        id: rule.id,
        kind: 'simple',
        target: rule.target,
        matchType: rule.matchType,
        matchValue: rule.matchValue,
        caseSensitive: rule.caseSensitive,
        style: this.styleFingerprint(rule.style),
      };
    }
    if (this.isPairRule(rule)) {
      return {
        id: rule.id,
        kind: 'pair',
        keyMatch: { ...rule.keyMatch },
        valueMatch: this.cloneValueMatch(rule.valueMatch),
        style: this.styleFingerprint(rule.style),
      };
    }
    return {
      id: ruleId,
      kind: ruleKind,
      skipped: true,
    };
  }

  private styleFingerprint(style: FormattingStyle): unknown {
    return {
      backgroundColor: style.backgroundColor ?? null,
      textColor: style.textColor ?? null,
      borderColor: style.borderColor ?? null,
      bold: style.bold ?? false,
      italic: style.italic ?? false,
      underline: style.underline ?? false,
      icon: style.icon ?? null,
    };
  }

  private cloneRules(rules: FormattingRule[]): FormattingRule[] {
    return rules.map((rule) => this.cloneRule(rule));
  }

  private cloneRule(rule: FormattingRule): FormattingRule {
    if (this.isSimpleRule(rule)) {
      return this.ruleFromSimpleDraft(rule.id, this.simpleDraftFromRule(rule), rule.style);
    }
    if (this.isPairRule(rule)) {
      return this.ruleFromPairDraft(rule.id, this.pairDraftFromRule(rule), rule.style);
    }
    return rule;
  }

  private newRuleId(): string {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
    return `rule-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }
}
