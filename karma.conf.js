// Karma configuration for JotJSON.
// Adds a ChromeHeadlessCI launcher (with --no-sandbox) suitable for GitHub
// Actions runners. Angular's default config otherwise applies.

// Inline Karma reporter that echoes Jasmine's random spec-ordering seed so a
// CI flake can be reproduced locally. The seed is delivered as the SECOND arg
// of `onBrowserComplete(browser, result)` -- not on `browser.lastResult` (the
// karma BrowserResult class has no `order` field) and not on `onRunComplete`
// (which receives an aggregate without order). See issue #291.
function SeedReporter(logger) {
  const log = logger.create('reporter.seed');
  this.onBrowserComplete = function (browser, result) {
    // Guard: `result` is undefined on browser disconnect / no-activity
    // timeout (karma/lib/browser.js emits browser_complete with no second
    // arg in those paths). Without this guard we would TypeError exactly
    // when the reporter is most needed.
    const order = result && result.order;
    if (!order || !order.random || order.seed == null) return;
    const seed = String(order.seed);
    log.info(
      `Jasmine ${browser.name}: random order, seed=${seed} ` +
        `(replay key, not a unique run id).\n` +
        `  Replay locally:\n` +
        `    bash/zsh:    JASMINE_SEED=${seed} npm test\n` +
        `    PowerShell:  $env:JASMINE_SEED='${seed}'; npm test`,
    );
    // GitHub Actions workflow command: surfaces the seed in the run summary
    // and as a ::notice:: annotation, durable beyond stdout scroll.
    if (process.env.GITHUB_ACTIONS === 'true') {
      console.log(`::notice title=Jasmine seed::seed=${seed} (browser ${browser.name})`);
    }
  };
}
SeedReporter.$inject = ['logger'];

module.exports = function (config) {
  const isCI = !!process.env.CI;
  const reporters = ['spec', 'kjhtml', 'seed'];
  if (isCI) reporters.push('junit');

  // Optional JASMINE_SEED env-var passthrough for reproducing a specific
  // random spec order locally. Trim+revalidate so JASMINE_SEED="   " is
  // treated as "no seed" rather than handed to Jasmine. Note: today's
  // config is single-browser; multi-browser would need namespacing
  // (e.g., JASMINE_SEED_CHROMEHEADLESS=...) since one env var can't
  // simultaneously reproduce two browsers' independent seeds.
  const rawSeed = process.env.JASMINE_SEED;
  const trimmedSeed = typeof rawSeed === 'string' ? rawSeed.trim() : '';
  const jasmineConfig = { random: true };
  if (trimmedSeed) {
    jasmineConfig.seed = trimmedSeed;
    // Early-startup echo (fires at karma config load, before the browser
    // launches) so the user gets sub-second confirmation that the env
    // var was honored, rather than waiting ~30s for the end-of-run
    // SeedReporter line. Helps catch copy-paste typos quickly.
    console.log(
      `[karma.conf] JASMINE_SEED applied: ${trimmedSeed} (replay key, not a unique run id).`,
    );
  } else if (typeof rawSeed === 'string') {
    // JASMINE_SEED was set but resolved to empty after trim (e.g. "   ",
    // ""). Without this warning the seed is silently dropped and the
    // user believes replay is in effect, only to discover at end-of-run
    // that a fresh random seed was used. Warn loudly so the discrepancy
    // is visible immediately.
    console.warn(
      `[karma.conf] JASMINE_SEED was set but resolved to empty after trim; using random seed.`,
    );
  }

  config.set({
    basePath: '',
    frameworks: ['jasmine', '@angular-devkit/build-angular'],
    plugins: [
      require('karma-jasmine'),
      require('karma-chrome-launcher'),
      require('karma-jasmine-html-reporter'),
      require('karma-spec-reporter'),
      require('karma-junit-reporter'),
      require('karma-coverage'),
      require('@angular-devkit/build-angular/plugins/karma'),
      { 'reporter:seed': ['type', SeedReporter] },
    ],
    client: {
      jasmine: jasmineConfig,
      clearContext: false,
    },
    jasmineHtmlReporter: { suppressAll: true },
    coverageReporter: {
      dir: require('path').join(__dirname, './coverage/jotjson'),
      subdir: '.',
      reporters: [{ type: 'html' }, { type: 'text-summary' }, { type: 'lcovonly' }],
    },
    specReporter: {
      suppressErrorSummary: false,
      suppressFailed: false,
      suppressPassed: false,
      suppressSkipped: true,
      showSpecTiming: false,
      failFast: false,
    },
    junitReporter: {
      outputDir: require('path').join(__dirname, './test-results/web'),
      outputFile: 'junit.xml',
      useBrowserName: false,
      suite: 'web',
    },
    reporters,
    browsers: ['ChromeHeadless'],
    customLaunchers: {
      ChromeHeadlessCI: {
        base: 'ChromeHeadless',
        flags: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
      },
    },
    singleRun: false,
    restartOnFileChange: true,
  });
};
