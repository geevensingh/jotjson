import { Pipe, PipeTransform } from '@angular/core';
import { jsonTypeOf, type JsonValueType } from '../../core/json/json-value-type';

export { jsonTypeOf, type JsonValueType };

@Pipe({ name: 'jsonType', standalone: true, pure: true })
export class JsonTypePipe implements PipeTransform {
  transform(value: unknown): JsonValueType {
    return jsonTypeOf(value);
  }
}
