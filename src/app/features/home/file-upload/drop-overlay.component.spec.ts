import { TestBed } from '@angular/core/testing';
import { DropOverlayComponent } from './drop-overlay.component';

describe('DropOverlayComponent', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [DropOverlayComponent],
    });
  });

  function create(visible: boolean) {
    const fixture = TestBed.createComponent(DropOverlayComponent);
    fixture.componentRef.setInput('visible', visible);
    fixture.detectChanges();
    return fixture;
  }

  it('hides the overlay by default when visible input is false', () => {
    const fixture = create(false);
    const overlay = (fixture.nativeElement as HTMLElement).querySelector(
      '.drop-overlay',
    ) as HTMLElement;
    expect(overlay).toBeTruthy();
    expect(overlay.classList.contains('drop-overlay--visible')).toBe(false);
  });

  it('shows the overlay when visible input is true', () => {
    const fixture = create(false);
    fixture.componentRef.setInput('visible', true);
    fixture.detectChanges();
    const overlay = (fixture.nativeElement as HTMLElement).querySelector(
      '.drop-overlay',
    ) as HTMLElement;
    expect(overlay.classList.contains('drop-overlay--visible')).toBe(true);
  });

  it('sets role=status and aria-live=polite on the host element', () => {
    const fixture = create(false);
    const host = fixture.nativeElement as HTMLElement;
    expect(host.getAttribute('role')).toBe('status');
    expect(host.getAttribute('aria-live')).toBe('polite');
  });

  it('renders the "Drop JSON file here" message', () => {
    const fixture = create(true);
    const message = (fixture.nativeElement as HTMLElement).querySelector(
      '.drop-overlay__message',
    ) as HTMLElement;
    expect(message).toBeTruthy();
    expect(message.textContent?.trim()).toBe('Drop JSON file here');
  });
});
