import { Pipe, PipeTransform } from '@angular/core';

export type JsonValueType =
  | 'object'
  | 'array'
  | 'string'
  | 'number'
  | 'boolean'
  | 'null'
  | 'undefined';

export function jsonTypeOf(value: unknown): JsonValueType {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'object') return 'object';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'boolean') return 'boolean';
  return 'string';
}

@Pipe({ name: 'jsonType', standalone: true, pure: true })
export class JsonTypePipe implements PipeTransform {
  transform(value: unknown): JsonValueType {
    return jsonTypeOf(value);
  }
}
