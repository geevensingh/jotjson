import type { SuggestionStrategy } from '../types';
import { isPlainObject, readString } from './helpers';

/**
 * GeoJSON strategy (confidence 88).
 *
 * Detects a top-level object with `type` set to one of the GeoJSON
 * types. Outputs:
 *  - "GeoJSON: N features" for FeatureCollection (N = features.length)
 *  - "GeoJSON: <name>" for a Feature with `properties.name` set
 *  - "GeoJSON: Feature" for a Feature without name
 *  - "GeoJSON: <type>" for raw geometry types (Point, LineString, etc.)
 */
const GEOJSON_TYPES = new Set([
  'Feature',
  'FeatureCollection',
  'Point',
  'MultiPoint',
  'LineString',
  'MultiLineString',
  'Polygon',
  'MultiPolygon',
  'GeometryCollection',
]);

export const geojsonStrategy: SuggestionStrategy = (input) => {
  if (!isPlainObject(input.parsed)) return null;
  const obj = input.parsed;
  const type = readString(obj, 'type');
  if (type === null || !GEOJSON_TYPES.has(type)) return null;

  if (type === 'FeatureCollection') {
    const features = obj['features'];
    if (!Array.isArray(features)) return null;
    const value = $localize`:@@toolbar.titleSuggestion.shape.geojsonFeatureCollection:GeoJSON: ${features.length}:n: features`;
    return { value, source: 'geojson', confidence: 88 };
  }

  if (type === 'Feature') {
    const properties = obj['properties'];
    if (isPlainObject(properties)) {
      const name = readString(properties, 'name');
      if (name !== null) {
        return {
          value: `GeoJSON: ${name}`,
          source: 'geojson',
          confidence: 88,
        };
      }
    }
    return {
      value: $localize`:@@toolbar.titleSuggestion.shape.geojsonFeature:GeoJSON: Feature`,
      source: 'geojson',
      confidence: 88,
    };
  }

  return {
    value: `GeoJSON: ${type}`,
    source: 'geojson',
    confidence: 88,
  };
};
