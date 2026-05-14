import {
  afterNextRender,
  DestroyRef,
  Directive,
  effect,
  ElementRef,
  inject,
  Injector,
  input,
  signal,
} from '@angular/core';
import { OverflowMeasurementQueue } from './overflow-measurement-queue.service';

/**
 * Detects horizontal overflow on the host element and exposes the
 * result as a signal. Used to gate `matTooltip` on tree value /
 * key cells so the tooltip only appears when the text is actually
 * clipped by `text-overflow: ellipsis`.
 *
 * The directive takes the cell's text content as a required input
 * (`[jjOverflowDetector]`) so the effect re-measures whenever the
 * displayed string changes across `*cdkVirtualFor` recycling. A
 * `ResizeObserver` on the host catches box-size changes (font-size
 * pref, viewport resize). All measurements go through the shared
 * `OverflowMeasurementQueue` to batch reads into one rAF per frame
 * and avoid the layout-thrash storm that synchronous
 * `scrollWidth` reads would cause when N rows mount at once.
 *
 * Locked decisions referenced from the Phase 2 plan: 12, 13, 17
 * (two-phase API contract enforced by the queue service).
 */
@Directive({
  selector: '[jjOverflowDetector]',
  standalone: true,
  exportAs: 'jjOverflowDetector',
})
export class OverflowDetectorDirective {
  readonly content = input.required<string>({ alias: 'jjOverflowDetector' });
  readonly overflowing = signal(false);

  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly queue = inject(OverflowMeasurementQueue);
  private readonly injector = inject(Injector);
  private readonly destroyRef = inject(DestroyRef);

  constructor() {
    const el = this.host.nativeElement;
    const enqueueMeasure = (): void => {
      this.queue.enqueue<{ scrollWidth: number; clientWidth: number }>(
        () => ({ scrollWidth: el.scrollWidth, clientWidth: el.clientWidth }),
        ({ scrollWidth, clientWidth }) => {
          this.overflowing.set(scrollWidth > clientWidth + 1);
        },
      );
    };
    const resizeObserver = new ResizeObserver(enqueueMeasure);
    afterNextRender(
      () => {
        resizeObserver.observe(el);
        enqueueMeasure();
      },
      { injector: this.injector },
    );
    effect(() => {
      this.content();
      enqueueMeasure();
    });
    this.destroyRef.onDestroy(() => resizeObserver.disconnect());
  }
}
