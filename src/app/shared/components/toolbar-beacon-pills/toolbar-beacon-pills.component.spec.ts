import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { NoopAnimationsModule } from '@angular/platform-browser/animations';
import { ToolbarBeaconPillsComponent } from './toolbar-beacon-pills.component';
import {
  EMPTY_BEACON_INDEX,
  type BeaconIndex,
  type PathArray,
} from '../json-tree/formatting-beacons-index';
import {
  BeaconNavigationService,
  type BeaconJumpRequest,
} from '../../../core/beacons/beacon-navigation.service';
import type { FormattingIcon } from '../../../core/api/models';

function buildIndex(buckets: ReadonlyArray<[FormattingIcon, readonly PathArray[]]>): BeaconIndex {
  const matchesByIcon = new Map<FormattingIcon, readonly PathArray[]>();
  for (const [icon, paths] of buckets) {
    matchesByIcon.set(icon, paths);
  }
  return {
    matchesByIcon,
    descendantIconsByPath: new Map(),
  };
}

describe('ToolbarBeaconPillsComponent', () => {
  let nav: BeaconNavigationService;
  let received: BeaconJumpRequest[];

  function createWith(index: BeaconIndex): ComponentFixture<ToolbarBeaconPillsComponent> {
    const fixture = TestBed.createComponent(ToolbarBeaconPillsComponent);
    fixture.componentRef.setInput('beaconIndex', index);
    fixture.detectChanges();
    return fixture;
  }

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [ToolbarBeaconPillsComponent, NoopAnimationsModule],
    }).compileComponents();
    nav = TestBed.inject(BeaconNavigationService);
    received = [];
    nav.jumpRequest$.subscribe((request) => received.push(request));
  });

  it('renders nothing when the beacon index is the shared empty sentinel', () => {
    const fixture = createWith(EMPTY_BEACON_INDEX);
    const buttons = fixture.nativeElement.querySelectorAll('.beacon-pill');
    expect(buttons.length).toBe(0);
  });

  it('renders one pill per non-empty bucket', () => {
    const fixture = createWith(
      buildIndex([
        ['warning', [['a']]],
        ['error', [['b'], ['c']]],
      ]),
    );
    const buttons = fixture.nativeElement.querySelectorAll('.beacon-pill');
    expect(buttons.length).toBe(2);
  });

  it('hides the count chip when bucket size is 1', () => {
    const fixture = createWith(buildIndex([['warning', [['a']]]]));
    const counts: NodeListOf<HTMLElement> =
      fixture.nativeElement.querySelectorAll('.beacon-pill__count');
    expect(counts.length).toBe(0);
  });

  it('shows the count chip when bucket size is >= 2', () => {
    const fixture = createWith(buildIndex([['warning', [['a'], ['b']]]]));
    const counts: NodeListOf<HTMLElement> =
      fixture.nativeElement.querySelectorAll('.beacon-pill__count');
    expect(counts.length).toBe(1);
    expect(counts[0]?.textContent?.trim()).toBe('2');
  });

  it('forward-cycles the cursor on plain click and emits a jump request', () => {
    const fixture = createWith(buildIndex([['error', [['a'], ['b'], ['c']]]]));
    const button: HTMLButtonElement = fixture.nativeElement.querySelector('.beacon-pill');
    button.click();
    expect(received.length).toBe(1);
    expect(received[0]?.path).toEqual(['b']);
    expect(received[0]?.icon).toBe('error');
    expect(received[0]?.source).toBe('pill');
    button.click();
    expect(received[1]?.path).toEqual(['c']);
    button.click();
    // Wraps back to index 0
    expect(received[2]?.path).toEqual(['a']);
  });

  it('backward-cycles the cursor when Shift is held', () => {
    const fixture = createWith(buildIndex([['error', [['a'], ['b'], ['c']]]]));
    const button: HTMLButtonElement = fixture.nativeElement.querySelector('.beacon-pill');
    const event = new MouseEvent('click', { shiftKey: true, bubbles: true });
    button.dispatchEvent(event);
    expect(received.length).toBe(1);
    expect(received[0]?.path).toEqual(['c']);
  });

  it('clamps a stale cursor when the bucket shrinks below the previous index', () => {
    const fixture = createWith(buildIndex([['error', [['a'], ['b'], ['c'], ['d']]]]));
    const button: HTMLButtonElement = fixture.nativeElement.querySelector('.beacon-pill');
    button.click(); // cursor: 1 -> path 'b'
    button.click(); // cursor: 2 -> path 'c'
    button.click(); // cursor: 3 -> path 'd'
    expect(received[2]?.path).toEqual(['d']);
    fixture.componentRef.setInput('beaconIndex', buildIndex([['error', [['x']]]]));
    fixture.detectChanges();
    button.click();
    // After clamp to 0 and forward step, 1 % 1 = 0, so we land on 'x'.
    expect(received[3]?.path).toEqual(['x']);
  });

  it('drops cursors for icons no longer present in the index', () => {
    const fixture = createWith(
      buildIndex([
        ['error', [['a'], ['b']]],
        ['warning', [['c']]],
      ]),
    );
    const errorButton: HTMLButtonElement = fixture.nativeElement.querySelector('.beacon-pill');
    errorButton.click();
    expect(received[0]?.path).toEqual(['b']);
    fixture.componentRef.setInput('beaconIndex', buildIndex([['error', [['a'], ['b']]]]));
    fixture.detectChanges();
    // Same error pill behaves: previous cursor was 1, clamps to 1 (length-1=1), forward step -> 0.
    errorButton.click();
    expect(received[1]?.path).toEqual(['a']);
  });

  it('handles multiple buckets independently', () => {
    const fixture = createWith(
      buildIndex([
        ['error', [['a']]],
        ['warning', [['b'], ['c']]],
      ]),
    );
    const buttons: HTMLButtonElement[] = Array.from(
      fixture.nativeElement.querySelectorAll('.beacon-pill'),
    );
    buttons[1]?.click();
    expect(received[0]?.icon).toBe('warning');
    expect(received[0]?.path).toEqual(['c']);
    buttons[0]?.click();
    expect(received[1]?.icon).toBe('error');
    expect(received[1]?.path).toEqual(['a']);
  });
});
