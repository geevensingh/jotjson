import { Provider } from '@angular/core';
import { type EnvLabel } from '../app/core/env/env-label';
import { EnvLabelService } from '../app/core/env/env-label.service';

/**
 * Spec-side stub for `EnvLabelService` that lets tests pick a fixed
 * env label and exercise the post-bootstrap prefix logic without
 * depending on the Karma server's actual hostname.
 *
 * Defaults to `'prod'`, which makes `withPrefix(t)` an identity
 * function -- the safe default for the vast majority of specs that
 * assert on titles without caring about env. Specs that DO care
 * (`env-prefixed-title-strategy.spec.ts`, the nonprod home-title
 * coverage) pass an explicit `label`.
 *
 * Drop into `TestBed.configureTestingModule`'s `providers` array;
 * mirrors the `provideFakeAuth()` ergonomic.
 */
export function provideStubEnvLabel(label: EnvLabel = 'prod'): Provider[] {
  return [{ provide: EnvLabelService, useValue: new StubEnvLabelService(label) }];
}

class StubEnvLabelService {
  constructor(readonly label: EnvLabel) {}

  withPrefix(title: string): string {
    if (this.label === 'prod') return title;
    return `[${this.label}] ${title}`;
  }
}
