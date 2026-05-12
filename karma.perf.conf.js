// Karma configuration for JotJSON Layer-2 perf benches.
//
// Differs from `karma.conf.js` in three ways:
//   1. Picks up `src/**/*.perf.ts` (the regular Karma config EXCLUDES
//      these via tsconfig.spec.json -> we use `tsconfig.perf-l2.json`
//      generated below to flip the include set).
//   2. Adds `--js-flags=--expose-gc` to the Chrome launcher so each
//      perf spec can call `globalThis.gc()` between iterations.
//   3. Per-test timeout 15 minutes (1M-node initial-render fixture and
//      opt-in 100K runs are heavy; both browserNoActivityTimeout and
//      browserDisconnectTimeout extended to match, since the timed
//      work synchronously blocks the browser thread so the Karma
//      socket can't ping back during a long iteration).
//
// Invoked as:
//   npm run perf:l2
//
// Output:
//   perf-results/<utc>/layer-2.jsonl  (the spec writes via console.log
//   sentinel parsed by the wrapper script; see the spec for the
//   `@@PERF_L2@@<json>@@END@@` sentinel format).

module.exports = function (config) {
  config.set({
    basePath: '',
    frameworks: ['jasmine', '@angular-devkit/build-angular'],
    plugins: [
      require('karma-jasmine'),
      require('karma-chrome-launcher'),
      require('karma-jasmine-html-reporter'),
      require('karma-spec-reporter'),
      require('@angular-devkit/build-angular/plugins/karma'),
    ],
    client: {
      jasmine: {
        // Each perf spec runs N=5 iterations. 15 min is generous;
        // 100K renders block synchronously ~50s/iter * 8 iters = ~7m.
        timeoutInterval: 15 * 60 * 1000,
      },
      clearContext: true,
    },
    jasmineHtmlReporter: { suppressAll: true },
    specReporter: {
      suppressErrorSummary: false,
      suppressFailed: false,
      suppressPassed: false,
      suppressSkipped: true,
      showSpecTiming: true,
      failFast: false,
    },
    reporters: ['spec'],
    browsers: ['ChromeHeadlessPerf'],
    customLaunchers: {
      ChromeHeadlessPerf: {
        base: 'ChromeHeadless',
        flags: [
          '--no-sandbox',
          '--disable-gpu',
          '--disable-dev-shm-usage',
          '--js-flags=--expose-gc',
        ],
      },
    },
    singleRun: true,
    restartOnFileChange: false,
    browserDisconnectTimeout: 15 * 60 * 1000,
    browserNoActivityTimeout: 15 * 60 * 1000,
  });
};
