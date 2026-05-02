import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

import {
  FormattingRule,
  FormattingRulePair,
  FormattingRuleSet,
  FormattingRuleSimple,
  KeyMatch,
  ValueMatch,
} from '../../../../core/api/models';
import { JsonTreeComponent } from '../../../../shared/components/json-tree/json-tree.component';
import { meetsAA, THEME_DEFAULTS } from '../../../../shared/utils/contrast';

/**
 * Static representative sample shown in the live preview. Picked to
 * exercise the common rule shapes a user is likely to write while
 * editing: matching on a key (`error`, `status`, `email`), matching
 * by value (the `"TypeError"` string, the `500` numeric status), and
 * a mix of containers, primitives, `null`, and an array so container
 * vs leaf rendering both have something to show.
 */
const SAMPLE: Readonly<Record<string, unknown>> = Object.freeze({
  status: 500,
  error: 'TypeError',
  errorType: 'error',
  testHeader: 'present',
  testHeaderNull: null,
  message: 'Cannot read properties of undefined',
  user: {
    id: 42,
    email: 'user@example.com',
    active: true,
  },
  tags: ['retry', 'critical'],
  resolvedAt: null,
});

const MAX_LABEL_LENGTH = 30;

/**
 * One rule that fails AA in at least one theme. Captured at the
 * preview layer so the banner can describe each offender by its
 * (truncated) match value and which theme(s) it fails in.
 */
export interface ContrastFailure {
  ruleId: string;
  label: string;
  failsLight: boolean;
  failsDark: boolean;
}

/**
 * M6d-3 live preview. Renders a built-in static sample JSON through
 * the production `JsonTreeComponent` with the in-progress draft rule
 * set forwarded via `[overrideRuleSets]`. The override is a
 * per-instance Input on the tree, so this preview never affects other
 * tree instances (e.g. the home page tree).
 *
 * M6g-3 adds a non-blocking WCAG-AA contrast warning banner above the
 * preview. A rule is flagged when its effective foreground/background
 * pair (rule color else theme default) clears AA in neither the light
 * nor the dark theme. `borderColor` is decorative and not evaluated.
 */
@Component({
  selector: 'app-rule-preview',
  standalone: true,
  imports: [JsonTreeComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './rule-preview.component.html',
  styleUrl: './rule-preview.component.scss',
})
export class RulePreviewComponent {
  readonly draft = input.required<FormattingRuleSet>();

  readonly sampleJson: unknown = SAMPLE;

  /** Tree consumes a list; wrap the single draft as a one-element array. */
  readonly overrideRuleSets = computed<FormattingRuleSet[]>(() => [this.draft()]);

  /**
   * Rules in the draft whose effective fg/bg fail AA in at least one
   * theme. Empty list -> no banner is shown.
   */
  readonly contrastFailures = computed<ContrastFailure[]>(() => {
    const out: ContrastFailure[] = [];
    for (const rule of this.draft().rules) {
      const failure = evaluateRule(rule);
      if (failure !== null) {
        out.push(failure);
      }
    }
    return out;
  });
}

function evaluateRule(rule: FormattingRule): ContrastFailure | null {
  const label = contrastLabel(rule);
  if (label === null) return null;
  const text = rule.style.textColor;
  const bg = rule.style.backgroundColor;
  // Rule contributes neither a foreground nor a background -> nothing
  // to evaluate beyond the theme's own defaults, which pass by design.
  if (text === undefined && bg === undefined) {
    return null;
  }
  // Skip rules with malformed hex (e.g. partial input the user is
  // still typing). The model's `assertHex` rejects these on save, so
  // the preview just stays silent until the value is well-formed.
  if (!isValidHex(text) || !isValidHex(bg)) {
    return null;
  }
  const lightFg = text ?? THEME_DEFAULTS.light.fg;
  const lightBg = bg ?? THEME_DEFAULTS.light.bg;
  const darkFg = text ?? THEME_DEFAULTS.dark.fg;
  const darkBg = bg ?? THEME_DEFAULTS.dark.bg;
  const failsLight = !meetsAA(lightFg, lightBg);
  const failsDark = !meetsAA(darkFg, darkBg);
  if (!failsLight && !failsDark) {
    return null;
  }
  return {
    ruleId: rule.id,
    label: truncate(label),
    failsLight,
    failsDark,
  };
}

function contrastLabel(rule: FormattingRule): string | null {
  if (isSimpleRule(rule)) return rule.matchValue;
  if (!isPairRule(rule)) return null;
  const emptyLabel = $localize`:@@rulePreview.contrast.empty:(empty)`;
  const andLabel = $localize`:@@rulePreview.contrast.and:AND`;
  const keyLabel = rule.keyMatch.matchValue.trim() || emptyLabel;
  if (rule.valueMatch.kind === 'text') {
    return `${keyLabel} ${andLabel} ${rule.valueMatch.matchValue.trim() || emptyLabel}`;
  }
  return `${keyLabel} ${andLabel} ${rule.valueMatch.predicate}`;
}

function isSimpleRule(rule: FormattingRule): rule is FormattingRuleSimple {
  if ((rule.kind ?? 'simple') !== 'simple') return false;
  if (!('matchValue' in rule)) return false;
  return typeof rule.matchValue === 'string' && hasStyleObject(rule);
}

function isPairRule(rule: FormattingRule): rule is FormattingRulePair {
  if (rule.kind !== 'pair') return false;
  if (!('keyMatch' in rule) || !('valueMatch' in rule)) return false;
  return (
    isTextMatchConfig(rule.keyMatch) && isValueMatchConfig(rule.valueMatch) && hasStyleObject(rule)
  );
}

function hasStyleObject(rule: FormattingRule): boolean {
  return rule.style !== null && typeof rule.style === 'object';
}

function isTextMatchConfig(value: unknown): value is KeyMatch {
  if (value === null || typeof value !== 'object') return false;
  return 'matchValue' in value && typeof value.matchValue === 'string';
}

function isValueMatchConfig(value: unknown): value is ValueMatch {
  if (value === null || typeof value !== 'object' || !('kind' in value)) return false;
  if (value.kind === 'text') return isTextMatchConfig(value);
  return value.kind === 'predicate' && 'predicate' in value && typeof value.predicate === 'string';
}

const HEX6_RE = /^#[0-9a-fA-F]{6}$/;

function isValidHex(value: string | undefined): boolean {
  return value === undefined || HEX6_RE.test(value);
}

function truncate(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return $localize`:@@rulePreview.contrast.empty:(empty)`;
  }
  if (trimmed.length <= MAX_LABEL_LENGTH) {
    return trimmed;
  }
  return trimmed.slice(0, MAX_LABEL_LENGTH - 3) + '...';
}
