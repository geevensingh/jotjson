import { TestBed } from '@angular/core/testing';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { ExtractJsonBannerComponent } from './extract-json-banner.component';

describe('ExtractJsonBannerComponent', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [ExtractJsonBannerComponent],
      providers: [provideNoopAnimations()]
    });
  });

  function create(inputs: {
    visible: boolean;
    blockCount: number;
    preservesComments: boolean;
  }) {
    const fixture = TestBed.createComponent(ExtractJsonBannerComponent);
    fixture.componentRef.setInput('visible', inputs.visible);
    fixture.componentRef.setInput('blockCount', inputs.blockCount);
    fixture.componentRef.setInput('preservesComments', inputs.preservesComments);
    fixture.detectChanges();
    return fixture;
  }

  it('renders nothing when visible is false', () => {
    const fixture = create({
      visible: false,
      blockCount: 1,
      preservesComments: true
    });
    const host = fixture.nativeElement as HTMLElement;
    expect(host.querySelector('.banner')).toBeNull();
    expect(host.querySelector('mat-card')).toBeNull();
  });

  it('shows single-block message and Extract JSON action when blockCount is 1', () => {
    const fixture = create({
      visible: true,
      blockCount: 1,
      preservesComments: true
    });
    const host = fixture.nativeElement as HTMLElement;
    const text = host.querySelector('.banner-text')?.textContent ?? '';
    expect(text).toContain('Found JSON inside your paste.');

    const actionButtons = Array.from(
      host.querySelectorAll('.banner-actions button')
    ) as HTMLButtonElement[];
    const labels = actionButtons.map((b) => (b.textContent ?? '').trim());
    expect(labels).toContain('Extract JSON');
    expect(labels).not.toContain('Extract blocks as array');
  });

  it('shows multi-block message and Extract blocks as array action when blockCount >= 2', () => {
    const fixture = create({
      visible: true,
      blockCount: 3,
      preservesComments: false
    });
    const host = fixture.nativeElement as HTMLElement;
    const text = host.querySelector('.banner-text')?.textContent ?? '';
    expect(text).toContain('Found 3 JSON blocks');
    expect(text).toContain('Comments will be removed.');

    const actionButtons = Array.from(
      host.querySelectorAll('.banner-actions button')
    ) as HTMLButtonElement[];
    const labels = actionButtons.map((b) => (b.textContent ?? '').trim());
    expect(labels).toContain('Extract blocks as array');
    expect(labels).not.toContain('Extract JSON');
  });

  it('emits extract exactly once when the Extract button is clicked', () => {
    const fixture = create({
      visible: true,
      blockCount: 1,
      preservesComments: true
    });
    const spy = jasmine.createSpy('extract');
    fixture.componentInstance.extract.subscribe(spy);

    const host = fixture.nativeElement as HTMLElement;
    const buttons = Array.from(
      host.querySelectorAll('.banner-actions button')
    ) as HTMLButtonElement[];
    const extractBtn = buttons.find(
      (b) => (b.textContent ?? '').trim() === 'Extract JSON'
    );
    expect(extractBtn).withContext('Extract button rendered').toBeTruthy();
    extractBtn!.click();

    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('emits dismiss exactly once when the Dismiss button is clicked', () => {
    const fixture = create({
      visible: true,
      blockCount: 1,
      preservesComments: true
    });
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
});
