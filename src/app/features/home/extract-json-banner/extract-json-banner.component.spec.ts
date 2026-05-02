import { TestBed } from '@angular/core/testing';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { ExtractJsonBannerComponent } from './extract-json-banner.component';

describe('ExtractJsonBannerComponent', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [ExtractJsonBannerComponent],
      providers: [provideNoopAnimations()],
    });
  });

  function create(inputs: {
    visible: boolean;
    blockCount: number;
    commentsWillBeDropped: boolean;
  }) {
    const fixture = TestBed.createComponent(ExtractJsonBannerComponent);
    fixture.componentRef.setInput('visible', inputs.visible);
    fixture.componentRef.setInput('blockCount', inputs.blockCount);
    fixture.componentRef.setInput('commentsWillBeDropped', inputs.commentsWillBeDropped);
    fixture.detectChanges();
    return fixture;
  }

  it('renders nothing when visible is false', () => {
    const fixture = create({
      visible: false,
      blockCount: 1,
      commentsWillBeDropped: false,
    });
    const host = fixture.nativeElement as HTMLElement;
    expect(host.querySelector('.banner')).toBeNull();
    expect(host.querySelector('mat-card')).toBeNull();
  });

  it('shows single-block message and Extract JSON action when blockCount is 1', () => {
    const fixture = create({
      visible: true,
      blockCount: 1,
      commentsWillBeDropped: false,
    });
    const host = fixture.nativeElement as HTMLElement;
    const text = host.querySelector('.banner-text')?.textContent ?? '';
    expect(text).toContain('Found JSON inside your paste.');

    const actionButtons = Array.from(
      host.querySelectorAll('.banner-actions button'),
    ) as HTMLButtonElement[];
    const labels = actionButtons.map((b) => (b.textContent ?? '').trim());
    expect(labels.some((label) => label.includes('Extract JSON'))).toBe(true);
    expect(labels.some((label) => label.includes('Extract blocks as array'))).toBe(false);
  });

  it('shows multi-block message and Extract blocks as array action when blockCount >= 2', () => {
    const fixture = create({
      visible: true,
      blockCount: 3,
      commentsWillBeDropped: true,
    });
    const host = fixture.nativeElement as HTMLElement;
    const text = host.querySelector('.banner-text')?.textContent ?? '';
    expect(text).toContain('Found 3 JSON blocks');

    const actionButtons = Array.from(
      host.querySelectorAll('.banner-actions button'),
    ) as HTMLButtonElement[];
    const labels = actionButtons.map((b) => (b.textContent ?? '').trim());
    expect(labels.some((label) => label.includes('Extract blocks as array'))).toBe(true);
    expect(labels.some((label) => label === 'Extract JSON')).toBe(false);
  });

  it('multi-block message no longer contains "Comments will be removed."', () => {
    const fixture = create({
      visible: true,
      blockCount: 3,
      commentsWillBeDropped: true,
    });
    const host = fixture.nativeElement as HTMLElement;
    const text = host.querySelector('.banner-text')?.textContent ?? '';
    expect(text).not.toContain('Comments will be removed.');
  });

  it('does NOT render the comment-status line when commentsWillBeDropped is false', () => {
    const fixture = create({
      visible: true,
      blockCount: 1,
      commentsWillBeDropped: false,
    });
    const host = fixture.nativeElement as HTMLElement;
    expect(host.querySelector('.comment-status'))
      .withContext('comment-status line should be hidden')
      .toBeNull();
    // Both legacy chip variants should be gone entirely.
    expect(host.querySelector('.comments-chip-preserved')).toBeNull();
    expect(host.querySelector('.comments-chip-dropped')).toBeNull();
  });

  it('renders the comment-status line with "Comments will be dropped" when commentsWillBeDropped is true', () => {
    const fixture = create({
      visible: true,
      blockCount: 2,
      commentsWillBeDropped: true,
    });
    const host = fixture.nativeElement as HTMLElement;
    const status = host.querySelector('.comment-status');
    expect(status).withContext('comment-status rendered').not.toBeNull();
    expect((status?.textContent ?? '').trim()).toBe('Comments will be dropped');
    // Legacy chip styles must be absent.
    expect(host.querySelector('.comments-chip-preserved')).toBeNull();
    expect(host.querySelector('.comments-chip-dropped')).toBeNull();
  });

  it('renders the new "extract" icon (not "download") inside the Extract button', () => {
    const fixture = create({
      visible: true,
      blockCount: 1,
      commentsWillBeDropped: false,
    });
    const host = fixture.nativeElement as HTMLElement;
    const extractButton = host.querySelector('.extract-button') as HTMLButtonElement | null;
    expect(extractButton).withContext('extract button rendered').not.toBeNull();
    const icon = extractButton?.querySelector('jj-icon');
    expect(icon).withContext('icon inside extract button').not.toBeNull();

    // Regression guard: a typo in the @switch case key in icon.component
    // would silently render no SVG content. Match a path commitment that
    // is unique to the new extract icon (a top-left corner-bracket
    // stroke that does NOT appear in the old "download" icon).
    const paths = Array.from(icon!.querySelectorAll('path')).map((p) => p.getAttribute('d') ?? '');
    expect(paths.some((d) => d.includes('M5 4v3') && d.includes('M5 4h3')))
      .withContext('extract icon should render top-left corner bracket')
      .toBeTrue();
  });

  it('emits extract exactly once when the Extract button is clicked', () => {
    const fixture = create({
      visible: true,
      blockCount: 1,
      commentsWillBeDropped: false,
    });
    const spy = jasmine.createSpy('extract');
    fixture.componentInstance.extract.subscribe(spy);

    const host = fixture.nativeElement as HTMLElement;
    const extractBtn = host.querySelector('.extract-button') as HTMLButtonElement | null;
    expect(extractBtn).withContext('Extract button rendered').toBeTruthy();
    extractBtn!.click();

    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('emits dismiss exactly once when the Dismiss button is clicked', () => {
    const fixture = create({
      visible: true,
      blockCount: 1,
      commentsWillBeDropped: false,
    });
    const spy = jasmine.createSpy('dismiss');
    fixture.componentInstance.dismiss.subscribe(spy);

    const host = fixture.nativeElement as HTMLElement;
    const buttons = Array.from(
      host.querySelectorAll('.banner-actions button'),
    ) as HTMLButtonElement[];
    const dismissBtn = buttons.find((b) => (b.textContent ?? '').trim() === 'Dismiss');
    expect(dismissBtn).withContext('Dismiss button rendered').toBeTruthy();
    dismissBtn!.click();

    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('emits dismiss when Escape is pressed on the banner', () => {
    const fixture = create({
      visible: true,
      blockCount: 1,
      commentsWillBeDropped: false,
    });
    const spy = jasmine.createSpy('dismiss');
    fixture.componentInstance.dismiss.subscribe(spy);

    const host = fixture.nativeElement as HTMLElement;
    const card = host.querySelector('.banner') as HTMLElement | null;
    expect(card).withContext('banner card rendered').not.toBeNull();
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true });
    card!.dispatchEvent(event);

    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('focusExtractButton() moves focus to the Extract button', () => {
    const fixture = create({
      visible: true,
      blockCount: 1,
      commentsWillBeDropped: false,
    });
    const host = fixture.nativeElement as HTMLElement;
    document.body.appendChild(host);
    try {
      const extractBtn = host.querySelector('.extract-button') as HTMLButtonElement | null;
      expect(extractBtn).withContext('extract button rendered').not.toBeNull();
      expect(document.activeElement).not.toBe(extractBtn);

      fixture.componentInstance.focusExtractButton();

      expect(document.activeElement).toBe(extractBtn);
    } finally {
      host.remove();
    }
  });

  it('focusExtractButton() targets the multi-block Extract button', () => {
    const fixture = create({
      visible: true,
      blockCount: 4,
      commentsWillBeDropped: true,
    });
    const host = fixture.nativeElement as HTMLElement;
    document.body.appendChild(host);
    try {
      const extractBtn = host.querySelector('.extract-button') as HTMLButtonElement | null;
      expect(extractBtn).withContext('extract button rendered').not.toBeNull();
      expect((extractBtn?.textContent ?? '').trim()).toContain('Extract blocks as array');

      fixture.componentInstance.focusExtractButton();

      expect(document.activeElement).toBe(extractBtn);
    } finally {
      host.remove();
    }
  });

  it('focusExtractButton() is a no-op when the banner is hidden', () => {
    const fixture = create({
      visible: false,
      blockCount: 1,
      commentsWillBeDropped: false,
    });
    expect(() => fixture.componentInstance.focusExtractButton()).not.toThrow();
  });
});
