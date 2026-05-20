import { PLATFORM_ID } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { EnvLabel } from './env-label';
import { EnvLabelService } from './env-label.service';

describe('EnvLabelService', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('returns "prod" on the server platform without touching window', () => {
    TestBed.configureTestingModule({
      providers: [{ provide: PLATFORM_ID, useValue: 'server' }],
    });
    const service = TestBed.inject(EnvLabelService);
    expect(service.label).toBe('prod');
    expect(service.prNumber).toBeNull();
    expect(service.withPrefix('Blobs - JotJSON')).toBe('Blobs - JotJSON');
  });

  it('classifies the Karma test host ("localhost") as "dev" in the browser platform', () => {
    TestBed.configureTestingModule({});
    const service = TestBed.inject(EnvLabelService);
    expect(service.label).toBe('dev');
    // Karma serves on localhost; not a preview host -> no PR number.
    expect(service.prNumber).toBeNull();
  });

  it('withPrefix is identity on prod', () => {
    TestBed.configureTestingModule({
      providers: [{ provide: PLATFORM_ID, useValue: 'server' }],
    });
    const service = TestBed.inject(EnvLabelService);
    expect(service.withPrefix('JotJSON')).toBe('JotJSON');
  });

  it('withPrefix prepends localized prefix when not on prod', () => {
    TestBed.configureTestingModule({});
    const service = TestBed.inject(EnvLabelService);
    expect(service.withPrefix('Blobs - JotJSON')).toBe('[dev] Blobs - JotJSON');
  });

  // Direct coverage of the `[pr-<n>]` branch on the real service.
  // Karma serves on localhost, so the construction-time classification
  // yields `label === 'dev'` / `prNumber === null`. Force-set the
  // readonly fields (TS-only modifier; the runtime allows assignment)
  // via the same `as unknown as { fieldName: type }` pattern used in
  // `src/testing/auth.testing.ts` and several other spec files. This
  // avoids relying on `provideStubEnvLabel` -- the stub independently
  // encodes the rendering and could silently false-pass on drift.
  //
  // ASSUMPTION: `withPrefix` recomputes the prefix from
  // `this.label` / `this.prNumber` on each call. If a future refactor
  // memoizes the prefix at construction (e.g., a private
  // `cachedPrefix` field), these force-sets would not propagate and
  // the test would silently false-pass against the post-construction
  // values. If you add such a cache, also expose a
  // `__resetForTesting()` seam per AGENTS.md Sec 4 and call it after
  // the force-set.
  describe('withPrefix on preview hosts with a PR number', () => {
    it('renders [pr-<n>] when label === "preview" and prNumber is a positive integer', () => {
      TestBed.configureTestingModule({});
      const service = TestBed.inject(EnvLabelService);
      (service as unknown as { label: EnvLabel; prNumber: number | null }).label = 'preview';
      (service as unknown as { label: EnvLabel; prNumber: number | null }).prNumber = 332;
      expect(service.withPrefix('Blobs - JotJSON')).toBe('[pr-332] Blobs - JotJSON');
    });

    it('falls back to [preview] when label === "preview" but prNumber is null', () => {
      TestBed.configureTestingModule({});
      const service = TestBed.inject(EnvLabelService);
      (service as unknown as { label: EnvLabel; prNumber: number | null }).label = 'preview';
      (service as unknown as { label: EnvLabel; prNumber: number | null }).prNumber = null;
      expect(service.withPrefix('Blobs - JotJSON')).toBe('[preview] Blobs - JotJSON');
    });
  });
});
