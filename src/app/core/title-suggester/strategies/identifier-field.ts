import type { SuggestionStrategy } from '../types';
import { isPlainObject, looksLikeBusinessId, readString } from './helpers';

/**
 * `identifierField` strategy (confidence 76).
 *
 * Hunts for a top-level "business identifier" field -- the kind a
 * human might quote in conversation ("Invoice G138888993",
 * "Order ABC-123"). The output stitches the humanized prefix with
 * the value, e.g. `"Invoice G138888993"`.
 *
 * Sits at confidence 76 -- below `selfUrl` (77, which encodes a
 * canonical resource link) but above `namedField` (75, which catches
 * generic identifier-like fields).
 *
 * Tight prefix set on purpose. Excluded prefixes:
 *  - `traceId`, `requestId`, `correlationId`, `eventId` -- almost
 *    always opaque machine tokens (UUIDs / hex). Surfacing them as a
 *    title is noise and (for `traceId` / `correlationId`)
 *    privacy-adjacent.
 *
 * Value must additionally pass `looksLikeBusinessId` (rejects UUIDs,
 * long pure-numerics, long pure-hex tokens) so an `invoiceId` with a
 * UUID value still skips this strategy.
 */
interface PrefixEntry {
  readonly key: string;
  readonly label: string;
  readonly i18nId: string;
}

const PREFIXES: readonly PrefixEntry[] = [
  { key: 'invoiceId', label: 'Invoice', i18nId: '@@toolbar.titleSuggestion.identifier.invoice' },
  { key: 'orderId', label: 'Order', i18nId: '@@toolbar.titleSuggestion.identifier.order' },
  {
    key: 'transactionId',
    label: 'Transaction',
    i18nId: '@@toolbar.titleSuggestion.identifier.transaction',
  },
  {
    key: 'confirmationId',
    label: 'Confirmation',
    i18nId: '@@toolbar.titleSuggestion.identifier.confirmation',
  },
  { key: 'bookingId', label: 'Booking', i18nId: '@@toolbar.titleSuggestion.identifier.booking' },
  { key: 'caseId', label: 'Case', i18nId: '@@toolbar.titleSuggestion.identifier.case' },
  { key: 'ticketId', label: 'Ticket', i18nId: '@@toolbar.titleSuggestion.identifier.ticket' },
  { key: 'incidentId', label: 'Incident', i18nId: '@@toolbar.titleSuggestion.identifier.incident' },
  {
    key: 'referenceId',
    label: 'Reference',
    i18nId: '@@toolbar.titleSuggestion.identifier.reference',
  },
];

function formatLabeled(label: string, id: string, i18nId: string): string {
  switch (i18nId) {
    case '@@toolbar.titleSuggestion.identifier.invoice':
      return $localize`:@@toolbar.titleSuggestion.identifier.invoice:Invoice ${id}:id:`;
    case '@@toolbar.titleSuggestion.identifier.order':
      return $localize`:@@toolbar.titleSuggestion.identifier.order:Order ${id}:id:`;
    case '@@toolbar.titleSuggestion.identifier.transaction':
      return $localize`:@@toolbar.titleSuggestion.identifier.transaction:Transaction ${id}:id:`;
    case '@@toolbar.titleSuggestion.identifier.confirmation':
      return $localize`:@@toolbar.titleSuggestion.identifier.confirmation:Confirmation ${id}:id:`;
    case '@@toolbar.titleSuggestion.identifier.booking':
      return $localize`:@@toolbar.titleSuggestion.identifier.booking:Booking ${id}:id:`;
    case '@@toolbar.titleSuggestion.identifier.case':
      return $localize`:@@toolbar.titleSuggestion.identifier.case:Case ${id}:id:`;
    case '@@toolbar.titleSuggestion.identifier.ticket':
      return $localize`:@@toolbar.titleSuggestion.identifier.ticket:Ticket ${id}:id:`;
    case '@@toolbar.titleSuggestion.identifier.incident':
      return $localize`:@@toolbar.titleSuggestion.identifier.incident:Incident ${id}:id:`;
    case '@@toolbar.titleSuggestion.identifier.reference':
      return $localize`:@@toolbar.titleSuggestion.identifier.reference:Reference ${id}:id:`;
    default:
      return `${label} ${id}`;
  }
}

export const identifierFieldStrategy: SuggestionStrategy = (input) => {
  if (!isPlainObject(input.parsed)) return null;
  const obj = input.parsed;
  for (const prefix of PREFIXES) {
    const raw = readString(obj, prefix.key);
    if (raw === null) continue;
    if (!looksLikeBusinessId(raw)) continue;
    return {
      value: formatLabeled(prefix.label, raw, prefix.i18nId),
      source: 'identifierField',
      confidence: 76,
    };
  }
  return null;
};
