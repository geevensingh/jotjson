import { ApplicationRef } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideStubEnvLabel } from '../../../testing/env.testing';
import { provideEnvIndicatorInitializer } from './env-indicator.initializer';
import { type EnvLabel } from './env-label';

interface FaviconLinkSetup {
  ico: HTMLLinkElement;
  svg: HTMLLinkElement;
  apple: HTMLLinkElement;
}

describe('provideEnvIndicatorInitializer', () => {
  let setup: FaviconLinkSetup;

  beforeEach(() => {
    // Remove any pre-existing favicon links from the test page's index.html
    // so the initializer's querySelector matches our test fixtures, not stale
    // links left in the document.
    document
      .querySelectorAll(
        'link[rel="icon"][type="image/x-icon"], link[rel="icon"][type="image/svg+xml"], link[rel="apple-touch-icon"]',
      )
      .forEach((node) => node.remove());

    const ico = document.createElement('link');
    ico.rel = 'icon';
    ico.type = 'image/x-icon';
    ico.href = 'favicon.ico';

    const svg = document.createElement('link');
    svg.rel = 'icon';
    svg.type = 'image/svg+xml';
    svg.href = 'icons/icon.svg';

    const apple = document.createElement('link');
    apple.rel = 'apple-touch-icon';
    apple.href = 'icons/icon-192.png';

    document.head.append(ico, svg, apple);
    setup = { ico, svg, apple };
  });

  afterEach(() => {
    setup.ico.remove();
    setup.svg.remove();
    setup.apple.remove();
    TestBed.resetTestingModule();
  });

  function runInitializerWith(label: EnvLabel): void {
    TestBed.configureTestingModule({
      providers: [...provideStubEnvLabel(label), provideEnvIndicatorInitializer()],
    });
    // Force initializer execution.
    TestBed.inject(ApplicationRef);
  }

  it('leaves favicon hrefs untouched on prod', () => {
    runInitializerWith('prod');
    expect(setup.ico.getAttribute('href')).toBe('favicon.ico');
    expect(setup.svg.getAttribute('href')).toBe('icons/icon.svg');
    expect(setup.apple.getAttribute('href')).toBe('icons/icon-192.png');
  });

  it('rewrites all three favicon hrefs on nonprod', () => {
    runInitializerWith('nonprod');
    expect(setup.ico.getAttribute('href')).toBe('favicon-nonprod.ico');
    expect(setup.svg.getAttribute('href')).toBe('icons/icon-nonprod.svg');
    expect(setup.apple.getAttribute('href')).toBe('icons/icon-nonprod-192.png');
  });

  it('rewrites all three favicon hrefs on preview', () => {
    runInitializerWith('preview');
    expect(setup.ico.getAttribute('href')).toBe('favicon-nonprod.ico');
    expect(setup.svg.getAttribute('href')).toBe('icons/icon-nonprod.svg');
    expect(setup.apple.getAttribute('href')).toBe('icons/icon-nonprod-192.png');
  });

  it('rewrites all three favicon hrefs on dev', () => {
    runInitializerWith('dev');
    expect(setup.ico.getAttribute('href')).toBe('favicon-nonprod.ico');
    expect(setup.svg.getAttribute('href')).toBe('icons/icon-nonprod.svg');
    expect(setup.apple.getAttribute('href')).toBe('icons/icon-nonprod-192.png');
  });

  it('rewrites all three favicon hrefs on unknown (fail-noisy)', () => {
    runInitializerWith('unknown');
    expect(setup.ico.getAttribute('href')).toBe('favicon-nonprod.ico');
    expect(setup.svg.getAttribute('href')).toBe('icons/icon-nonprod.svg');
    expect(setup.apple.getAttribute('href')).toBe('icons/icon-nonprod-192.png');
  });
});
