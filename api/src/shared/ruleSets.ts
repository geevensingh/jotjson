/**
 * Cosmos DB accessor + validators for formatting-rule-set documents.
 *
 * Documents live in the `rule-sets` container (partition key
 * `/userId`). The full rule list is embedded so a single read /
 * single write covers an entire set; the 50-rules-per-set limit
 * keeps every document well below Cosmos's 2 MB item cap.
 *
 * Document shape (canonical: `DESIGN_SPEC.md` §Domain Model
 * `FormattingRuleSet` and §Features 7):
 * ```
 * {
 *   id: string,            // UUID - Cosmos primary key
 *   userId: string,        // Entra oid; partition key
 *   name: string,          // <= 80 chars
 *   rules: FormattingRule[], // <= 50 entries
 *   version: number,       // bumped on every successful PUT, used as ETag
 *   createdAt: string,     // ISO; immutable; precedence sort key
 *   updatedAt: string      // ISO
 * }
 * ```
 *
 * Concurrency: the integer `version` is the client-facing concurrency
 * token (carried on `If-Match`); on the wire to Cosmos we use the
 * shared `replaceWithIfMatch` helper, which also enforces server-side
 * `_etag` IfMatch so the version + replace pair is atomic from the
 * client's point of view.
 */
import type { Container, ItemResponse } from '@azure/cosmos';
import { randomUUID } from 'crypto';
import {
  VersionConflictError,
  getCosmos,
  replaceWithIfMatch,
  type VersionedDocument,
} from './cosmos';
import {
  MAX_RULES_PER_SET,
  MAX_RULE_MATCH_VALUE_LENGTH,
  MAX_RULE_SETS_PER_USER,
  MAX_RULE_SET_NAME_LENGTH,
} from './limits';

// -------- Document types --------

export type RuleTarget = 'key' | 'value' | 'key_and_value';

/**
 * Match-type union for v1. The `regex` option is deferred to v1.1
 * pending a safe-evaluation strategy (see DESIGN_SPEC.md §Features 7,
 * "Regex policy"). Add `'regex'` back here when the engine ships it.
 */
export type FormattingRuleMatchType = 'exact' | 'contains' | 'starts_with' | 'ends_with';

// Backwards-compatible alias for older API workspace callers.
export type RuleMatchType = FormattingRuleMatchType;

export type ValuePredicate =
  | 'is_null'
  | 'is_not_null'
  | 'is_empty'
  | 'is_not_empty'
  | 'has_content'
  | 'lacks_content'
  | 'is_string'
  | 'is_not_string'
  | 'is_number'
  | 'is_not_number'
  | 'is_integer'
  | 'is_not_integer'
  | 'is_boolean'
  | 'is_not_boolean'
  | 'is_object'
  | 'is_not_object'
  | 'is_array'
  | 'is_not_array';

/**
 * Closed icon whitelist. Mirrors the `FormattingIcon` union on the
 * frontend side (`src/app/core/api/models.ts`); kept in lockstep
 * because new icons require a spec amendment, not a user-supplied
 * free-form string.
 */
export type FormattingIcon = 'warning' | 'check' | 'star' | 'info' | 'error' | 'flag' | 'bookmark';

const FORMATTING_ICONS: readonly FormattingIcon[] = [
  'warning',
  'check',
  'star',
  'info',
  'error',
  'flag',
  'bookmark',
] as const;

const RULE_TARGETS: readonly RuleTarget[] = ['key', 'value', 'key_and_value'] as const;

const MATCH_TYPES: readonly FormattingRuleMatchType[] = [
  'exact',
  'contains',
  'starts_with',
  'ends_with',
] as const;

const VALUE_PREDICATES: readonly ValuePredicate[] = [
  'is_null',
  'is_not_null',
  'is_empty',
  'is_not_empty',
  'has_content',
  'lacks_content',
  'is_string',
  'is_not_string',
  'is_number',
  'is_not_number',
  'is_integer',
  'is_not_integer',
  'is_boolean',
  'is_not_boolean',
  'is_object',
  'is_not_object',
  'is_array',
  'is_not_array',
] as const;

const VALUE_MATCH_KINDS = ['text', 'predicate'] as const;
const RULE_KINDS = ['simple', 'pair'] as const;

type RuleKind = (typeof RULE_KINDS)[number];
type ValueMatchKind = (typeof VALUE_MATCH_KINDS)[number];

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

export interface FormattingStyle {
  backgroundColor?: string;
  textColor?: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  borderColor?: string;
  icon?: FormattingIcon;
}

export interface KeyMatch {
  matchType: FormattingRuleMatchType;
  matchValue: string;
  caseSensitive: boolean;
}

export type ValueMatch =
  | {
      kind: 'text';
      matchType: FormattingRuleMatchType;
      matchValue: string;
      caseSensitive: boolean;
    }
  | {
      kind: 'predicate';
      predicate: ValuePredicate;
    };

export interface FormattingRuleSimple {
  id: string;
  kind?: 'simple';
  target: RuleTarget;
  matchType: FormattingRuleMatchType;
  matchValue: string;
  caseSensitive: boolean;
  style: FormattingStyle;
  keyMatch?: never;
  valueMatch?: never;
}

export interface FormattingRulePair {
  id: string;
  kind: 'pair';
  keyMatch: KeyMatch;
  valueMatch: ValueMatch;
  style: FormattingStyle;
  target?: never;
  matchType?: never;
  matchValue?: never;
  caseSensitive?: never;
}

export type FormattingRule = FormattingRuleSimple | FormattingRulePair;

export interface RuleSetDocument extends VersionedDocument {
  id: string;
  userId: string;
  name: string;
  rules: FormattingRule[];
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface CreateRuleSetInput {
  name: string;
  rules: FormattingRule[];
}

export interface UpdateRuleSetPayload {
  name: string;
  rules: FormattingRule[];
}

// -------- Errors --------

export class RuleSetValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RuleSetValidationError';
  }
}

// -------- Validators --------

function assertEnum<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw new RuleSetValidationError(`${field} must be one of ${allowed.join(', ')}`);
  }
  return value as T;
}

function assertBool(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') {
    throw new RuleSetValidationError(`${field} must be a boolean`);
  }
  return value;
}

function assertHexColor(value: unknown, field: string): string {
  if (typeof value !== 'string' || !HEX_COLOR.test(value)) {
    throw new RuleSetValidationError(`${field} must be a #RRGGBB hex color`);
  }
  return value.toLowerCase();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const STYLE_KEYS = new Set([
  'backgroundColor',
  'textColor',
  'bold',
  'italic',
  'underline',
  'borderColor',
  'icon',
]);

const RULE_KEYS: Record<RuleKind, ReadonlySet<string>> = {
  simple: new Set(['id', 'kind', 'target', 'matchType', 'matchValue', 'caseSensitive', 'style']),
  pair: new Set(['id', 'kind', 'keyMatch', 'valueMatch', 'style']),
};

const KEY_MATCH_KEYS: ReadonlySet<string> = new Set(['matchType', 'matchValue', 'caseSensitive']);

const VALUE_MATCH_KEYS: Record<ValueMatchKind, ReadonlySet<string>> = {
  text: new Set(['kind', 'matchType', 'matchValue', 'caseSensitive']),
  predicate: new Set(['kind', 'predicate']),
};

const RULE_SET_PAYLOAD_KEYS = new Set(['name', 'rules']);

function assertKnownKeys(
  value: Record<string, unknown>,
  allowedKeys: ReadonlySet<string>,
  field: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) {
      throw new RuleSetValidationError(`${field} has unknown field "${key}"`);
    }
  }
}

function assertRuleId(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 64) {
    throw new RuleSetValidationError(`${field} must be a 1-64 character string`);
  }
  return value;
}

function assertMatchValue(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new RuleSetValidationError(`${field} must be a non-empty string`);
  }
  if (value.length > MAX_RULE_MATCH_VALUE_LENGTH) {
    throw new RuleSetValidationError(
      `${field} too long - max ${MAX_RULE_MATCH_VALUE_LENGTH} chars (got ${value.length})`,
    );
  }
  return value;
}

export function assertStyle(value: unknown, field: string): FormattingStyle {
  if (!isRecord(value)) {
    throw new RuleSetValidationError(`${field} must be an object`);
  }
  for (const key of Object.keys(value)) {
    if (!STYLE_KEYS.has(key)) {
      throw new RuleSetValidationError(`${field} has unknown field "${key}"`);
    }
  }
  const out: FormattingStyle = {};
  if (value['backgroundColor'] !== undefined) {
    out.backgroundColor = assertHexColor(value['backgroundColor'], `${field}.backgroundColor`);
  }
  if (value['textColor'] !== undefined) {
    out.textColor = assertHexColor(value['textColor'], `${field}.textColor`);
  }
  if (value['borderColor'] !== undefined) {
    out.borderColor = assertHexColor(value['borderColor'], `${field}.borderColor`);
  }
  if (value['bold'] !== undefined) out.bold = assertBool(value['bold'], `${field}.bold`);
  if (value['italic'] !== undefined) out.italic = assertBool(value['italic'], `${field}.italic`);
  if (value['underline'] !== undefined) {
    out.underline = assertBool(value['underline'], `${field}.underline`);
  }
  if (value['icon'] !== undefined) {
    out.icon = assertEnum(value['icon'], FORMATTING_ICONS, `${field}.icon`);
  }
  return out;
}

function assertSimpleRule(raw: unknown, field: string): FormattingRuleSimple {
  if (!isRecord(raw)) {
    throw new RuleSetValidationError(`${field} must be an object`);
  }
  assertKnownKeys(raw, RULE_KEYS.simple, field);

  const id = assertRuleId(raw['id'], `${field}.id`);
  const kind =
    raw['kind'] === undefined
      ? undefined
      : assertEnum(raw['kind'], ['simple'] as const, `${field}.kind`);
  const target = assertEnum(raw['target'], RULE_TARGETS, `${field}.target`);
  const matchType = assertEnum(raw['matchType'], MATCH_TYPES, `${field}.matchType`);
  const matchValue = assertMatchValue(raw['matchValue'], `${field}.matchValue`);
  const caseSensitive = assertBool(raw['caseSensitive'], `${field}.caseSensitive`);
  const style = assertStyle(raw['style'], `${field}.style`);

  if (kind === undefined) {
    return { id, target, matchType, matchValue, caseSensitive, style };
  }
  return { id, kind, target, matchType, matchValue, caseSensitive, style };
}

export function assertKeyMatch(value: unknown, field = 'keyMatch'): KeyMatch {
  if (!isRecord(value)) {
    throw new RuleSetValidationError(`${field} must be an object`);
  }
  assertKnownKeys(value, KEY_MATCH_KEYS, field);
  return {
    matchType: assertEnum(value['matchType'], MATCH_TYPES, `${field}.matchType`),
    matchValue: assertMatchValue(value['matchValue'], `${field}.matchValue`),
    caseSensitive: assertBool(value['caseSensitive'], `${field}.caseSensitive`),
  };
}

export function assertTextMatch(
  value: unknown,
  field = 'valueMatch',
): Extract<ValueMatch, { kind: 'text' }> {
  if (!isRecord(value)) {
    throw new RuleSetValidationError(`${field} must be an object`);
  }
  assertKnownKeys(value, VALUE_MATCH_KEYS.text, field);
  return {
    kind: assertEnum(value['kind'], ['text'] as const, `${field}.kind`),
    matchType: assertEnum(value['matchType'], MATCH_TYPES, `${field}.matchType`),
    matchValue: assertMatchValue(value['matchValue'], `${field}.matchValue`),
    caseSensitive: assertBool(value['caseSensitive'], `${field}.caseSensitive`),
  };
}

export function assertPredicateMatch(
  value: unknown,
  field = 'valueMatch',
): Extract<ValueMatch, { kind: 'predicate' }> {
  if (!isRecord(value)) {
    throw new RuleSetValidationError(`${field} must be an object`);
  }
  assertKnownKeys(value, VALUE_MATCH_KEYS.predicate, field);
  return {
    kind: assertEnum(value['kind'], ['predicate'] as const, `${field}.kind`),
    predicate: assertEnum(value['predicate'], VALUE_PREDICATES, `${field}.predicate`),
  };
}

export function assertValueMatch(value: unknown, field = 'valueMatch'): ValueMatch {
  if (!isRecord(value)) {
    throw new RuleSetValidationError(`${field} must be an object`);
  }
  const kind = assertEnum(value['kind'], VALUE_MATCH_KINDS, `${field}.kind`);
  return kind === 'text' ? assertTextMatch(value, field) : assertPredicateMatch(value, field);
}

export function assertPairRule(raw: unknown, field = 'rule'): FormattingRulePair {
  if (!isRecord(raw)) {
    throw new RuleSetValidationError(`${field} must be an object`);
  }
  assertKnownKeys(raw, RULE_KEYS.pair, field);
  return {
    id: assertRuleId(raw['id'], `${field}.id`),
    kind: assertEnum(raw['kind'], ['pair'] as const, `${field}.kind`),
    keyMatch: assertKeyMatch(raw['keyMatch'], `${field}.keyMatch`),
    valueMatch: assertValueMatch(raw['valueMatch'], `${field}.valueMatch`),
    style: assertStyle(raw['style'], `${field}.style`),
  };
}

export function assertRule(value: unknown, field: string): FormattingRule {
  if (!isRecord(value)) {
    throw new RuleSetValidationError(`${field} must be an object`);
  }
  const kind =
    value['kind'] === undefined ? 'simple' : assertEnum(value['kind'], RULE_KINDS, `${field}.kind`);
  assertKnownKeys(value, RULE_KEYS[kind], field);
  return kind === 'simple' ? assertSimpleRule(value, field) : assertPairRule(value, field);
}

/**
 * Validates and normalizes a `{ name, rules }` payload. Rejects
 * unknown top-level keys, malformed rules, and duplicate rule IDs.
 * Trims `name` and rejects empty strings; the only acceptable
 * trimmed length is 1..MAX_RULE_SET_NAME_LENGTH.
 */
export function assertRuleSetPayload(payload: unknown): UpdateRuleSetPayload {
  if (!isRecord(payload)) {
    throw new RuleSetValidationError('Request body must be an object');
  }
  for (const key of Object.keys(payload)) {
    if (!RULE_SET_PAYLOAD_KEYS.has(key)) {
      throw new RuleSetValidationError(`Unknown field "${key}"`);
    }
  }

  const rawName = payload['name'];
  if (typeof rawName !== 'string') {
    throw new RuleSetValidationError('name must be a string');
  }
  const name = rawName.trim();
  if (name.length === 0) {
    throw new RuleSetValidationError('name must not be blank');
  }
  if (name.length > MAX_RULE_SET_NAME_LENGTH) {
    throw new RuleSetValidationError(
      `name too long - max ${MAX_RULE_SET_NAME_LENGTH} chars (got ${name.length})`,
    );
  }

  const rawRules = payload['rules'];
  if (!Array.isArray(rawRules)) {
    throw new RuleSetValidationError('rules must be an array');
  }
  if (rawRules.length > MAX_RULES_PER_SET) {
    throw new RuleSetValidationError(
      `Too many rules - max ${MAX_RULES_PER_SET} per set (got ${rawRules.length})`,
    );
  }
  const rules: FormattingRule[] = [];
  const seenIds = new Set<string>();
  for (let i = 0; i < rawRules.length; i++) {
    const rule = assertRule(rawRules[i], `rules[${i}]`);
    if (seenIds.has(rule.id)) {
      throw new RuleSetValidationError(`Duplicate rule id "${rule.id}" in rules`);
    }
    seenIds.add(rule.id);
    rules.push(rule);
  }
  return { name, rules };
}

// -------- Cosmos accessor --------

let cached: Container | undefined;

export function getRuleSetsContainer(): Container {
  if (!cached) {
    cached = getCosmos().database.container('rule-sets');
  }
  return cached;
}

/** Reset the cached container - used by tests. */
export function __resetRuleSetsContainerForTesting(): void {
  cached = undefined;
}

/**
 * Read every rule set owned by `userId`, sorted by `createdAt` ASC.
 * `createdAt` is the precedence sort key per F2 in M6a.5: the order
 * of evaluation of multiple active sets is the same order users see
 * in their list, and `createdAt` is immutable so renames don't shift
 * precedence. Single-partition query (no cross-partition RU cost).
 */
export async function listRuleSetsByOwner(userId: string): Promise<RuleSetDocument[]> {
  if (typeof userId !== 'string' || userId.length === 0) return [];
  const { resources } = await getRuleSetsContainer()
    .items.query<RuleSetDocument>({
      query: 'SELECT * FROM c WHERE c.userId = @userId ORDER BY c.createdAt ASC',
      parameters: [{ name: '@userId', value: userId }],
    })
    .fetchAll();
  return resources;
}

/**
 * Read a single rule set by id within the given user's partition.
 * Returns null on 404 or when the document exists but belongs to a
 * different partition (shouldn't happen given our `(id, userId)`
 * lookup, but defensive). Throws on infra failures.
 */
export async function readRuleSet(id: string, userId: string): Promise<RuleSetDocument | null> {
  if (typeof id !== 'string' || id.length === 0) return null;
  if (typeof userId !== 'string' || userId.length === 0) return null;
  try {
    const { resource } = await getRuleSetsContainer().item(id, userId).read<RuleSetDocument>();
    return resource ?? null;
  } catch (error) {
    if ((error as { code?: number }).code === 404) return null;
    throw error;
  }
}

/**
 * Cross-partition read by id only. Used by handlers that must
 * distinguish "not found" from "owned by someone else" (the spec
 * requires 403 on owner mismatch, not 404). Avoids leaking via
 * timing.
 */
export async function findRuleSetById(id: string): Promise<RuleSetDocument | null> {
  if (typeof id !== 'string' || id.length === 0) return null;
  const { resources } = await getRuleSetsContainer()
    .items.query<RuleSetDocument>({
      query: 'SELECT * FROM c WHERE c.id = @id',
      parameters: [{ name: '@id', value: id }],
    })
    .fetchAll();
  return resources[0] ?? null;
}

/**
 * Insert a new rule set. Caller is responsible for enforcing the
 * per-user quota (MAX_RULE_SETS_PER_USER) before calling. Stamps a
 * fresh UUID, `version: 1`, and matching createdAt/updatedAt.
 */
export async function createRuleSet(
  userId: string,
  input: CreateRuleSetInput,
): Promise<RuleSetDocument> {
  if (typeof userId !== 'string' || userId.length === 0) {
    throw new RuleSetValidationError('userId is required');
  }
  const now = new Date().toISOString();
  const doc: RuleSetDocument = {
    id: randomUUID(),
    userId,
    name: input.name,
    rules: input.rules,
    version: 1,
    createdAt: now,
    updatedAt: now,
  };
  const response: ItemResponse<RuleSetDocument> =
    await getRuleSetsContainer().items.create<RuleSetDocument>(doc);
  return response.resource ?? doc;
}

/**
 * Replace an existing rule set with the supplied (name, rules). The
 * caller has already loaded `existing` and is therefore responsible
 * for enforcing concurrency: if `expectedVersion` does not equal
 * `existing.version`, this throws `VersionConflictError` early so
 * the handler can return 412 without a wire round trip. The replace
 * itself is also guarded by `_etag` IfMatch via `replaceWithIfMatch`
 * - so even if two callers pass the same `expectedVersion`, only one
 * write succeeds; the other gets `VersionConflictError`. On success
 * the new doc carries `version: existing.version + 1` and a
 * refreshed `updatedAt`; `id`, `userId`, and `createdAt` are
 * preserved.
 */
export async function replaceRuleSet(
  existing: RuleSetDocument,
  payload: UpdateRuleSetPayload,
  expectedVersion: number,
): Promise<RuleSetDocument> {
  if (existing.version !== expectedVersion) {
    throw new VersionConflictError(
      `Rule set was modified by another writer (expected version ${expectedVersion}, found ${existing.version})`,
    );
  }
  return replaceWithIfMatch<RuleSetDocument>(
    getRuleSetsContainer(),
    existing.userId,
    existing,
    (draft) => {
      draft.name = payload.name;
      draft.rules = payload.rules;
      draft.updatedAt = new Date().toISOString();
    },
  );
}

/**
 * Delete a rule set by (id, userId). Returns true if the doc was
 * removed, false if it did not exist. Callers must verify
 * ownership before calling.
 */
export async function deleteRuleSetById(id: string, userId: string): Promise<boolean> {
  try {
    await getRuleSetsContainer().item(id, userId).delete();
    return true;
  } catch (error) {
    if ((error as { code?: number }).code === 404) return false;
    throw error;
  }
}

// Re-export limits so callers can `import { MAX_RULE_SETS_PER_USER } from './ruleSets'`.
export {
  MAX_RULES_PER_SET,
  MAX_RULE_MATCH_VALUE_LENGTH,
  MAX_RULE_SETS_PER_USER,
  MAX_RULE_SET_NAME_LENGTH,
};
