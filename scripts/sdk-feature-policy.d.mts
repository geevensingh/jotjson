// Types for `sdk-feature-policy.mjs`.
//
// Hand-written because the repo sets `allowJs: false`, so TypeScript
// cannot infer types from the `.mjs` directly. Kept deliberately small:
// the shape is a flat record, so there is little to drift.

export type SdkFeatureDecision = 'disable' | 'inert-when-dropped';

export interface SdkFeaturePolicyEntry {
  /** The mode the installed SDK defaults this feature to, as a tripwire. */
  readonly sdkDefaultMode: number;
  /** What this repo does about it. */
  readonly decision: SdkFeatureDecision;
  /** Why that decision is correct for this app. */
  readonly rationale: string;
}

export declare const FEATURE_OPT_IN_MODE: Readonly<{
  none: number;
  disable: number;
  enable: number;
}>;

export declare const FEATURE_POLICY: Readonly<Record<string, SdkFeaturePolicyEntry>>;
