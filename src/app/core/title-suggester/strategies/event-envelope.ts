import type { SuggestionStrategy } from '../types';
import { isPlainObject, readString } from './helpers';
import { verbalize } from './humanize';

/**
 * `eventEnvelope` composite strategy (confidence 85).
 *
 * General fallback for "envelope" payloads that don't match a known
 * vendor recognizer but carry one of the event/action anchors plus
 * one of the resource anchors:
 *
 *   anchor A (event/action): `eventType` | `type` | `action`
 *   anchor B (resource):     `product` | `resourceType` | `sku` | `service`
 *
 * Output: `"{verbalize(anchorA)} -- {anchorB}"`. The first anchor is
 * verbalized (`chargeInvoiced` -> `Charge Invoiced`); the second is
 * surfaced verbatim because resource names are typically already
 * human-readable (`Microsoft 365 Business Basic`).
 *
 * Suppression: skips when `cloudEvent` (requires
 * specversion+id+type+source) or `microsoftCommerceBillingEvent`
 * (requires eventType+eventId+eventTimestamp+charge) would also fire
 * on the same input -- the compose layer would dedupe identical
 * strings but suppressing early keeps the menu lean for envelopes
 * with stronger recognizers.
 *
 * Anchor B rejection: a "pure SKU" second anchor (matches
 * `SKU_LIKE_RE` and contains no whitespace) like `"1D9-00001"`
 * reads worse than the bare verb, so the strategy returns null
 * entirely in that case rather than producing a misleading title.
 */
const ANCHOR_A_KEYS = ['eventType', 'type', 'action'] as const;
const ANCHOR_B_KEYS = ['product', 'resourceType', 'sku', 'service'] as const;
const SKU_LIKE_RE = /^[A-Z0-9]+[-_][A-Z0-9-]+$/;

function wouldStrongerRecognizerFire(obj: Record<string, unknown>): boolean {
  const isCloudEvent =
    readString(obj, 'specversion') !== null &&
    readString(obj, 'id') !== null &&
    readString(obj, 'type') !== null &&
    readString(obj, 'source') !== null;
  if (isCloudEvent) return true;
  const isMsCommerce =
    readString(obj, 'eventType') !== null &&
    readString(obj, 'eventId') !== null &&
    readString(obj, 'eventTimestamp') !== null &&
    isPlainObject(obj['charge']);
  return isMsCommerce;
}

function isBusinessQuotable(value: string): boolean {
  return /\s/.test(value);
}

function findFirstAnchor(
  obj: Record<string, unknown>,
  keys: readonly string[],
): { key: string; value: string } | null {
  for (const key of keys) {
    const v = readString(obj, key);
    if (v !== null) return { key, value: v };
  }
  return null;
}

export const eventEnvelopeStrategy: SuggestionStrategy = (input) => {
  if (!isPlainObject(input.parsed)) return null;
  const obj = input.parsed;

  if (wouldStrongerRecognizerFire(obj)) return null;

  const anchorA = findFirstAnchor(obj, ANCHOR_A_KEYS);
  if (anchorA === null) return null;
  const anchorB = findFirstAnchor(obj, ANCHOR_B_KEYS);
  if (anchorB === null) return null;

  if (SKU_LIKE_RE.test(anchorB.value) && !isBusinessQuotable(anchorB.value)) return null;

  const verb = verbalize(anchorA.value);
  const value = $localize`:@@toolbar.titleSuggestion.composite.eventDashProduct:${verb}:eventVerb: -- ${anchorB.value}:product:`;

  return { value, source: 'eventEnvelope', confidence: 85 };
};
