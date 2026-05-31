import { Provider } from '@angular/core';
import { type EnvLabel } from '../app/core/env/env-label';
import { EnvLabelService } from '../app/core/env/env-label.service';

/**
 * Spec-side stub for `EnvLabelService` that lets tests pick a fixed
 * env label (and, for preview, an optional PR number) and exercise
 * the post-bootstrap prefix logic without depending on the test
 * runner's actual hostname.
 *
 * Defaults to `'prod'` / no PR number, which makes `withPrefix(t)`
 * an identity function -- the safe default for the vast majority of
 * specs that assert on titles without caring about env. Specs that
 * DO care (`env-prefixed-title-strategy.spec.ts`, the nonprod
 * home-title coverage) pass an explicit `label` (and, for
 * preview+PR coverage, a `prNumber`).
 *
 * Drop into `TestBed.configureTestingModule`'s `providers` array;
 * mirrors the `provideFakeAuth()` ergonomic.
 *
 * The stub's `withPrefix` mirrors the real service:
 *   - `prod` -> identity.
 *   - `preview` with `prNumber != null` -> `[pr-<n>] ${title}`.
 *   - any other non-prod label (including preview with null prNumber)
 *     -> `[<label>] ${title}`.
 *
 * Keep symmetric with `EnvLabelService.withPrefix` -- if the
 * production rendering changes, this stub MUST change in lockstep
 * or every consumer spec silently false-passes.
 */
export function provideStubEnvLabel(
  label: EnvLabel = 'prod',
  prNumber: number | null = null,
): Provider[] {
  return [{ provide: EnvLabelService, useValue: new StubEnvLabelService(label, prNumber) }];
}

class StubEnvLabelService {
  constructor(
    readonly label: EnvLabel,
    readonly prNumber: number | null = null,
  ) {}

  withPrefix(title: string): string {
    if (this.label === 'preview' && this.prNumber != null) {
      return `[pr-${this.prNumber}] ${title}`;
    }
    if (this.label === 'prod') return title;
    return `[${this.label}] ${title}`;
  }
}
