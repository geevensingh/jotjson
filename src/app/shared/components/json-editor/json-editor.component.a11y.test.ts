import { TestBed } from '@angular/core/testing';
import type * as MonacoNS from 'monaco-editor';

import { type Mocked } from 'vitest';
import { provideFakeAuth } from '../../../../testing/auth.testing';
import { LoggerService } from '../../../core/telemetry/logger.service';
import { AA_THRESHOLD, contrastRatio } from '../../utils/contrast';
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
  // Full body-state snapshot. PreferencesService writes both classes
  // (`theme-{dark|light|system}`) and inline `--highlight-*` properties
  // on `body.style`. If we don't restore both, downstream specs that scan
  // for contrast (e.g. `JsonBreadcrumbComponent (a11y)`) get confused
  // about the page background and axe-core walks up to the test-runner
  // reporter chrome for its background fallback, producing false-positive
  // `color-contrast` violations whose colors are NEITHER theme's tokens.
  let originalClassName: string;
  let originalStyleCssText: string;
  let originalStorageValue: string | null;
  let testWrapper: HTMLDivElement | null = null;
  let suspended: Promise<typeof MonacoNS>;
  let suspendedReject!: (reason: Error) => void;

  const STORAGE_KEY = 'jotjson.preferences.v1';

  beforeEach(() => {
    // Snapshot whatever body state was there. Other specs (notably
    // PreferencesService specs and any spec that mounts a fixture via
    // `attachFixtureToBody`) leave stray classes / inline custom
    // properties; we restore exactly what was there on the way out.
    originalClassName = document.body.className;
    originalStyleCssText = document.body.style.cssText;
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
    // Reset the test module FIRST so PreferencesService is destroyed
    // before we restore body state. Otherwise its body-class effect can
    // fire one more time during teardown and re-mutate body.
    TestBed.resetTestingModule();

    // Remove our wrapper (and the fixture host inside it). Use the
    // marked wrapper so we never accidentally remove someone else's
    // fixture if specs interleave.
    if (testWrapper && testWrapper.parentNode) {
      testWrapper.parentNode.removeChild(testWrapper);
    }
    testWrapper = null;

    suspendedReject(new Error('test ended; suspended Monaco loader cleaned up'));
    __resetMonacoLoaderForTesting();

    if (originalStorageValue === null) {
      localStorage.removeItem(STORAGE_KEY);
    } else {
      localStorage.setItem(STORAGE_KEY, originalStorageValue);
    }

    // Restore both body className and inline style. PreferencesService's
    // effect sets `body.style['--highlight-*']` properties; if we only
    // restore the className, those custom properties bleed into
    // subsequent specs.
    document.body.className = originalClassName;
    document.body.style.cssText = originalStyleCssText;
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
            useValue: { error: vi.fn(), event: vi.fn() } as unknown as Mocked<LoggerService>,
          },
        ],
      }).compileComponents();

      const fixture = TestBed.createComponent(JsonEditorComponent);
      fixture.componentRef.setInput('value', '{"a":1}');

      // Mount in a marked wrapper so afterEach can find and remove it
      // even if `fixture.destroy()` runs first (or fails). Mounting in
      // the live document is required so `getComputedStyle` resolves
      // global tokens (`--bg`, `--mat-sys-on-surface-variant`) inherited
      // from `<html>` / `body`.
      testWrapper = document.createElement('div');
      testWrapper.setAttribute('data-jj-145-fixture', '');
      testWrapper.appendChild(fixture.nativeElement);
      document.body.appendChild(testWrapper);
      fixture.detectChanges();

      // Sanity-check that the body-class effect ran. The expected class
      // is set by PreferencesService's effect on the first change-
      // detection cycle.
      expect(
        document.body.classList.contains(theme),
        `expected body to have ${theme} after PreferencesService's effect runs (got "${document.body.className}")`,
      ).toBe(true);

      const host = fixture.nativeElement as HTMLElement;
      const placeholder = host.querySelector<HTMLElement>('.editor-loading');
      expect(placeholder, 'placeholder must be in the DOM while ready()=false').not.toBeNull();
      // Type-narrow.
      if (!placeholder) {
        fixture.destroy();
        return;
      }

      const bgRgba = parseRgb(getComputedStyle(host).backgroundColor);
      // Background must be opaque for contrast math to be meaningful.
      // The `:host` rule sets `background: var(--bg)`, which resolves to
      // a solid hex (`#1e1e1e` / `#fafafa`) per `_theme.scss`.
      expect(bgRgba.a, 'host background must be opaque').toBe(1);

      const fgRgba = parseRgb(getComputedStyle(placeholder).color);
      const effectiveFg = flattenOver(fgRgba, bgRgba);

      const fgHex = rgbToHex(effectiveFg);
      const bgHex = rgbToHex(bgRgba);
      const ratio = contrastRatio(fgHex, bgHex);

      expect(
        ratio,
        `${theme}: effective fg ${fgHex} on bg ${bgHex} = ${ratio.toFixed(2)}:1, AA needs ${AA_THRESHOLD}:1`,
      ).toBeGreaterThanOrEqual(AA_THRESHOLD);

      fixture.destroy();
    });
  }
});
