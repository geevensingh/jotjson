import {
  ComponentFixture,
  fakeAsync,
  flush,
  TestBed,
  tick
} from '@angular/core/testing';
import { NoopAnimationsModule } from '@angular/platform-browser/animations';
import {
  BreadcrumbClick,
  BreadcrumbCrumb,
  JsonBreadcrumbComponent
} from './json-breadcrumb.component';

describe('JsonBreadcrumbComponent', () => {
  async function createWith(
    crumbs: readonly BreadcrumbCrumb[],
    opts: {
      emptyPlaceholder?: string;
      navAriaLabel?: string;
      overflowAriaLabel?: string;
      copyPathTitle?: string;
      copyPathAriaLabel?: string;
      copyPathDisabled?: boolean;
    } = {}
  ): Promise<ComponentFixture<JsonBreadcrumbComponent>> {
    await TestBed.configureTestingModule({
      imports: [JsonBreadcrumbComponent, NoopAnimationsModule]
    }).compileComponents();
    const fixture = TestBed.createComponent(JsonBreadcrumbComponent);
    fixture.componentRef.setInput('crumbs', crumbs);
    if (opts.emptyPlaceholder !== undefined) {
      fixture.componentRef.setInput('emptyPlaceholder', opts.emptyPlaceholder);
    }
    if (opts.navAriaLabel !== undefined) {
      fixture.componentRef.setInput('navAriaLabel', opts.navAriaLabel);
    }
    if (opts.overflowAriaLabel !== undefined) {
      fixture.componentRef.setInput('overflowAriaLabel', opts.overflowAriaLabel);
    }
    if (opts.copyPathTitle !== undefined) {
      fixture.componentRef.setInput('copyPathTitle', opts.copyPathTitle);
    }
    if (opts.copyPathAriaLabel !== undefined) {
      fixture.componentRef.setInput('copyPathAriaLabel', opts.copyPathAriaLabel);
    }
    if (opts.copyPathDisabled !== undefined) {
      fixture.componentRef.setInput('copyPathDisabled', opts.copyPathDisabled);
    }
    fixture.detectChanges();
    return fixture;
  }

  function makeCrumbs(count: number): BreadcrumbCrumb[] {
    const out: BreadcrumbCrumb[] = [];
    for (let index = 0; index < count; index++) {
      out.push({
        label: `crumb${index}`,
        canonicalPath: `$.crumb${index}`,
        current: index === count - 1
      });
    }
    return out;
  }

  function chipButtons(
    fixture: ComponentFixture<JsonBreadcrumbComponent>
  ): HTMLButtonElement[] {
    return Array.from(
      fixture.nativeElement.querySelectorAll('.jj-breadcrumb__chip')
    ) as HTMLButtonElement[];
  }

  function copyButton(
    fixture: ComponentFixture<JsonBreadcrumbComponent>
  ): HTMLButtonElement | null {
    return fixture.nativeElement.querySelector(
      '.jj-breadcrumb__copy'
    ) as HTMLButtonElement | null;
  }

  it('renders the placeholder when crumbs is empty', async () => {
    const fixture = await createWith([], {
      emptyPlaceholder: 'No current selection'
    });
    const empty = fixture.nativeElement.querySelector(
      '.jj-breadcrumb--empty'
    ) as HTMLElement | null;
    expect(empty).not.toBeNull();
    expect(empty?.textContent?.trim()).toBe('No current selection');
    expect(empty?.getAttribute('aria-live')).toBe('polite');
    expect(chipButtons(fixture).length).toBe(0);
  });

  it('renders a single chip when one crumb is provided', async () => {
    const fixture = await createWith([
      { label: 'Root', canonicalPath: '$', current: true }
    ]);
    const chips = chipButtons(fixture);
    expect(chips.length).toBe(1);
    expect(chips[0]!.textContent?.trim()).toBe('Root');
    const overflow = fixture.nativeElement.querySelector(
      '.jj-breadcrumb__chip--overflow'
    );
    expect(overflow).toBeNull();
  });

  it('renders all chips inline when natural width fits', async () => {
    const fixture = await createWith(makeCrumbs(5));
    const chips = chipButtons(fixture);
    expect(chips.length).toBe(5);
    const overflow = fixture.nativeElement.querySelector(
      '.jj-breadcrumb__chip--overflow'
    );
    expect(overflow).toBeNull();
    expect(fixture.componentInstance.hiddenMiddleCount()).toBe(0);
  });

  it('shows leading + overflow + trailing when hiddenMiddleCount > 0', async () => {
    const fixture = await createWith(makeCrumbs(8));
    // Simulate the width-driven algorithm having decided to hide
    // the middle 4 crumbs.
    fixture.componentInstance.hiddenMiddleCount.set(4);
    fixture.detectChanges();
    const chips = chipButtons(fixture);
    // crumb0 + overflow + crumb5..crumb7 = 5 chips (1 leading + 1 overflow + 3 trailing)
    expect(chips.length).toBe(5);
    const labels = chips.map((b) => b.textContent?.trim());
    expect(labels).toEqual([
      'crumb0',
      '...',
      'crumb5',
      'crumb6',
      'crumb7'
    ]);
  });

  it('exposes hidden middle ancestors via the hiddenCrumbs computed', async () => {
    const fixture = await createWith(makeCrumbs(8));
    fixture.componentInstance.hiddenMiddleCount.set(4);
    fixture.detectChanges();
    const hidden = fixture.componentInstance.hiddenCrumbs();
    expect(hidden.map((crumb) => crumb.canonicalPath)).toEqual([
      '$.crumb1',
      '$.crumb2',
      '$.crumb3',
      '$.crumb4'
    ]);
  });

  it('emits crumbClick with absolute depth when a leading chip is clicked', async () => {
    const fixture = await createWith(makeCrumbs(8));
    const events: BreadcrumbClick[] = [];
    fixture.componentInstance.crumbClick.subscribe((value) => {
      events.push(value);
    });
    const chips = chipButtons(fixture);
    chips[0]!.click();
    expect(events).toEqual([{ canonicalPath: '$.crumb0', depth: 0 }]);
  });

  it('emits crumbClick with absolute depth when a trailing chip is clicked while collapsed', async () => {
    const fixture = await createWith(makeCrumbs(8));
    fixture.componentInstance.hiddenMiddleCount.set(5);
    fixture.detectChanges();
    const events: BreadcrumbClick[] = [];
    fixture.componentInstance.crumbClick.subscribe((value) => {
      events.push(value);
    });
    const chips = chipButtons(fixture);
    // After collapse: chips are [crumb0, ..., crumb6, crumb7].
    // The last chip is crumbs[7], whose absolute depth in the
    // original list is 7 regardless of how many middle were hidden.
    chips[chips.length - 1]!.click();
    expect(events).toEqual([{ canonicalPath: '$.crumb7', depth: 7 }]);
  });

  it('sets aria-current="location" on the chip flagged as current', async () => {
    const fixture = await createWith([
      { label: 'Root', canonicalPath: '$', current: false },
      { label: 'foo', canonicalPath: '$.foo', current: false },
      { label: 'bar', canonicalPath: '$.foo.bar', current: true }
    ]);
    const chips = chipButtons(fixture);
    expect(chips.length).toBe(3);
    expect(chips[0]!.getAttribute('aria-current')).toBeNull();
    expect(chips[1]!.getAttribute('aria-current')).toBeNull();
    expect(chips[2]!.getAttribute('aria-current')).toBe('location');
  });

  it('uses the supplied nav aria-label', async () => {
    const fixture = await createWith(makeCrumbs(2), {
      navAriaLabel: 'Migas de pan'
    });
    const nav = fixture.nativeElement.querySelector('nav');
    expect(nav?.getAttribute('aria-label')).toBe('Migas de pan');
  });

  describe('copy-path button', () => {
    it('renders with the supplied title and aria-label', async () => {
      const fixture = await createWith(makeCrumbs(1), {
        copyPathTitle: 'Copiar ruta',
        copyPathAriaLabel: 'Copiar ruta JSON de la fila seleccionada'
      });
      const button = copyButton(fixture);
      expect(button).not.toBeNull();
      expect(button?.getAttribute('title')).toBe('Copiar ruta');
      expect(button?.getAttribute('aria-label')).toBe(
        'Copiar ruta JSON de la fila seleccionada'
      );
    });

    it('is disabled when copyPathDisabled is true (e.g. no selection)', async () => {
      const fixture = await createWith([], {
        copyPathDisabled: true
      });
      const button = copyButton(fixture);
      expect(button?.disabled).toBe(true);
    });

    it('is enabled when copyPathDisabled is false', async () => {
      const fixture = await createWith(makeCrumbs(2), {
        copyPathDisabled: false
      });
      const button = copyButton(fixture);
      expect(button?.disabled).toBe(false);
    });

    it('emits copyPathClick when the button is clicked', async () => {
      const fixture = await createWith(makeCrumbs(2));
      let emitted = 0;
      fixture.componentInstance.copyPathClick.subscribe(() => {
        emitted++;
      });
      copyButton(fixture)?.click();
      expect(emitted).toBe(1);
    });

    it('does not emit copyPathClick when disabled and clicked', async () => {
      const fixture = await createWith([], {
        copyPathDisabled: true
      });
      let emitted = 0;
      fixture.componentInstance.copyPathClick.subscribe(() => {
        emitted++;
      });
      copyButton(fixture)?.click();
      expect(emitted).toBe(0);
    });
  });

  describe('isFullyCollapsed signal', () => {
    function bar(
      fixture: ComponentFixture<JsonBreadcrumbComponent>
    ): HTMLElement {
      return fixture.nativeElement.querySelector(
        '.jj-breadcrumb-bar'
      ) as HTMLElement;
    }

    it('is false when crumbs is empty (placeholder branch)', async () => {
      const fixture = await createWith([]);
      expect(fixture.componentInstance.isFullyCollapsed()).toBe(false);
      expect(bar(fixture).classList.contains('is-fully-collapsed')).toBe(
        false
      );
    });

    it('is true when only one crumb is supplied (no overflow possible)', async () => {
      const fixture = await createWith(makeCrumbs(1));
      expect(fixture.componentInstance.isFullyCollapsed()).toBe(true);
      expect(bar(fixture).classList.contains('is-fully-collapsed')).toBe(
        true
      );
    });

    it('is true when two crumbs are supplied (no overflow possible)', async () => {
      const fixture = await createWith(makeCrumbs(2));
      expect(fixture.componentInstance.isFullyCollapsed()).toBe(true);
      expect(bar(fixture).classList.contains('is-fully-collapsed')).toBe(
        true
      );
    });

    it('is false when 3+ crumbs are inline (hiddenMiddleCount = 0)', async () => {
      const fixture = await createWith(makeCrumbs(5));
      expect(fixture.componentInstance.hiddenMiddleCount()).toBe(0);
      expect(fixture.componentInstance.isFullyCollapsed()).toBe(false);
      expect(bar(fixture).classList.contains('is-fully-collapsed')).toBe(
        false
      );
    });

    it('is false in mid-collapse (some middle hidden, but not all)', async () => {
      const fixture = await createWith(makeCrumbs(8));
      // 8 crumbs => max collapsible middle = 6 (total - 2). Halfway:
      fixture.componentInstance.hiddenMiddleCount.set(3);
      fixture.detectChanges();
      expect(fixture.componentInstance.isFullyCollapsed()).toBe(false);
      expect(bar(fixture).classList.contains('is-fully-collapsed')).toBe(
        false
      );
    });

    it('flips to true when the algorithm has hidden every collapsible middle', async () => {
      const fixture = await createWith(makeCrumbs(8));
      fixture.componentInstance.hiddenMiddleCount.set(6); // total - 2
      fixture.detectChanges();
      expect(fixture.componentInstance.isFullyCollapsed()).toBe(true);
      expect(bar(fixture).classList.contains('is-fully-collapsed')).toBe(
        true
      );
    });
  });

  describe('resize handling', () => {
    interface ResizeObserverGlobal {
      ResizeObserver: typeof ResizeObserver;
    }
    type ResizeFn = (
      entries: ResizeObserverEntry[],
      observer: ResizeObserver
    ) => void;

    let originalResizeObserver: typeof ResizeObserver | undefined;
    let observerCallbacks: ResizeFn[];
    let observerInstances: FakeResizeObserver[];

    class FakeResizeObserver implements ResizeObserver {
      readonly observed: Element[] = [];
      disconnected = false;
      constructor(public callback: ResizeFn) {
        observerInstances.push(this);
        observerCallbacks.push(callback);
      }
      observe(target: Element): void {
        this.observed.push(target);
      }
      unobserve(): void {}
      disconnect(): void {
        this.disconnected = true;
      }
    }

    beforeEach(() => {
      observerCallbacks = [];
      observerInstances = [];
      const win = window as unknown as ResizeObserverGlobal;
      originalResizeObserver = win.ResizeObserver;
      win.ResizeObserver =
        FakeResizeObserver as unknown as typeof ResizeObserver;
    });

    afterEach(() => {
      const win = window as unknown as ResizeObserverGlobal;
      if (originalResizeObserver === undefined) {
        delete (win as unknown as Record<string, unknown>)['ResizeObserver'];
      } else {
        win.ResizeObserver = originalResizeObserver;
      }
    });

    it('attaches a ResizeObserver to the chip list <ol>', async () => {
      const fixture = await createWith(makeCrumbs(3));
      expect(observerInstances.length).toBe(1);
      const observed = observerInstances[0]!.observed[0];
      expect(observed).toBeDefined();
      expect((observed as HTMLElement).tagName.toLowerCase()).toBe('ol');
    });

    it('reattaches the observer when the <ol> is destroyed and re-created (deselect -> re-select)', async () => {
      const fixture = await createWith(makeCrumbs(3));
      const firstObserver = observerInstances[0]!;
      expect(firstObserver.disconnected).toBe(false);

      // Empty crumbs collapses the @if/@else into the placeholder
      // branch, destroying the original <ol>.
      fixture.componentRef.setInput('crumbs', []);
      fixture.detectChanges();
      expect(firstObserver.disconnected).toBe(true);

      // Re-select something. A new <ol> is created. The component
      // must observe it via a fresh ResizeObserver.
      fixture.componentRef.setInput('crumbs', makeCrumbs(4));
      fixture.detectChanges();
      expect(observerInstances.length).toBe(2);
      const secondObserver = observerInstances[1]!;
      expect(secondObserver.disconnected).toBe(false);
      const observed = secondObserver.observed[0];
      expect((observed as HTMLElement).tagName.toLowerCase()).toBe('ol');
    });

    it('debounces ResizeObserver fires by 100ms (trailing edge)', fakeAsync(() => {
      TestBed.configureTestingModule({
        imports: [JsonBreadcrumbComponent, NoopAnimationsModule]
      });
      const fixture = TestBed.createComponent(JsonBreadcrumbComponent);
      fixture.componentRef.setInput('crumbs', makeCrumbs(5));
      fixture.detectChanges();

      expect(observerCallbacks.length).toBe(1);
      const fire = observerCallbacks[0]!;

      // Pretend the algorithm has previously hidden three middle
      // crumbs. The resize-debounce trailing-edge fire is the only
      // thing that should reset that signal back to 0.
      fixture.componentInstance.hiddenMiddleCount.set(3);

      // Fire the callback rapidly in succession.
      fire([], {} as ResizeObserver);
      tick(50);
      fire([], {} as ResizeObserver);
      tick(50);
      fire([], {} as ResizeObserver);

      // Just before the trailing 100ms expires (relative to the
      // last fire), no reset has occurred.
      tick(99);
      expect(fixture.componentInstance.hiddenMiddleCount()).toBe(3);

      // After the trailing 100ms expires, the debounced callback
      // runs exactly once and resets hiddenMiddleCount to 0.
      tick(1);
      expect(fixture.componentInstance.hiddenMiddleCount()).toBe(0);

      // Drain any pending RAF that the trailing-edge fire scheduled.
      flush();
    }));
  });
});
