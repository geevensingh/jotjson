import { TestBed } from '@angular/core/testing';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { UploadErrorBannerComponent } from './upload-error-banner.component';

describe('UploadErrorBannerComponent', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [UploadErrorBannerComponent],
      providers: [provideNoopAnimations()]
    });
  });

  function create(inputs: { visible: boolean; filename: string }) {
    const fixture = TestBed.createComponent(UploadErrorBannerComponent);
    fixture.componentRef.setInput('visible', inputs.visible);
    fixture.componentRef.setInput('filename', inputs.filename);
    fixture.detectChanges();
    return fixture;
  }

  it('renders nothing when visible is false', () => {
    const fixture = create({ visible: false, filename: 'config.json' });
    const host = fixture.nativeElement as HTMLElement;
    expect(host.querySelector('.banner')).toBeNull();
    expect(host.querySelector('mat-card')).toBeNull();
  });

  it('renders the message with the filename interpolated when visible', () => {
    const fixture = create({ visible: true, filename: 'config.json' });
    const host = fixture.nativeElement as HTMLElement;
    const text = host.querySelector('.banner-text')?.textContent ?? '';
    expect(text).toContain('Uploaded');
    expect(text).toContain('"config.json"');
    expect(text).toContain('invalid JSON');
  });

  it('uses role="status" and aria-live="polite" for non-blocking SR announcement', () => {
    const fixture = create({ visible: true, filename: 'a.json' });
    const host = fixture.nativeElement as HTMLElement;
    const banner = host.querySelector('.banner') as HTMLElement | null;
    expect(banner).withContext('banner rendered').not.toBeNull();
    expect(banner!.getAttribute('role')).toBe('status');
    expect(banner!.getAttribute('aria-live')).toBe('polite');
  });

  it('emits dismiss exactly once when the Dismiss button is clicked', () => {
    const fixture = create({ visible: true, filename: 'a.json' });
    const spy = jasmine.createSpy('dismiss');
    fixture.componentInstance.dismiss.subscribe(spy);

    const host = fixture.nativeElement as HTMLElement;
    const buttons = Array.from(
      host.querySelectorAll('.banner-actions button')
    ) as HTMLButtonElement[];
    const dismissBtn = buttons.find(
      (b) => (b.textContent ?? '').trim() === 'Dismiss'
    );
    expect(dismissBtn).withContext('Dismiss button rendered').toBeTruthy();
    dismissBtn!.click();

    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('switches between hidden and shown when the visible input changes', () => {
    const fixture = create({ visible: false, filename: 'a.json' });
    const host = fixture.nativeElement as HTMLElement;
    expect(host.querySelector('.banner')).toBeNull();

    fixture.componentRef.setInput('visible', true);
    fixture.detectChanges();
    expect(host.querySelector('.banner')).not.toBeNull();

    fixture.componentRef.setInput('visible', false);
    fixture.detectChanges();
    expect(host.querySelector('.banner')).toBeNull();
  });
});
