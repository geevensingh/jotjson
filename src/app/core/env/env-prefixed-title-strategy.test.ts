import { TestBed } from '@angular/core/testing';
import { Title } from '@angular/platform-browser';
import { Router, RouterStateSnapshot, provideRouter } from '@angular/router';
import { provideStubEnvLabel } from '../../../testing/env.testing';
import { type EnvLabel } from './env-label';
import { EnvPrefixedTitleStrategy } from './env-prefixed-title-strategy';

describe('EnvPrefixedTitleStrategy', () => {
  let strategy: EnvPrefixedTitleStrategy;
  let title: Title;

  function configure(stubLabel: EnvLabel, prNumber: number | null = null): void {
    TestBed.configureTestingModule({
      providers: [
        ...provideStubEnvLabel(stubLabel, prNumber),
        EnvPrefixedTitleStrategy,
        provideRouter([]),
      ],
    });
    strategy = TestBed.inject(EnvPrefixedTitleStrategy);
    title = TestBed.inject(Title);
  }

  afterEach(() => TestBed.resetTestingModule());

  function snapshotWith(title: string | undefined): RouterStateSnapshot {
    return {
      root: {
        firstChild: null,
        data: title === undefined ? {} : { title },
        title,
      },
    } as unknown as RouterStateSnapshot;
  }

  it('sets the unprefixed title on prod', () => {
    configure('prod');
    const router = TestBed.inject(Router);
    const snapshot = router.parseUrl('/blobs');
    // Easier: drive buildTitle by setting Router state -- but mocking the
    // snapshot directly is simpler and matches Angular's TitleStrategy API.
    vi.spyOn(strategy, 'buildTitle').mockReturnValue('Blobs - JotJSON');
    strategy.updateTitle(snapshot as unknown as RouterStateSnapshot);
    expect(title.getTitle()).toBe('Blobs - JotJSON');
  });

  it('prefixes the title on nonprod', () => {
    configure('nonprod');
    vi.spyOn(strategy, 'buildTitle').mockReturnValue('Blobs - JotJSON');
    strategy.updateTitle(snapshotWith('Blobs - JotJSON'));
    expect(title.getTitle()).toBe('[nonprod] Blobs - JotJSON');
  });

  it('prefixes the title with [preview] when on preview without a PR number', () => {
    configure('preview', null);
    vi.spyOn(strategy, 'buildTitle').mockReturnValue('Blobs - JotJSON');
    strategy.updateTitle(snapshotWith('Blobs - JotJSON'));
    expect(title.getTitle()).toBe('[preview] Blobs - JotJSON');
  });

  it('prefixes the title with [pr-<n>] when on preview with a PR number', () => {
    configure('preview', 332);
    vi.spyOn(strategy, 'buildTitle').mockReturnValue('Blobs - JotJSON');
    strategy.updateTitle(snapshotWith('Blobs - JotJSON'));
    expect(title.getTitle()).toBe('[pr-332] Blobs - JotJSON');
  });

  it('leaves the document title untouched when the route declares no title', () => {
    configure('nonprod');
    const initial = title.getTitle();
    vi.spyOn(strategy, 'buildTitle').mockReturnValue(undefined);
    strategy.updateTitle(snapshotWith(undefined));
    expect(title.getTitle()).toBe(initial);
  });
});
