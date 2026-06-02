import type { SuggestionStrategy } from '../types';
import { isPlainObject, readString, readStringDeep } from './helpers';

/**
 * Application Insights telemetry envelope strategy (confidence 90).
 *
 * Detects the Application Insights ingestion envelope by its
 * structural witness:
 *   { name, time, iKey, tags, data: { baseType, baseData } }
 *
 * Reference: the Application Insights / Azure Monitor SDKs emit this
 * envelope shape over HTTPS to the ingestion endpoint; raw envelopes
 * are commonly seen in support / debugging contexts.
 *
 * Output: `"{data.baseType}: {data.baseData.name | data.baseData.
 * message}"`. `name` is the dominant identifier for EventTelemetry /
 * RequestTelemetry / DependencyTelemetry / PageViewTelemetry;
 * `message` covers ExceptionTelemetry / MessageTelemetry. Falls back
 * to just `data.baseType` when neither is present.
 */
export const applicationInsightsTelemetryStrategy: SuggestionStrategy = (input) => {
  if (!isPlainObject(input.parsed)) return null;
  const obj = input.parsed;

  if (readString(obj, 'name') === null) return null;
  if (readString(obj, 'time') === null) return null;
  if (readString(obj, 'iKey') === null) return null;
  if (!isPlainObject(obj['tags'])) return null;

  const data = obj['data'];
  if (!isPlainObject(data)) return null;
  const baseType = readString(data, 'baseType');
  if (baseType === null) return null;
  if (!isPlainObject(data['baseData'])) return null;

  const detail =
    readStringDeep(data, ['baseData', 'name']) ?? readStringDeep(data, ['baseData', 'message']);

  const value =
    detail !== null
      ? $localize`:@@toolbar.titleSuggestion.appInsights.baseTypeColon:${baseType}:baseType:: ${detail}:detail:`
      : baseType;

  return { value, source: 'applicationInsightsTelemetry', confidence: 90 };
};
