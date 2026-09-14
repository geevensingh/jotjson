import type { IConfig, IConfiguration } from '@microsoft/applicationinsights-web';

/**
 * The Application Insights SDK configuration, as a pure function of the
 * connection string.
 *
 * This lives in its own module (rather than inline in
 * `telemetry.service.ts`) for two reasons: it is the single source of
 * truth for our SDK posture, and it is assertable in a unit test without
 * instantiating the real SDK -- which would start a sender and its
 * timers under Vitest browser mode.
 *
 * `import type` only. Never add a value import of
 * `@microsoft/applicationinsights-web` here or in `telemetry.service.ts`:
 * the SDK is dynamically imported on first `connect()` so its ~80 kB stays
 * out of `main-*.js`.
 *
 * ## Our posture
 *
 * The SPA telemetry inventory is manual: every SDK stream that emits on a
 * timer or on user activity is off, and the only SDK-originated envelopes
 * we accept are conditional internal diagnostics on the error path (the
 * SDK's `loggingLevelTelemetry` CRITICAL messages). Everything we
 * deliberately emit goes through `LoggerService` and is catalogued in
 * `telemetry-message-ids.ts`. See DESIGN_SPEC "What we collect (SPA)" and
 * `docs/telemetry.md`.
 *
 * ## Why `featureOptIn` replaces rather than merges
 *
 * The SDK's default `featureOptIn` map is a plain object, not a
 * `cfgDfMerge(...)` default (contrast its sibling `sdkStats`), and the
 * dynamic-config layer only deep-merges defaults carrying the merge flag.
 * Our object therefore REPLACES the SDK's whole default map. The four
 * dropped keys are all inert for an npm-installed, connection-string
 * app:
 *
 * - `iKeyUsage`   - default enable; absent falls back to the same `true`.
 * - `CdnUsage`    - default disable; absent falls back to `true`, but the
 *                   message is also gated on the SDK source URL containing
 *                   `az416426` (the CDN snippet). We load from npm.
 * - `SdkLoaderVer`- default disable; absent falls back to `true`, but the
 *                   message is also gated on snippet version < 6, and the
 *                   snippet version is `""` (NaN) for npm initialization.
 * - `zipPayload`  - default mode `none`, which already falls through to
 *                   each call site's own default.
 *
 * Mirroring the full default map instead would trade that known-inert
 * consequence for silent staleness against future SDK defaults. Drift is
 * caught by `scripts/check-sdk-feature-optin.mjs`, which requires an
 * explicit decision here for every key the installed SDK defaults.
 */
export function buildAppInsightsConfig(connectionString: string): IConfiguration & IConfig {
  return {
    connectionString,
    // Manual instrumentation policy (see DESIGN_SPEC Telemetry).
    disableExceptionTracking: true,
    disableAjaxTracking: false,
    enableAutoRouteTracking: false,
    enableAjaxErrorStatusText: false,
    enableAjaxPerfTracking: false,
    disableCookiesUsage: true,
    // Keep correlation between SPA and same-origin Functions.
    enableCorsCorrelation: true,
    distributedTracingMode: 2 /* W3C */,
    featureOptIn: {
      // SdkStats (added in SDK 3.4.3) is opt-OUT: its default mode is
      // `enable`, and omitting the key does not disable it -- the SDK
      // falls back to its own default state, which is on. Left alone it
      // registers a notification listener that reports
      // Item_Success/Dropped/Retry_Count as MetricData through
      // `core.track()`, i.e. onto our connection string and into
      // `customMetrics` -- a table our telemetry inventory does not
      // document and our messageId catalog does not cover.
      //
      // `blockCdnCfg` is load-bearing, not belt-and-braces. The SDK's
      // CfgSyncPlugin polls a Microsoft-hosted config blob by default and
      // may override `featureOptIn`; that map is NOT in the plugin's
      // non-overridable set (only instrumentationKey, connectionString,
      // and endpointUrl are). A published CDN mode of `force-on` would
      // otherwise flip this back to enabled at runtime, with no deploy,
      // because the SDK re-evaluates the flag inside a config-change
      // handler. `blockCdnCfg` makes our value win unconditionally.
      //
      // `2` is a numeric literal on purpose -- do NOT convert it to
      // `FeatureOptInMode.disable`. That enum is not exported from
      // `@microsoft/applicationinsights-web`, `applicationinsights-core-js`
      // is not a declared dependency, and it is an ambient `const enum`,
      // which `isolatedModules: true` forbids importing (TS2748).
      // `distributedTracingMode: 2` above is the same pattern.
      SdkStats: { mode: 2 /* FeatureOptInMode.disable */, blockCdnCfg: true },
    },
  };
}
