import { TestBed } from '@angular/core/testing';
import { Title } from '@angular/platform-browser';
import { Router, RouterStateSnapshot, provideRouter } from '@angular/router';
import { EnvLabelService } from './env-label.service';
import { EnvPrefixedTitleStrategy } from './env-prefixed-title-strategy';

describe('EnvPrefixedTitleStrategy', () => {
  let strategy: EnvPrefixedTitleStrategy;
  let title: Title;

  function configure(stubLabel: 'prod' | 'nonprod'): void {
    const stub = {
      label: stubLabel,
      withPrefix: (text: string) => (stubLabel === 'prod' ? text : `[${stubLabel}] ${text}`),
    };
    TestBed.configureTestingModule({
      providers: [
        { provide: EnvLabelService, useValue: stub },
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
    spyOn(strategy, 'buildTitle').and.returnValue('Blobs - JotJSON');
    strategy.updateTitle(snapshot as unknown as RouterStateSnapshot);
    expect(title.getTitle()).toBe('Blobs - JotJSON');
  });

  it('prefixes the title on nonprod', () => {
    configure('nonprod');
    spyOn(strategy, 'buildTitle').and.returnValue('Blobs - JotJSON');
    strategy.updateTitle(snapshotWith('Blobs - JotJSON'));
    expect(title.getTitle()).toBe('[nonprod] Blobs - JotJSON');
  });

  it('leaves the document title untouched when the route declares no title', () => {
    configure('nonprod');
    const initial = title.getTitle();
    spyOn(strategy, 'buildTitle').and.returnValue(undefined);
    strategy.updateTitle(snapshotWith(undefined));
    expect(title.getTitle()).toBe(initial);
  });
});
