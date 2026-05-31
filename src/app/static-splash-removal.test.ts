// Isolated spec for `scheduleStaticSplashRemoval`. See #170.
//
// SAFETY INVARIANT - DO NOT REMOVE: this spec is safe from cross-spec
// rAF bleed only because it never yields to the task queue between
// installing the controlled-rAF shim and the final assertion.
// Concretely:
//
//   - `scheduleStaticSplashRemoval()` is called SYNCHRONOUSLY (no
//     `await fixture.whenStable()`, no `TestBed` fixture, no DI).
//   - `step()` ends with `await Promise.resolve()` (a microtask
//     only - no task boundary).
//   - No `setTimeout`, no `setInterval`, no `waitForPending`-style
//     poll, no `fixture.whenStable()`, no `requestIdleCallback` is
//     used anywhere in this file.
//
// Because nothing yields to the macrotask queue, the browser cannot
// fire foreign native `requestAnimationFrame` callbacks queued by
// prior specs in the same Karma session between our assertions.
// Adding ANY task-yielding wait (`setTimeout`, `whenStable`,
// `waitForPending`, etc.) between shim install and the final
// assertion reopens the cross-spec rAF bleed window and reintroduces
// the flake this fix was written to eliminate.
//
// If you find yourself wanting to add a task-yielding wait here,
// stop. Either the test belongs in `app.component.spec.ts` (where
// the bleed is structurally tolerated via the spy seam), or it
// belongs in a separate, larger refactor that audits the entire
// Karma suite for foreign rAF emitters.

import { scheduleStaticSplashRemoval } from './static-splash-removal';

interface RafController {
  step: () => Promise<void>;
  pendingCount: () => number;
  restore: () => void;
}

function installControlledRaf(): RafController {
  const queue: FrameRequestCallback[] = [];
  const original = window.requestAnimationFrame;
  window.requestAnimationFrame = ((cb: FrameRequestCallback) => {
    queue.push(cb);
    return queue.length;
  }) as typeof window.requestAnimationFrame;
  return {
    step: async () => {
      const cb = queue.shift();
      if (cb) {
        cb(performance.now());
      }
      // Microtask flush only - intentionally no task boundary. See
      // SAFETY INVARIANT at top of file.
      await Promise.resolve();
    },
    pendingCount: () => queue.length,
    restore: () => {
      window.requestAnimationFrame = original;
    },
  };
}

function setUpStaticSplash(): HTMLDivElement {
  const splash = document.createElement('div');
  splash.id = 'jot-static-splash';
  splash.className = 'jot-splash';
  splash.setAttribute('role', 'status');
  splash.setAttribute('aria-live', 'polite');
  document.body.appendChild(splash);
  return splash;
}

describe('scheduleStaticSplashRemoval', () => {
  afterEach(() => {
    // Belt-and-suspenders cleanup: if a test left the splash in the
    // DOM (e.g., it threw before the second step), remove it so it
    // does not bleed into subsequent specs.
    document.getElementById('jot-static-splash')?.remove();
  });

  it('removes #jot-static-splash after exactly two rAF turns (paint barrier)', async () => {
    const splash = setUpStaticSplash();
    const raf = installControlledRaf();
    try {
      scheduleStaticSplashRemoval();

      // After the synchronous call, exactly one rAF must be queued
      // (the outer one). The shim install is guaranteed to be in
      // place because it ran synchronously before the call.
      expect(raf.pendingCount(), 'one outer rAF queued by scheduleStaticSplashRemoval').toBe(1);

      // Step 1: outer rAF runs and queues the inner rAF. The splash
      // must still be present (sentinel: catches regressions to a
      // single-rAF implementation).
      await raf.step();
      expect(
        document.getElementById('jot-static-splash'),
        'after 1 rAF the splash is still present',
      ).toBe(splash);
      expect(raf.pendingCount(), 'inner rAF queued after outer ran').toBe(1);

      // Step 2: inner rAF removes the splash.
      await raf.step();
      expect(
        document.getElementById('jot-static-splash'),
        'after 2 rAFs the splash is removed',
      ).toBeNull();
      expect(raf.pendingCount(), 'queue drained').toBe(0);
    } finally {
      raf.restore();
    }
  });

  it('does not throw when #jot-static-splash is absent', async () => {
    // Mirrors the shell.html / hot-reload path where no static splash
    // ever existed. Optional chaining must make the removal a no-op.
    expect(document.getElementById('jot-static-splash')).toBeNull();
    const raf = installControlledRaf();
    try {
      scheduleStaticSplashRemoval();
      await raf.step();
      await raf.step();
      expect(document.getElementById('jot-static-splash')).toBeNull();
      expect(raf.pendingCount()).toBe(0);
    } finally {
      raf.restore();
    }
  });
});
