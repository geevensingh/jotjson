import { TestBed } from '@angular/core/testing';
import type * as MonacoNS from 'monaco-editor';

import { LoggerService } from '../../../core/telemetry/logger.service';
import { provideFakeAuth } from '../../../../testing/auth.testing';
import { contrastRatio, AA_THRESHOLD } from '../../utils/contrast';
import { JsonEditorComponent } from './json-editor.component';
import { __resetMonacoLoaderForTesting, __setMonacoLoaderPromiseForTesting } from './monaco-loader';

/**
 * Regression spec for #145 -- the lazy-load placeholder
 * `<div class="editor-loading">Loading editor...</div>` rendered by
 * `JsonEditorComponent` while Monaco is fetching must meet WCAG 2.1 AA
 * contrast (>=4.5:1) against the host background in BOTH themes.
 *
 * Why a Karma spec and not e2e: the placeholder is visible only during
 * the brief Monaco lazy-load window (~50-200ms), and `theme-cycle.spec.ts`
 * (the only e2e that ends in dark mode) explicitly waits for the
 * `.monaco-editor` to mount before running axe -- a deliberate
 * "DOM has settled" gate per `e2e/util/a11y.ts:124`. So the e2e suite
 * cannot reliably catch this. This spec asserts the contract directly
 * on the rendered placeholder using `getComputedStyle()`, which is
 * deterministic and runs in milliseconds.
 *
 * The spec pins `loadMonaco()` to a never-resolving promise so
 * `ready()` stays `false` and the placeholder stays in the DOM for the
 * duration of the test.
 */

interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

const RGB_NUMBER = '\\s*([0-9]+(?:\\.[0-9]+)?)\\s*';
const RGB_PATTERN = new RegExp(
  `^rgba?\\(${RGB_NUMBER}[,\\s]${RGB_NUMBER}[,\\s]${RGB_NUMBER}(?:[,\\/]${RGB_NUMBER})?\\)$`,
);

function parseRgb(value: string): Rgba {
  const match = RGB_PATTERN.exec(value.trim());
  if (!match) {
    throw new Error(`expected rgb()/rgba() value, got "${value}"`);
  }
  return {
    r: Number(match[1]),
    g: Number(match[2]),
    b: Number(match[3]),
    a: match[4] !== undefined ? Number(match[4]) : 1,
  };
}

function toHex(channel: number): string {
  const clamped = Math.max(0, Math.min(255, Math.round(channel)));
  return clamped.toString(16).padStart(2, '0');
}

function rgbToHex(rgba: Rgba): string {
  return `#${toHex(rgba.r)}${toHex(rgba.g)}${toHex(rgba.b)}`;
}

/**
 * Alpha-flatten `foreground` over `background`. Equivalent to what the
 * browser shows the user (and what axe-core uses for its `color-contrast`
 * rule).
 */
function flattenOver(foreground: Rgba, background: Rgba): Rgba {
  const alpha = foreground.a;
  return {
    r: foreground.r * alpha + background.r * (1 - alpha),
    g: foreground.g * alpha + background.g * (1 - alpha),
    b: foreground.b * alpha + background.b * (1 - alpha),
    a: 1,
  };
}

describe('JsonEditorComponent .editor-loading placeholder contrast (#145)', () => {
  let originalThemeClasses: string[];
  let originalStorageValue: string | null;
  let suspended: Promise<typeof MonacoNS>;
  let suspendedReject!: (reason: Error) => void;

  const STORAGE_KEY = 'jotjson.preferences.v1';

  beforeEach(async () => {
    // Snapshot whatever theme classes were on body so we can restore them.
    // Other specs (notably PreferencesService specs and any spec that
    // mounts a fixture via `attachFixtureToBody`) leave stray classes
    // that would couple this spec to suite ordering.
    originalThemeClasses = Array.from(document.body.classList).filter((cls) =>
      cls.startsWith('theme-'),
    );
    document.body.classList.remove('theme-dark', 'theme-light', 'theme-system');

    // PreferencesService runs an `effect()` that writes the body class
    // based on its own theme signal. If we just `classList.add('theme-X')`,
    // the service's effect overwrites it on the next change-detection
    // cycle (default theme is 'system', which resolves to 'light' on
    // CI Linux Chromium). Seed the persisted preference so the service
    // initializes to the theme we want; the per-test `it` block sets
    // the matching `theme.value` below before mounting the fixture.
    originalStorageValue = localStorage.getItem(STORAGE_KEY);

    // Pin loadMonaco to a never-resolving promise so `ready()` stays
    // `false` and `.editor-loading` stays in the DOM. Held in a local
    // so afterEach can reject it for cleanup; rejecting prevents Zone.js
    // from logging an unhandled-rejection warning when the test ends.
    suspended = new Promise<typeof MonacoNS>((_, reject) => {
      suspendedReject = reject;
    });
    suspended.catch(() => {
      /* swallow; rejection is the cleanup signal */
    });
    __setMonacoLoaderPromiseForTesting(suspended);
  });

  afterEach(() => {
    suspendedReject(new Error('test ended; suspended Monaco loader cleaned up'));
    __resetMonacoLoaderForTesting();
    if (originalStorageValue === null) {
      localStorage.removeItem(STORAGE_KEY);
    } else {
      localStorage.setItem(STORAGE_KEY, originalStorageValue);
    }
    document.body.classList.remove('theme-dark', 'theme-light', 'theme-system');
    if (originalThemeClasses.length > 0) {
      document.body.classList.add(...originalThemeClasses);
    }
  });

  for (const { theme, prefValue } of [
    { theme: 'theme-dark', prefValue: 'dark' },
    { theme: 'theme-light', prefValue: 'light' },
  ] as const) {
    it(`Loading editor... text meets WCAG AA contrast in ${theme}`, async () => {
      // Seed the stored preference BEFORE TestBed.configureTestingModule
      // runs PreferencesService's constructor (which reads localStorage
      // synchronously). The service's body-class effect then writes
      // `theme-${prefValue}` onto body, which is what we want to test.
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ theme: prefValue }));

      await TestBed.configureTestingModule({
        imports: [JsonEditorComponent],
        providers: [
          ...provideFakeAuth(),
          {
            provide: LoggerService,
            useValue: jasmine.createSpyObj<LoggerService>('LoggerService', ['error', 'event']),
          },
        ],
      }).compileComponents();

      const fixture = TestBed.createComponent(JsonEditorComponent);
      fixture.componentRef.setInput('value', '{"a":1}');
      // Mount in the live document so `getComputedStyle` resolves global
      // tokens (`--bg`, `--mat-sys-on-surface-variant`) inherited from
      // `<html>` / `body`.
      document.body.appendChild(fixture.nativeElement);
      fixture.detectChanges();

      // Sanity-check that the body-class effect ran. The expected class
      // is set by PreferencesService's effect on the first change-
      // detection cycle.
      expect(document.body.classList.contains(theme))
        .withContext(
          `expected body to have ${theme} after PreferencesService's effect runs (got "${document.body.className}")`,
        )
        .toBeTrue();

      const host = fixture.nativeElement as HTMLElement;
      const placeholder = host.querySelector<HTMLElement>('.editor-loading');
      expect(placeholder)
        .withContext('placeholder must be in the DOM while ready()=false')
        .not.toBeNull();
      // Type-narrow.
      if (!placeholder) {
        fixture.destroy();
        return;
      }

      const bgRgba = parseRgb(getComputedStyle(host).backgroundColor);
      // Background must be opaque for contrast math to be meaningful.
      // The `:host` rule sets `background: var(--bg)`, which resolves to
      // a solid hex (`#1e1e1e` / `#fafafa`) per `_theme.scss`.
      expect(bgRgba.a).withContext('host background must be opaque').toBe(1);

      const fgRgba = parseRgb(getComputedStyle(placeholder).color);
      const effectiveFg = flattenOver(fgRgba, bgRgba);

      const fgHex = rgbToHex(effectiveFg);
      const bgHex = rgbToHex(bgRgba);
      const ratio = contrastRatio(fgHex, bgHex);

      expect(ratio)
        .withContext(
          `${theme}: effective fg ${fgHex} on bg ${bgHex} = ${ratio.toFixed(2)}:1, AA needs ${AA_THRESHOLD}:1`,
        )
        .toBeGreaterThanOrEqual(AA_THRESHOLD);

      fixture.destroy();
    });
  }
});
