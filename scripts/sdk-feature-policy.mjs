// Policy data for the Application Insights SDK feature-flag gate.
//
// This module is DATA ONLY and deliberately imports nothing -- in
// particular nothing from `node:`. It is consumed by two runtimes:
//
//   - `scripts/check-sdk-feature-optin.mjs` (Node), which compares it
//     against the SDK's own default `featureOptIn` map, and
//   - `src/app/core/telemetry/app-insights-config.test.ts` (Vitest
//     BROWSER mode, chromium), which asserts that every feature
//     classified `disable` here is actually opted out in the real
//     object returned by `buildAppInsightsConfig`.
//
// That split is the point. The gate owns the vendor side (what the SDK
// defaults), the unit test owns our side (what our config declares) --
// because the test can *execute* the TypeScript, while a lint script
// could only re-parse its syntax. A previous revision of the gate tried
// the latter and shipped a check that could not fail: it tested
// `configSource.includes('SdkStats')` against a file whose own doc
// comment names `SdkStats` nine times.
//
// A sibling `sdk-feature-policy.d.mts` types this module for the
// TypeScript consumer (the repo sets `allowJs: false`).

/**
 * `FeatureOptInMode`, mirrored from the SDK's ambient const enum.
 *
 * Mirrored rather than imported: it is not exported from
 * `@microsoft/applicationinsights-web`, `applicationinsights-core-js`
 * is not a declared dependency, and it is an ambient `const enum`,
 * which `isolatedModules: true` forbids importing (TS2748).
 */
export const FEATURE_OPT_IN_MODE = Object.freeze({
  none: 1,
  disable: 2,
  enable: 3,
});

/**
 * Every feature key the installed SDK carries in its default
 * `featureOptIn` map needs an entry here.
 *
 * `sdkDefaultMode` records what the SDK defaults TODAY. It is not a
 * preference -- it is a tripwire. When the SDK changes a default, the
 * gate fails and a human decides whether the new default is acceptable.
 *
 * `decision` is what WE do about it:
 *   'disable'            - we explicitly opt out in
 *                          `app-insights-config.ts`. The unit test
 *                          asserts the opt-out is present, by value.
 *   'inert-when-dropped' - we do not name it. Because our `featureOptIn`
 *                          object REPLACES the SDK's default map rather
 *                          than merging into it, dropping the key means
 *                          each call site falls back to its own default
 *                          state. `rationale` must say why that is
 *                          harmless for this app.
 */
export const FEATURE_POLICY = Object.freeze({
  SdkStats: {
    sdkDefaultMode: FEATURE_OPT_IN_MODE.enable,
    decision: 'disable',
    rationale:
      'Emits Item_Success/Dropped/Retry_Count as MetricData via core.track() on our own ' +
      'connection string, into customMetrics -- uncatalogued, and outside LoggerService and ' +
      'the frozen messageId union. Our telemetry inventory is manual-only.',
  },
  iKeyUsage: {
    sdkDefaultMode: FEATURE_OPT_IN_MODE.enable,
    decision: 'inert-when-dropped',
    rationale:
      'Gates an instrumentation-key deprecation message. Dropping the key falls back to the ' +
      'same enabled state, and the message is additionally gated on there being no ' +
      'connectionString. We always configure a connection string, so it never fires.',
  },
  CdnUsage: {
    sdkDefaultMode: FEATURE_OPT_IN_MODE.disable,
    decision: 'inert-when-dropped',
    rationale:
      'Gates a CDN deprecation message. Dropping the key falls back to enabled, but the ' +
      'message is additionally gated on the SDK source URL containing az416426 (the CDN ' +
      'snippet). We load the SDK from npm, so it never fires.',
  },
  SdkLoaderVer: {
    sdkDefaultMode: FEATURE_OPT_IN_MODE.disable,
    decision: 'inert-when-dropped',
    rationale:
      'Gates a snippet-loader upgrade message. Dropping the key falls back to enabled, but ' +
      'the message is additionally gated on snippet version < 6, and the snippet version is ' +
      'empty (NaN) for npm initialization. It never fires.',
  },
  zipPayload: {
    sdkDefaultMode: FEATURE_OPT_IN_MODE.none,
    decision: 'inert-when-dropped',
    rationale:
      'Defaults to mode `none`, which already falls through to each call site default, so ' +
      'dropping the key changes nothing.',
  },
});
