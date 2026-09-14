import { buildAppInsightsConfig } from './app-insights-config';

const CONNECTION_STRING = 'InstrumentationKey=00000000-0000-0000-0000-000000000000';

describe('buildAppInsightsConfig', () => {
  it('passes the connection string through unchanged', () => {
    expect(buildAppInsightsConfig(CONNECTION_STRING).connectionString).toBe(CONNECTION_STRING);
  });

  describe('manual-instrumentation invariant', () => {
    // These are one invariant, not five preferences: the SPA telemetry
    // inventory is manual, so every SDK stream that emits on a timer or on
    // user activity stays off. Ajax tracking is the deliberate exception -
    // it is on for SPA <-> Functions correlation, with error response
    // bodies off.
    it('keeps SDK auto-capture off', () => {
      const config = buildAppInsightsConfig(CONNECTION_STRING);
      expect(config.disableExceptionTracking).toBe(true);
      expect(config.enableAutoRouteTracking).toBe(false);
      expect(config.enableAjaxErrorStatusText).toBe(false);
      expect(config.enableAjaxPerfTracking).toBe(false);
      expect(config.disableCookiesUsage).toBe(true);
    });

    it('keeps ajax tracking on for SPA/Functions correlation', () => {
      const config = buildAppInsightsConfig(CONNECTION_STRING);
      expect(config.disableAjaxTracking).toBe(false);
      expect(config.enableCorsCorrelation).toBe(true);
      expect(config.distributedTracingMode).toBe(2 /* W3C */);
    });
  });

  describe('featureOptIn', () => {
    // Scope of this suite: it guards against the opt-out being REMOVED or
    // weakened. It cannot catch the SDK renaming the `SdkStats` key or
    // renumbering `FeatureOptInMode`, because both sides of the comparison
    // would be our own literals. That drift is covered by
    // `scripts/check-sdk-feature-optin.mjs`, which reads the installed
    // SDK's own default map.
    it('disables SdkStats so the SDK does not emit self-stats to customMetrics', () => {
      const sdkStats = buildAppInsightsConfig(CONNECTION_STRING).featureOptIn?.['SdkStats'];
      expect(sdkStats?.mode).toBe(2 /* FeatureOptInMode.disable */);
    });

    it('blocks CDN config from overriding the SdkStats opt-out', () => {
      // Without this, the SDK's CfgSyncPlugin can apply a Microsoft-hosted
      // config that flips SdkStats back on at runtime with no deploy:
      // `featureOptIn` is not in the plugin's non-overridable set.
      const sdkStats = buildAppInsightsConfig(CONNECTION_STRING).featureOptIn?.['SdkStats'];
      expect(sdkStats?.blockCdnCfg).toBe(true);
    });

    it('declares exactly the feature keys we have decided on', () => {
      // Pins the replace-not-merge side effect: our object replaces the
      // SDK's whole default map, so adding a key here is a deliberate
      // decision that shows up as a diff rather than an accident.
      expect(Object.keys(buildAppInsightsConfig(CONNECTION_STRING).featureOptIn ?? {})).toEqual([
        'SdkStats',
      ]);
    });
  });

  it('returns a fresh object per call so callers cannot mutate shared state', () => {
    const first = buildAppInsightsConfig(CONNECTION_STRING);
    const second = buildAppInsightsConfig(CONNECTION_STRING);
    expect(first).not.toBe(second);
    expect(first.featureOptIn).not.toBe(second.featureOptIn);
  });
});
