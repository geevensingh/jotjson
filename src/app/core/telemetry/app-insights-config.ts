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
 * ## What this function does and does not claim
 *
 * Scoped deliberately: this function turns off the SDK auto-emitters
 * listed below, and says nothing about SDK behavior it does not
 * configure. Three previous revisions of this comment asserted a
 * universal ("the only SDK-originated envelopes we accept are ...") and
 * each was falsified by a stream the author had not enumerated --
 * auto-instrumented dependencies, the browser perf-timing sidecar, the
 * CfgSync config poll. A universal quantifier over a vendor's
 * auto-behavior has no owner and no detection mechanism: it goes stale
 * on the dependency's release cadence while living in our source.
 *
 * The emitters this function turns off: auto exception capture
 * (`disableExceptionTracking`), auto route tracking
 * (`enableAutoRouteTracking`), ajax error response bodies
 * (`enableAjaxErrorStatusText`), ajax perf tracking
 * (`enableAjaxPerfTracking`), cookies (`disableCookiesUsage`), and
 * SdkStats (`featureOptIn`). Ajax tracking itself is deliberately left
 * ON for SPA <-> Functions correlation.
 *
 * `docs/telemetry.md` -> "Tables populated by jotjson" is the inventory
 * of what actually reaches our resource, and is the place to look for
 * the full picture.
 *
 * ## Why `featureOptIn` replaces rather than merges
 *
 * The SDK's default `featureOptIn` map is a plain object, not a
 * `cfgDfMerge(...)` default (contrast its sibling `sdkStats`), and the
 * dynamic-config layer only deep-merges defaults carrying the merge flag.
 * Our object therefore REPLACES the SDK's whole default map. The four
 * dropped keys are all inert for an npm-installed, connection-string
 * app; `scripts/sdk-feature-policy.mjs` records the reasoning per key,
 * and `scripts/check-sdk-feature-optin.mjs` fails the build if the
 * installed SDK ever defaults a key that policy does not classify.
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
      // Scope note: `blockCdnCfg` is per-FEATURE. It pins this value
      // against CDN override; it does NOT stop the poll itself, which is
      // a plugin-level setting we do not set
      // (`extensionConfig.AppInsightsCfgSyncPlugin.blkCdnCfg`). The poll
      // is documented in docs/telemetry.md; changing that posture is
      // tracked separately.
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
