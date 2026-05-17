/**
 * Conservative date string detection for the JSON tree's date annotation
 * feature. The intent is to *miss* ambiguous strings rather than risk
 * false positives - users seeing "(Jan 1, 1970 ...)" next to a string
 * like "12345" would be worse than just not annotating it at all.
 *
 * Accepted shapes (regex-gated before any parsing):
 *   - ISO 8601 with time:    YYYY-MM-DDTHH:mm[:ss[.sss]][Z|+HH:MM|-HH:MM]
 *   - ISO date-only:         YYYY-MM-DD
 *   - Slash with 4-digit year: NN/NN/YYYY (order resolved by user locale)
 *   - Loose RFC 2822 / human:  "Mon DD, YYYY" or "DD Mon YYYY" + optional time
 *   - ASP.NET / WCF JSON date: /Date(<ms-since-epoch>[+/-HHMM])/ (offset informational, ignored)
 *
 * Strings that pass the regex are parsed and required to land in
 * [1900-01-01, 2100-12-31] to defend against e.g. accidental epoch parses.
 */

const ISO_WITH_TIME =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})?$/;
const ISO_DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const SLASH_DATE = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/;
const RFC2822_ISH =
  /^(?:(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun),?\s+)?(?:(\d{1,2})\s+([A-Za-z]{3,9})|([A-Za-z]{3,9})\s+(\d{1,2}))[,\s]+(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\s*(?:Z|GMT|UTC|[+-]\d{2}:?\d{2}))?)?$/;

// Microsoft ASP.NET / WCF JSON date format: /Date(<ms-since-epoch>[<+|-><HHMM>])/.
// The optional timezone suffix is informational only per the format
// spec - the millisecond value is always UTC. We discard the offset and
// let Intl.DateTimeFormat re-localize for display, matching the
// existing ISO-with-offset precedent. The regex deliberately does not
// accept the backslash-escaped form (`\/Date(...)\/`); those are
// expected to be unescaped upstream by the JSON parser. `\d{1,13}` is
// sized to cover the legal range - 13 digits is the largest ms value
// landing inside [1900-01-01, 2100-12-31]; `isInRange` catches any
// overshoot the regex permits.
const DOTNET_DATE = /^\/Date\((-?\d{1,13})(?:[+-]\d{4})?\)\/$/;

const MIN_YEAR = 1900;
const MAX_YEAR = 2100;

export type DateOrder = 'mdy' | 'dmy' | 'ymd';

let cachedLocaleOrder: DateOrder | null = null;

/**
 * Returns the locale's preferred order of day/month/year fields based on
 * `Intl.DateTimeFormat(...).formatToParts(...)`. Cached for the lifetime
 * of the module load when no explicit locale is provided.
 */
export function detectLocaleDateOrder(locale?: string): DateOrder {
  if (cachedLocaleOrder !== null && locale === undefined) return cachedLocaleOrder;
  let order: DateOrder = 'mdy';
  try {
    const probe = new Date(2000, 0, 2);
    const parts = new Intl.DateTimeFormat(locale).formatToParts(probe);
    const seq = parts
      .filter((p) => p.type === 'day' || p.type === 'month' || p.type === 'year')
      .map((p) => p.type[0])
      .join('');
    if (seq === 'mdy' || seq === 'dmy' || seq === 'ymd') {
      order = seq;
    }
  } catch {
    /* fall through to default */
  }
  if (locale === undefined) cachedLocaleOrder = order;
  return order;
}

/** Test hook - resets the locale order cache so unit tests can re-probe. */
export function __resetLocaleOrderCacheForTesting(): void {
  cachedLocaleOrder = null;
}

function isInRange(date: Date): boolean {
  if (Number.isNaN(date.getTime())) return false;
  const year = date.getFullYear();
  return year >= MIN_YEAR && year <= MAX_YEAR;
}

function tryConstructFromYmd(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
): Date | null {
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > 31) return null;
  if (hour < 0 || hour > 23) return null;
  if (minute < 0 || minute > 59) return null;
  if (second < 0 || second > 60) return null;
  const date = new Date(year, month - 1, day, hour, minute, second);
  // Reject calendar overflow (e.g. Feb 30 -> Mar 2).
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    return null;
  }
  return isInRange(date) ? date : null;
}

const MONTH_NAMES: Record<string, number> = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
};

export interface ParsedDate {
  date: Date;
  /** True when the source string carried a time component. */
  hasTime: boolean;
}

export interface ParseOptions {
  /**
   * When true, ISO 8601 date-time strings without an explicit `Z` or
   * `+/-HH:MM` offset are interpreted as UTC instead of local. Defaults
   * to false to preserve native `Date` parsing semantics.
   */
  assumeUtcForIsoDateTime?: boolean;
  /**
   * When true, ISO 8601 date-only strings (e.g. `2026-01-31`) are
   * interpreted as UTC midnight instead of local midnight. Defaults to
   * false.
   */
  assumeUtcForIsoDateOnly?: boolean;
}

const ISO_TZ_SUFFIX = /(?:Z|[+-]\d{2}:?\d{2})$/i;

/**
 * Returns the parsed date plus a `hasTime` flag, or null if `raw` does not
 * match one of the accepted shapes or falls outside the supported range.
 */
export function parseAsDate(raw: unknown, locale?: string, opts?: ParseOptions): ParsedDate | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed.length < 8 || trimmed.length > 40) return null;

  // ASP.NET / WCF format is structurally exclusive of every other
  // matcher (which all start with `\d` or `[A-Za-z]`), so checking it
  // first is both correct and cheap. `hasTime: true` is unconditional:
  // the format has no syntactic way to distinguish a DateTime used as
  // a date (midnight-UTC payload) from a DateTime carrying a real
  // time-of-day. We pick the shape-faithful answer and accept that
  // west-of-UTC users pasting a midnight-UTC value see e.g.
  // "Nov 14, 2023, 7:00 PM" rather than "Nov 15, 2023". The two
  // `assumeUtc*` options have no effect here - the ms value is
  // already an absolute instant.
  const dotnet = DOTNET_DATE.exec(trimmed);
  if (dotnet) {
    const date = new Date(Number(dotnet[1]));
    return isInRange(date) ? { date, hasTime: true } : null;
  }

  if (ISO_WITH_TIME.test(trimmed)) {
    const hasTz = ISO_TZ_SUFFIX.test(trimmed);
    const source = !hasTz && opts?.assumeUtcForIsoDateTime ? `${trimmed}Z` : trimmed;
    const date = new Date(source);
    return isInRange(date) ? { date, hasTime: true } : null;
  }

  if (ISO_DATE_ONLY.test(trimmed)) {
    const [y, m, d] = trimmed.split('-').map((part) => Number(part));
    if (opts?.assumeUtcForIsoDateOnly) {
      if (m < 1 || m > 12 || d < 1 || d > 31) return null;
      const utc = new Date(Date.UTC(y, m - 1, d));
      if (utc.getUTCFullYear() !== y || utc.getUTCMonth() !== m - 1 || utc.getUTCDate() !== d) {
        return null;
      }
      return isInRange(utc) ? { date: utc, hasTime: false } : null;
    }
    const built = tryConstructFromYmd(y, m, d);
    return built ? { date: built, hasTime: false } : null;
  }

  const slash = SLASH_DATE.exec(trimmed);
  if (slash) {
    const first = Number(slash[1]);
    const second = Number(slash[2]);
    const year = Number(slash[3]);
    const hh = slash[4] !== undefined ? Number(slash[4]) : undefined;
    const mm = slash[5] !== undefined ? Number(slash[5]) : undefined;
    const ss = slash[6] !== undefined ? Number(slash[6]) : undefined;
    const order = detectLocaleDateOrder(locale);
    let month: number;
    let day: number;
    if (order === 'dmy') {
      day = first;
      month = second;
    } else {
      month = first;
      day = second;
    }
    const built = tryConstructFromYmd(year, month, day, hh ?? 0, mm ?? 0, ss ?? 0);
    return built ? { date: built, hasTime: hh !== undefined } : null;
  }

  const rfc = RFC2822_ISH.exec(trimmed);
  if (rfc) {
    const dayA = rfc[1];
    const monA = rfc[2];
    const monB = rfc[3];
    const dayB = rfc[4];
    const year = Number(rfc[5]);
    const hh = rfc[6] !== undefined ? Number(rfc[6]) : undefined;
    const mm = rfc[7] !== undefined ? Number(rfc[7]) : undefined;
    const ss = rfc[8] !== undefined ? Number(rfc[8]) : undefined;
    const monthName = (monA ?? monB ?? '').toLowerCase();
    const month = MONTH_NAMES[monthName];
    const day = Number(dayA ?? dayB);
    if (!month) return null;
    const built = tryConstructFromYmd(year, month, day, hh ?? 0, mm ?? 0, ss ?? 0);
    return built ? { date: built, hasTime: hh !== undefined } : null;
  }

  return null;
}

type RelativeUnit = 'year' | 'month' | 'day' | 'hour' | 'minute' | 'second';
type RelativeUnitSettings = {
  year: boolean;
  month: boolean;
  day: boolean;
  hour: boolean;
  minute: boolean;
  second: boolean;
};
type RelativeUnitDefinition = { unit: RelativeUnit; ms: number };

const REL_UNITS: RelativeUnitDefinition[] = [
  { unit: 'year', ms: 365.25 * 24 * 60 * 60 * 1000 },
  { unit: 'month', ms: 30.44 * 24 * 60 * 60 * 1000 },
  { unit: 'day', ms: 24 * 60 * 60 * 1000 },
  { unit: 'hour', ms: 60 * 60 * 1000 },
  { unit: 'minute', ms: 60 * 1000 },
  { unit: 'second', ms: 1000 },
];

const MAX_ADAPTIVE_FRACTION_DIGITS = 4;

function getEnabledRelativeUnits(enabledUnits?: RelativeUnitSettings): RelativeUnitDefinition[] {
  return REL_UNITS.filter(({ unit }) => enabledUnits?.[unit] ?? true);
}

function roundToFractionDigits(value: number, fractionDigits: number): number {
  const multiplier = 10 ** fractionDigits;
  return Math.round(value * multiplier) / multiplier;
}

function roundWithAdaptivePrecision(value: number): number {
  for (
    let fractionDigits = 1;
    fractionDigits <= MAX_ADAPTIVE_FRACTION_DIGITS;
    fractionDigits += 1
  ) {
    const roundedValue = roundToFractionDigits(value, fractionDigits);
    if (roundedValue !== 0 || fractionDigits === MAX_ADAPTIVE_FRACTION_DIGITS) {
      return roundedValue;
    }
  }
  return 0;
}

function hasDisabledSmallerUnit(
  selectedUnit: RelativeUnit,
  enabledUnits?: RelativeUnitSettings,
): boolean {
  if (enabledUnits === undefined) return false;
  const selectedIndex = REL_UNITS.findIndex(({ unit }) => unit === selectedUnit);
  if (selectedIndex < 0) return false;
  return REL_UNITS.slice(selectedIndex + 1).some(({ unit }) => !enabledUnits[unit]);
}

export function formatRelative(
  date: Date,
  now: Date,
  locale?: string,
  enabledUnits?: {
    year: boolean;
    month: boolean;
    day: boolean;
    hour: boolean;
    minute: boolean;
    second: boolean;
  },
  friendlyForms?: boolean,
): string | null {
  const enabledRelativeUnits = getEnabledRelativeUnits(enabledUnits);
  if (enabledRelativeUnits.length === 0) return null;

  const deltaMs = date.getTime() - now.getTime();
  const absoluteDeltaMs = Math.abs(deltaMs);
  const sign = deltaMs < 0 ? -1 : 1;
  const fittingUnit = enabledRelativeUnits.find(({ ms }) => absoluteDeltaMs >= ms);
  const selectedUnit = fittingUnit ?? enabledRelativeUnits[enabledRelativeUnits.length - 1];
  if (selectedUnit === undefined) return null;

  const unitValue = absoluteDeltaMs / selectedUnit.ms;
  const shouldKeepFractionalValue =
    fittingUnit !== undefined && hasDisabledSmallerUnit(selectedUnit.unit, enabledUnits);
  const absoluteValue =
    fittingUnit === undefined || shouldKeepFractionalValue
      ? roundWithAdaptivePrecision(unitValue)
      : Math.round(unitValue);
  const value = absoluteValue * sign;
  const numeric: 'auto' | 'always' =
    (friendlyForms ?? true) && Number.isInteger(value) ? 'auto' : 'always';

  try {
    return new Intl.RelativeTimeFormat(locale, { numeric }).format(value, selectedUnit.unit);
  } catch {
    return value < 0 ? `${-value} ${selectedUnit.unit}s ago` : `in ${value} ${selectedUnit.unit}s`;
  }
}

/**
 * Renders the parenthetical body (without parens) for a parsed date - the
 * locale-formatted absolute date plus a relative-time suffix joined with an
 * em-dash separator.
 */
export function formatDateAnnotation(
  parsed: ParsedDate,
  now: Date,
  locale?: string,
  enabledUnits?: {
    year: boolean;
    month: boolean;
    day: boolean;
    hour: boolean;
    minute: boolean;
    second: boolean;
  },
  friendlyForms?: boolean,
): string | null {
  const opts: Intl.DateTimeFormatOptions = parsed.hasTime
    ? { dateStyle: 'medium', timeStyle: 'short' }
    : { dateStyle: 'medium' };
  let absolute: string;
  try {
    absolute = new Intl.DateTimeFormat(locale, opts).format(parsed.date);
  } catch {
    absolute = parsed.date.toString();
  }
  const relative = formatRelative(parsed.date, now, locale, enabledUnits, friendlyForms);
  if (relative === null) return null;
  return `${absolute} \u2014 ${relative}`;
}
