import { Injectable, inject } from '@angular/core';
import { extractFromMixedText } from './json-extractor.core';
import type { ExtractedJson } from './json-extractor.core';
import { JsonParserService } from './json-parser.service';

export type { ExtractedJson } from './json-extractor.core';

@Injectable({ providedIn: 'root' })
export class JsonExtractorService {
  private readonly parser = inject(JsonParserService);

  extractFromMixedText(input: string): ExtractedJson | null {
    return extractFromMixedText(input, (candidateText) => this.parser.parse(candidateText));
  }
}
