/// <reference lib="webworker" />

import { parse, ParseError } from 'jsonc-parser';
import { extractFromMixedText } from './json-extractor.core';

// Message shapes - keep these in sync with the service.
export interface ScanRequest {
  type: 'scan';
  // Identifies the parse generation; service drops responses for stale versions.
  sourceVersion: number;
  // Strings to scan. The service is responsible for de-duping before sending,
  // for size pre-screening, and for the {/[ pre-screen.
  strings: readonly string[];
}

export interface ScanResultMessage {
  type: 'scanResult';
  sourceVersion: number;
  // Mirrors the order of the request's `strings`. null means "not extractable".
  results: readonly (ExtractedJsonWireFormat | null)[];
}

export interface ExtractedJsonWireFormat {
  text: string;
  blockCount: number;
  preservesComments: boolean;
  proseSegments: number;
  hasComments: boolean;
}

addEventListener('message', (event: MessageEvent<ScanRequest>) => {
  const message = event.data;
  if (!message || message.type !== 'scan') {
    return;
  }

  const results = message.strings.map((value) => {
    try {
      const extracted = extractFromMixedText(value, parseJsonCandidate);
      if (!extracted) return null;
      return {
        text: extracted.text,
        blockCount: extracted.blockCount,
        preservesComments: extracted.preservesComments,
        proseSegments: extracted.proseSegments ?? 0,
        hasComments: extracted.hasComments,
      };
    } catch {
      // Defensive: never let one bad input crash the worker.
      return null;
    }
  });

  const response: ScanResultMessage = {
    type: 'scanResult',
    sourceVersion: message.sourceVersion,
    results,
  };
  postMessage(response);
});

function parseJsonCandidate(candidateText: string): {
  value: unknown;
  errors: readonly ParseError[];
} {
  const errors: ParseError[] = [];
  const value: unknown = parse(candidateText, errors, {
    allowTrailingComma: true,
    disallowComments: false,
  });
  return { value, errors };
}
