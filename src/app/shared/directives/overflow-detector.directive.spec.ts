import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { OverflowDetectorDirective } from './overflow-detector.directive';
import { OverflowMeasurementQueue } from './overflow-measurement-queue.service';

@Component({
  standalone: true,
  imports: [OverflowDetectorDirective],
  template: `
    <span
      #cell
      class="cell"
      [jjOverflowDetector]="text()"
      [style.display]="'inline-block'"
      [style.maxWidth.px]="maxWidthPx()"
      [style.overflow]="'hidden'"
      [style.whiteSpace]="'nowrap'"
      [style.textOverflow]="'ellipsis'"
      >{{ text() }}</span
    >
  `,
})
class HostComponent {
  readonly text = signal('short');
  readonly maxWidthPx = signal(500);
}

describe('OverflowDetectorDirective', () => {
  let queue: OverflowMeasurementQueue;

  beforeEach(() => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ imports: [HostComponent] });
    queue = TestBed.inject(OverflowMeasurementQueue);
  });

  function mountAndFlush() {
    const fixture = TestBed.createComponent(HostComponent);
    fixture.detectChanges();
    // afterNextRender enqueues the initial measure; flush rAF.
    queue.__flushForTesting();
    return fixture;
  }

  function getDirective(fixture: ReturnType<typeof mountAndFlush>): OverflowDetectorDirective {
    const debug = fixture.debugElement.query(
      (node) =>
        node.attributes['jjOverflowDetector'] !== undefined ||
        node.nativeElement?.tagName === 'SPAN',
    );
    return debug.injector.get(OverflowDetectorDirective);
  }

  it('reports overflowing=false when content fits the host width', () => {
    const fixture = mountAndFlush();
    const directive = getDirective(fixture);
    expect(directive.overflowing()).toBe(false);
  });

  it('reports overflowing=true when content exceeds the host width', () => {
    const fixture = TestBed.createComponent(HostComponent);
    fixture.componentInstance.maxWidthPx.set(30);
    fixture.componentInstance.text.set(
      'this is a much longer string that will not fit in a 30px-wide span',
    );
    fixture.detectChanges();
    queue.__flushForTesting();

    const directive = getDirective(fixture);
    expect(directive.overflowing()).toBe(true);
  });

  it('re-measures on content signal change across recycled views', () => {
    const fixture = TestBed.createComponent(HostComponent);
    fixture.componentInstance.maxWidthPx.set(300);
    fixture.componentInstance.text.set('short');
    fixture.detectChanges();
    queue.__flushForTesting();

    const directive = getDirective(fixture);
    expect(directive.overflowing()).toBe(false);

    fixture.componentInstance.maxWidthPx.set(30);
    fixture.componentInstance.text.set(
      'this is a much longer string that will not fit in a 30px-wide span',
    );
    fixture.detectChanges();
    queue.__flushForTesting();

    expect(directive.overflowing()).toBe(true);
  });

  it('disposes the ResizeObserver on host destroy', () => {
    const fixture = mountAndFlush();
    // Mostly a smoke test: destroying the host should not throw and
    // should not leak observer notifications back into a destroyed
    // signal. We assert no errors during teardown.
    expect(() => fixture.destroy()).not.toThrow();
  });
});
