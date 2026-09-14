import { FEATURE_POLICY } from '../../../../scripts/sdk-feature-policy.mjs';
import { buildAppInsightsConfig } from './app-insights-config';

const CONNECTION_STRING = 'InstrumentationKey=00000000-0000-0000-0000-000000000000';

describe('buildAppInsightsConfig', () => {
  it('passes the connection string through unchanged', () => {
    expect(buildAppInsightsConfig(CONNECTION_STRING).connectionString).toBe(CONNECTION_STRING);
  });

  describe('SDK auto-emitters this function turns off', () => {
    // Scoped to what this function configures. Deliberately NOT a claim
    // that these are the only SDK-originated streams -- the SDK also
    // emits auto-instrumented dependencies (on by choice, below), a
    // browser perf-timing sidecar, and CRITICAL internal diagnostics.
    // See docs/telemetry.md for the inventory of what actually arrives.
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
    // Scope of this suite: it guards the opt-out against removal or
    // weakening, by value, on the real object. It cannot catch the SDK
    // renaming the `SdkStats` key or renumbering `FeatureOptInMode` --
    // both sides would be our own literals. That drift is covered by
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

    it('declares every feature that policy classifies as disable', () => {
      // The cross-artifact link. `scripts/check-sdk-feature-optin.mjs`
      // owns the vendor side (what the SDK defaults); this owns our side
      // (what we actually declare), because it can execute the config
      // instead of re-parsing its syntax. Both read one FEATURE_POLICY,
      // so classifying a new feature as `disable` without declaring it
      // here fails the suite.
      const featureOptIn = buildAppInsightsConfig(CONNECTION_STRING).featureOptIn ?? {};
      const shouldDisable = Object.entries(FEATURE_POLICY)
        .filter(([, entry]) => entry.decision === 'disable')
        .map(([name]) => name);
      expect(shouldDisable.length).toBeGreaterThan(0);
      for (const name of shouldDisable) {
        expect(featureOptIn[name]?.mode).toBe(2 /* FeatureOptInMode.disable */);
      }
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
