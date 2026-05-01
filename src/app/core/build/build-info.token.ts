import { InjectionToken } from '@angular/core';
import { BUILD_INFO, type BuildInfo } from '../../../generated/build-info';

/**
 * Build metadata generated at build time by `scripts/write-build-info.mjs`.
 * Provided as an InjectionToken so unit tests can supply alternative values
 * without rewriting the generated module.
 */
export const BUILD_INFO_TOKEN = new InjectionToken<BuildInfo>('BUILD_INFO', {
  providedIn: 'root',
  factory: () => BUILD_INFO
});

export type { BuildInfo };
