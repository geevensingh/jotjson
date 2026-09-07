/**
 * Specs for the Monaco test-stub helpers (issue #513).
 *
 * These guard the cross-file contract, which is easy to get wrong and
 * expensive when it is: Vitest browser realms are shared across test
 * files, so anything these helpers leave on `window` outlives the file
 * that set it. In particular, `loadMonaco()` honours `window.monaco`
 * before anything else, so a stub left there makes the
 * browser-integration spec silently receive a stub instead of real
 * Monaco - with `window.MonacoEnvironment` never initialized.
 */
import type * as MonacoNS from 'monaco-editor';
import {
  __resetMonacoLoaderCacheForTesting,
  __setMonacoLoaderPromiseForTesting,
  loadMonaco,
} from '../app/shared/components/json-editor/monaco-loader';
import {
  clearLeakedMonacoStub,
  installMinimalMonacoStub,
  pinMinimalMonacoLoaderForFile,
  restoreMonacoStub,
} from './monaco.testing';

describe('monaco.testing helpers', () => {
  let savedMonaco: typeof window.monaco;

  beforeEach(() => {
    savedMonaco = window.monaco;
    delete window.monaco;
    __setMonacoLoaderPromiseForTesting(undefined);
    __resetMonacoLoaderCacheForTesting();
  });

  afterEach(() => {
    restoreMonacoStub();
    __setMonacoLoaderPromiseForTesting(undefined);
    __resetMonacoLoaderCacheForTesting();
    if (savedMonaco === undefined) delete window.monaco;
    else window.monaco = savedMonaco;
  });

  it('pins the loader override without touching window.monaco', async () => {
    pinMinimalMonacoLoaderForFile();

    // The regression this guards: pinning `window.monaco` too would
    // leak a stub into every later file in this realm, including the
    // browser-integration spec, whose `loadMonaco()` would then return
    // early and never initialize `window.MonacoEnvironment`.
    expect(window.monaco).toBeUndefined();

    const pinned = await loadMonaco();
    expect(pinned).toBeDefined();
    expect(pinned.editor).toBeDefined();
  });

  it('clearLeakedMonacoStub removes a stub left on window.monaco', () => {
    installMinimalMonacoStub();
    expect(window.monaco).toBeDefined();

    clearLeakedMonacoStub();

    expect(window.monaco).toBeUndefined();
  });

  it('clearLeakedMonacoStub leaves a non-stub monaco namespace alone', () => {
    // Re-requiring an already-evaluated `vs/editor/editor.main` does not
    // re-assign `window.monaco`, so deleting a real namespace would be
    // unrecoverable within the realm.
    const realLike = { editor: {} } as unknown as typeof MonacoNS;
    window.monaco = realLike;

    clearLeakedMonacoStub();

    expect(window.monaco).toBe(realLike);
  });

  it('clearLeakedMonacoStub releases a pinned loader override', async () => {
    pinMinimalMonacoLoaderForFile();

    clearLeakedMonacoStub();

    // With the override released, `loadMonaco()` falls through to the
    // `window.monaco` shortcut. Asserting via the shortcut keeps this
    // spec from ever reaching the real injection path.
    const sentinel = { editor: {} } as unknown as typeof MonacoNS;
    window.monaco = sentinel;
    await expect(loadMonaco()).resolves.toBe(sentinel);
  });
});
