import { TestBed } from '@angular/core/testing';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import {
  ColdBootClipboardBannerComponent,
  type ColdBootClipboardChoice,
} from './cold-boot-clipboard-banner.component';

describe('ColdBootClipboardBannerComponent', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [ColdBootClipboardBannerComponent],
      providers: [provideNoopAnimations()],
    });
  });

  function create(visible: boolean) {
    const fixture = TestBed.createComponent(ColdBootClipboardBannerComponent);
    fixture.componentRef.setInput('visible', visible);
    fixture.detectChanges();
    return fixture;
  }

  it('renders nothing when visible=false', () => {
    const fixture = create(false);
    expect((fixture.nativeElement as HTMLElement).querySelector('.banner')).toBeNull();
  });

  it('renders the banner with three action buttons + dismiss when visible=true', () => {
    const fixture = create(true);
    const root = fixture.nativeElement as HTMLElement;
    expect(root.querySelector('.banner')).toBeTruthy();
    const actionButtons = root.querySelectorAll('.banner-actions button');
    expect(actionButtons.length).toBe(4);
  });

  function captureChoice(fixture: ReturnType<typeof create>): ColdBootClipboardChoice[] {
    const choices: ColdBootClipboardChoice[] = [];
    fixture.componentInstance.choice.subscribe((value) => {
      choices.push(value);
    });
    return choices;
  }

  function clickByLabel(fixture: ReturnType<typeof create>, label: string): void {
    const root = fixture.nativeElement as HTMLElement;
    const buttons = Array.from(root.querySelectorAll('button'));
    const target = buttons.find((b) => (b.textContent ?? '').trim() === label);
    if (!target) {
      throw new Error(`No button with label "${label}" found`);
    }
    target.click();
  }

  it('emits choice="always" when Always is clicked', () => {
    const fixture = create(true);
    const choices = captureChoice(fixture);
    clickByLabel(fixture, 'Always');
    expect(choices).toEqual(['always']);
  });

  it('emits choice="just-this-time" when Just this time is clicked', () => {
    const fixture = create(true);
    const choices = captureChoice(fixture);
    clickByLabel(fixture, 'Just this time');
    expect(choices).toEqual(['just-this-time']);
  });

  it('emits choice="never" when Never is clicked', () => {
    const fixture = create(true);
    const choices = captureChoice(fixture);
    clickByLabel(fixture, 'Never');
    expect(choices).toEqual(['never']);
  });

  it('emits choice="dismiss" when the X icon button is clicked', () => {
    const fixture = create(true);
    const choices = captureChoice(fixture);
    const root = fixture.nativeElement as HTMLElement;
    const dismissBtn = root.querySelector('.dismiss-icon') as HTMLButtonElement | null;
    expect(dismissBtn).withContext('dismiss-icon button').not.toBeNull();
    dismissBtn?.click();
    expect(choices).toEqual(['dismiss']);
  });

  it('emits choice="dismiss" when Escape is pressed inside the banner', () => {
    const fixture = create(true);
    const choices = captureChoice(fixture);
    const root = fixture.nativeElement as HTMLElement;
    const banner = root.querySelector('.banner') as HTMLElement | null;
    expect(banner).withContext('.banner').not.toBeNull();
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true });
    banner?.dispatchEvent(event);
    expect(choices).toEqual(['dismiss']);
  });
});
