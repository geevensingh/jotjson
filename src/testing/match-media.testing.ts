/**
 * Lightweight `window.matchMedia` test helper. Lets specs control the
 * matches state for any media query and fire `change` events.
 *
 * Usage:
 *
 *   const harness = installMatchMediaStub();
 *   // initial seeding -- specs should set the desired state for any
 *   // queries the unit under test will register before mounting:
 *   harness.set('(max-width: 767.98px)', true);
 *   // ... mount component ...
 *   harness.fire('(max-width: 767.98px)', false); // dispatches change
 *   harness.uninstall();
 *
 * Restore handling: pair every `installMatchMediaStub()` call with
 * `uninstall()` (in `afterEach`) to put back the real `matchMedia`.
 */

interface RegisteredMql {
  matches: boolean;
  listeners: Set<(event: MediaQueryListEvent) => void>;
}

export interface MatchMediaHarness {
  /** Set the matches state for a query (queries registered later inherit this). */
  set(query: string, matches: boolean): void;
  /** Fire a `change` event for a query, updating matches and notifying listeners. */
  fire(query: string, matches: boolean): void;
  /** Restore the original `window.matchMedia`. */
  uninstall(): void;
}

export function installMatchMediaStub(): MatchMediaHarness {
  const registry = new Map<string, RegisteredMql>();
  const original = window.matchMedia;

  function getOrCreate(query: string): RegisteredMql {
    let entry = registry.get(query);
    if (!entry) {
      entry = { matches: false, listeners: new Set() };
      registry.set(query, entry);
    }
    return entry;
  }

  window.matchMedia = ((query: string): MediaQueryList => {
    const entry = getOrCreate(query);
    const mql: MediaQueryList = {
      get matches(): boolean {
        return entry.matches;
      },
      media: query,
      onchange: null,
      addEventListener(type: string, listener: EventListenerOrEventListenerObject | null): void {
        if (type !== 'change' || listener === null) return;
        if (typeof listener === 'function') {
          entry.listeners.add(listener as (event: MediaQueryListEvent) => void);
        } else {
          entry.listeners.add(((event: MediaQueryListEvent) => listener.handleEvent(event)) as (
            event: MediaQueryListEvent,
          ) => void);
        }
      },
      removeEventListener(type: string, listener: EventListenerOrEventListenerObject | null): void {
        if (type !== 'change' || listener === null) return;
        if (typeof listener === 'function') {
          entry.listeners.delete(listener as (event: MediaQueryListEvent) => void);
        }
      },
      addListener(): void {
        /* deprecated; ignored */
      },
      removeListener(): void {
        /* deprecated; ignored */
      },
      dispatchEvent(): boolean {
        return true;
      },
    } as MediaQueryList;
    return mql;
  }) as typeof window.matchMedia;

  return {
    set(query: string, matches: boolean): void {
      getOrCreate(query).matches = matches;
    },
    fire(query: string, matches: boolean): void {
      const entry = getOrCreate(query);
      entry.matches = matches;
      const event = { matches, media: query } as MediaQueryListEvent;
      for (const listener of entry.listeners) listener(event);
    },
    uninstall(): void {
      window.matchMedia = original;
    },
  };
}
