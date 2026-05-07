/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: 'src',
  testMatch: ['**/*.test.ts'],
  // Integration tests live under api/integration/ (outside src/) and
  // run via jest.config.integration.js. testPathIgnorePatterns is
  // belt-and-suspenders in case rootDir is ever reconfigured to
  // include integration/.
  testPathIgnorePatterns: ['<rootDir>/../integration/'],
  moduleFileExtensions: ['ts', 'js', 'json'],
  reporters: [
    'default',
    [
      'jest-junit',
      {
        outputDirectory: '<rootDir>/../test-results/api',
        outputName: 'junit.xml',
        suiteName: 'api',
      },
    ],
  ],
};
