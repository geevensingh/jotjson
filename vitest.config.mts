/// <reference types="vitest" />
//
// Vitest configuration for JotJSON (issue #47: Karma -> Vitest migration).

import angular from '@analogjs/vite-plugin-angular';
import { playwright } from '@vitest/browser-playwright';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { staticMount } from './scripts/static-mount.mjs';

const projectRoot = fileURLToPath(new URL('.', import.meta.url));

const rawSeed = process.env['JASMINE_SEED'];
const trimmedSeed = typeof rawSeed === 'string' ? rawSeed.trim() : '';
const numericSeed = trimmedSeed ? Number(trimmedSeed) : NaN;
const seedForConfig = Number.isFinite(numericSeed) ? numericSeed : undefined;

if (rawSeed !== undefined && !Number.isFinite(numericSeed)) {
  console.warn(
    `[vitest.config] JASMINE_SEED was set but did not parse as a number; using random seed.`,
  );
}

class SeedReporter {
  onInit(ctx: { config?: { sequence?: { seed?: number } } } | undefined): void {
    const seed = ctx?.config?.sequence?.seed;
    if (seed == null) return;
    const seedStr = String(seed);
    console.log(
      `[reporter.seed] Vitest random order, seed=${seedStr} (replay key).` +
        ` Replay: JASMINE_SEED=${seedStr} npm test`,
    );
    if (process.env['GITHUB_ACTIONS'] === 'true') {
      console.log(`::notice title=Vitest seed::seed=${seedStr} (browser chromium)`);
    }
  }
}

export default defineConfig(() => ({
  plugins: [
    angular(),
    staticMount('/fixtures', join(projectRoot, 'src/testing/fixtures')),
    staticMount('/vs', join(projectRoot, 'node_modules/monaco-editor/min/vs')),
  ],
  test: {
    globals: true,
    setupFiles: ['src/test-setup.ts'],
    include: ['src/**/*.test.ts'],
    exclude: ['src/**/*.perf.ts', 'node_modules/**', 'dist/**'],
    reporters: ['default', ['junit', { suiteName: 'web' }], new SeedReporter()],
    outputFile: { junit: 'test-results/web/junit.xml' },
    coverage: {
      provider: 'v8',
      reportsDirectory: 'coverage/jotjson',
      reporter: ['html', 'text-summary', 'lcovonly'],
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.spec.ts',
        'src/**/*.test.ts',
        'src/**/*.perf.ts',
        'src/**/*.d.ts',
        'src/test-setup.ts',
        'src/main.ts',
        'src/main.server.ts',
        'src/environments/**',
      ],
    },
    sequence: {
      shuffle: true,
      ...(seedForConfig !== undefined ? { seed: seedForConfig } : {}),
    },
    // Karma+Jasmine parity: restore vi.spyOn / vi.stubGlobal / vi.stubEnv
    // before every test, mirroring Jasmine's per-spec sandbox. Without
    // this, spies on document.createElement, Storage.prototype, etc.
    // accumulate across tests in a single file and cause recursive
    // wrapping (e.g., home.component.test.ts onDownload stack overflow).
    restoreMocks: true,
    unstubGlobals: true,
    unstubEnvs: true,
    browser: {
      enabled: true,
      headless: true,
      provider: playwright(),
      instances: [
        {
          browser: 'chromium',
          launch: {
            args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
          },
        },
      ],
    },
    server: {
      deps: {
        inline: ['monaco-editor'],
      },
    },
    optimizeDeps: {
      include: [
        '@angular/localize/init',
        'zone.js',
        'zone.js/testing',
        'zone.js/plugins/proxy',
        'zone.js/plugins/sync-test',
      ],
    },
  },
}));
