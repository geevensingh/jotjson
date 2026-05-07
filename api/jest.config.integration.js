/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: '.',
  testMatch: ['<rootDir>/integration/**/*.integration.test.ts'],
  testTimeout: 60_000,
  // Single-worker for the initial slice: removes inter-test contention
  // on the shared per-run container. Revisit when the integration
  // suite grows enough to justify parallelism.
  maxWorkers: 1,
  globalSetup: '<rootDir>/integration/global-setup.ts',
  globalTeardown: '<rootDir>/integration/global-teardown.ts',
  setupFiles: ['<rootDir>/integration/setup-env.ts'],
  moduleFileExtensions: ['ts', 'js', 'json'],
  reporters: [
    'default',
    [
      'jest-junit',
      {
        outputDirectory: '<rootDir>/test-results/api-integration',
        outputName: 'junit.xml',
        suiteName: 'api-integration',
      },
    ],
  ],
};
