/// <reference lib="webworker" />

import { parse, ParseError } from 'jsonc-parser';
import type { IndentSize } from './json-extractor.core';
import { extractFromMixedText } from './json-extractor.core';

// Message shapes - keep these in sync with the service.
export interface ScanRequest {
  type: 'scan';
  // Identifies the parse generation; service drops responses for stale versions.
  sourceVersion: number;
  // Per-chunk identifier assigned by the service. The worker echoes it
  // unchanged in the response so the service can associate the result
  // with the exact in-flight chunk (issue #289 PR review): if a tabSize
  // flip mid-generation deletes a chunk and reposts a fresh one at the
  // same sourceVersion, the OLD response's chunkId is no longer tracked
  // and the response is dropped, instead of being misassociated with
  // the NEW chunk and poisoning the cache.
  chunkId: number;
  // Indent size to use when formatting extracted JSON output (2 | 4).
  // Captured at chunk-dispatch time by the service so that a tabSize
  // change between dispatch and response cannot cause stale cache
  // entries.
  tabSize: IndentSize;
  // Strings to scan. The service is responsible for de-duping before sending,
  // for size pre-screening, and for the {/[ pre-screen.
  strings: readonly string[];
}

export interface ScanResultMessage {
  type: 'scanResult';
  sourceVersion: number;
  // Echoes ScanRequest.chunkId so the service can look up the exact
  // pending chunk this response belongs to. See ScanRequest.chunkId.
  chunkId: number;
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
      // A missing/invalid tabSize is a wire-format skew bug (older queued
      // worker request crossing a reload boundary, or a code-side type
      // violation). Fail loudly per AGENTS.md "never swallow errors" --
      // the surrounding try/catch turns this into a null result for that
      // input, which the service treats as "not extractable". That is far
      // better than silently producing 2-space indent under a user's
      // 4-space preference (issue #253).
      if (message.tabSize !== 2 && message.tabSize !== 4) {
        throw new Error(`json-extractor.worker: invalid tabSize ${String(message.tabSize)}`);
      }
      // chunkId must be a finite integer; the service relies on it as a
      // Map key to associate this response with the right pending chunk
      // (PR #289 review). Fail loudly via the surrounding try/catch on
      // any wire-format skew rather than silently emitting a response
      // the service cannot route.
      if (typeof message.chunkId !== 'number' || !Number.isInteger(message.chunkId)) {
        throw new Error(`json-extractor.worker: invalid chunkId ${String(message.chunkId)}`);
      }
      const extracted = extractFromMixedText(value, parseJsonCandidate, message.tabSize);
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
    chunkId: message.chunkId,
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
