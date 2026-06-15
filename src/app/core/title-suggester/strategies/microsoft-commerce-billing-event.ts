import type { SuggestionStrategy } from '../types';
import { isPlainObject, readString } from './helpers';
import { verbalize } from './humanize';

/**
 * Microsoft Commerce billing event strategy (confidence 90).
 *
 * Detects the Microsoft Commerce billing-event envelope by its four-
 * field structural witness:
 *   { eventType, eventId, eventTimestamp, charge: { ... } }
 *
 * Reference: this envelope shows up in Azure Marketplace / Microsoft
 * Partner Center billing webhooks and Service Bus messages
 * (e.g. `chargeInvoiced`, `chargeRefunded`, `subscriptionRenewed`).
 *
 * Output:
 *  - `"{verbalize(eventType)} -- {charge.product}"` when product is
 *    present (e.g. `"Charge Invoiced -- Microsoft 365 Business
 *    Basic"`).
 *  - Just `verbalize(eventType)` otherwise.
 */
export const microsoftCommerceBillingEventStrategy: SuggestionStrategy = (input) => {
  if (!isPlainObject(input.parsed)) return null;
  const obj = input.parsed;

  const eventType = readString(obj, 'eventType');
  if (eventType === null) return null;
  if (readString(obj, 'eventId') === null) return null;
  if (readString(obj, 'eventTimestamp') === null) return null;

  const charge = obj['charge'];
  if (!isPlainObject(charge)) return null;

  const verb = verbalize(eventType);
  const product = readString(charge, 'product');
  const value =
    product !== null
      ? $localize`:@@toolbar.titleSuggestion.composite.eventDashProduct:${verb}:eventVerb: -- ${product}:product:`
      : verb;

  return { value, source: 'microsoftCommerceBillingEvent', confidence: 90 };
};
