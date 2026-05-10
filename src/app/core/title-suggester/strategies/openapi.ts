import type { SuggestionStrategy } from '../types';
import { isPlainObject, readString } from './helpers';

/**
 * OpenAPI / Swagger strategy (confidence 92).
 *
 * Accepts both OpenAPI 3.x and Swagger 2.0:
 *  - OpenAPI 3.x: `{ openapi: "3.x.x", info: { title, version } }`
 *  - Swagger 2.0: `{ swagger: "2.0", info: { title, version } }`
 *
 * Output: `"{info.title} v{info.version}"`, or just `info.title` when
 * version is missing. Skips when `info.title` is missing.
 */
export const openapiStrategy: SuggestionStrategy = (input) => {
  if (!isPlainObject(input.parsed)) return null;
  const obj = input.parsed;
  const isOpenApi3 = readString(obj, 'openapi') !== null;
  const isSwagger2 = readString(obj, 'swagger') !== null;
  if (!isOpenApi3 && !isSwagger2) return null;
  const info = obj['info'];
  if (!isPlainObject(info)) return null;
  const title = readString(info, 'title');
  if (title === null) return null;
  const version = readString(info, 'version');
  const value = version !== null ? `${title} v${version}` : title;
  return { value, source: 'openapi', confidence: 92 };
};
