import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { provideFakeAuth } from '../../../testing/auth.testing';
import { NotFoundComponent } from './not-found.component';

describe('NotFoundComponent', () => {
  async function create() {
    TestBed.resetTestingModule();
    await TestBed.configureTestingModule({
      imports: [NotFoundComponent],
      providers: [provideRouter([]), ...provideFakeAuth()],
    }).compileComponents();
    const fixture = TestBed.createComponent(NotFoundComponent);
    fixture.detectChanges();
    return { fixture };
  }

  afterEach(() => {
    // Reset history.state so tests don't leak into each other.
    try {
      history.replaceState(null, '', location.href);
    } catch {
      /* noop */
    }
  });

  it('renders the generic message when no attemptedSlug is in state', async () => {
    const { fixture } = await create();
    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('Page not found');
  });

  it('renders the blob-specific message when history.state has an attemptedSlug', async () => {
    history.replaceState({ attemptedSlug: 'abc123' }, '', location.href);
    const { fixture } = await create();
    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('abc123');
    expect(text).toContain('not found');
  });

  it('adds a robots=noindex meta tag on init', async () => {
    await create();
    const tag = document.head.querySelector('meta[name="robots"]');
    expect(tag?.getAttribute('content')).toBe('noindex');
    tag?.parentElement?.removeChild(tag);
  });

  it('Back-to-editor CTA routes to /', async () => {
    const { fixture } = await create();
    // Angular 20 removed ng-reflect-* attributes; check the href the
    // RouterLink directive populates on the anchor instead.
    const anchor = (fixture.nativeElement as HTMLElement).querySelector(
      'a[routerLink]',
    ) as HTMLAnchorElement | null;
    expect(anchor).toBeTruthy();
    expect(anchor?.getAttribute('href')).toBe('/');
  });
});
