// Karma configuration for JotJSON.
// Adds a ChromeHeadlessCI launcher (with --no-sandbox) suitable for GitHub
// Actions runners. Angular's default config otherwise applies.
module.exports = function (config) {
  const isCI = !!process.env.CI;
  const reporters = ['spec', 'kjhtml'];
  if (isCI) reporters.push('junit');
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
      require('@angular-devkit/build-angular/plugins/karma')
    ],
    client: {
      jasmine: {},
      clearContext: false
    },
    jasmineHtmlReporter: { suppressAll: true },
    coverageReporter: {
      dir: require('path').join(__dirname, './coverage/jotjson'),
      subdir: '.',
      reporters: [{ type: 'html' }, { type: 'text-summary' }, { type: 'lcovonly' }]
    },
    specReporter: {
      suppressErrorSummary: false,
      suppressFailed: false,
      suppressPassed: false,
      suppressSkipped: true,
      showSpecTiming: false,
      failFast: false
    },
    junitReporter: {
      outputDir: require('path').join(__dirname, './test-results/web'),
      outputFile: 'junit.xml',
      useBrowserName: false,
      suite: 'web'
    },
    reporters,
    browsers: ['ChromeHeadless'],
    customLaunchers: {
      ChromeHeadlessCI: {
        base: 'ChromeHeadless',
        flags: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage']
      }
    },
    singleRun: false,
    restartOnFileChange: true
  });
};
