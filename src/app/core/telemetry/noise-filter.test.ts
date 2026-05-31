import { classifyError } from './noise-filter';

describe('classifyError', () => {
  describe('forward path', () => {
    it('forwards undefined', () => {
      expect(classifyError(undefined)).toEqual({ kind: 'forward' });
    });

    it('forwards null', () => {
      expect(classifyError(null)).toEqual({ kind: 'forward' });
    });

    it('forwards primitive strings (even "Canceled")', () => {
      expect(classifyError('Canceled')).toEqual({ kind: 'forward' });
    });

    it('forwards primitive numbers', () => {
      expect(classifyError(42)).toEqual({ kind: 'forward' });
    });

    it('forwards a vanilla Error', () => {
      expect(classifyError(new Error('boom'))).toEqual({ kind: 'forward' });
    });

    it('forwards a TypeError', () => {
      const e = Object.assign(new Error('boom'), { name: 'TypeError' });
      expect(classifyError(e)).toEqual({ kind: 'forward' });
    });

    it('forwards name=Canceled but message=different (requires both)', () => {
      const e = { name: 'Canceled', message: 'something else' };
      expect(classifyError(e)).toEqual({ kind: 'forward' });
    });

    it('forwards message=Canceled but name=different (requires both)', () => {
      const e = { name: 'Error', message: 'Canceled' };
      expect(classifyError(e)).toEqual({ kind: 'forward' });
    });

    it('forwards a similarly-named but not-equal name (e.g. "Cancel")', () => {
      const e = { name: 'Cancel', message: 'Canceled' };
      expect(classifyError(e)).toEqual({ kind: 'forward' });
    });
  });

  describe('suppress path: Monaco CancellationError shape', () => {
    it('suppresses a plain object with both name and message = Canceled', () => {
      const e = { name: 'Canceled', message: 'Canceled' };
      expect(classifyError(e)).toEqual({
        kind: 'suppress',
        reasonBucket: 'monacoCanceled',
      });
    });

    it('suppresses an Error subclass with name and message = Canceled', () => {
      const e = Object.assign(new Error('Canceled'), { name: 'Canceled' });
      expect(classifyError(e)).toEqual({
        kind: 'suppress',
        reasonBucket: 'monacoCanceled',
      });
    });

    // Locks the realistic incident wire shape from the 2026-05-18 alert.
    // If a future contributor tightens the predicate (e.g. by requiring
    // a specific stack frame), this test ensures the original Monaco
    // shape stays suppressed.
    it('suppresses an error with a realistic Monaco vs/editor.api stack', () => {
      const e = new Error('Canceled');
      e.name = 'Canceled';
      e.stack =
        'Canceled: Canceled\n' +
        '    at pr.cancel (https://jotjson.com/vs/editor.api-CalNCsUg.js:7:10341)\n' +
        '    at pr.dispose (https://jotjson.com/vs/editor.api-CalNCsUg.js:7:10453)\n' +
        '    at fN.clear (https://jotjson.com/vs/editor.api-CalNCsUg.js:5:25419)\n' +
        '    at fN.dispose (https://jotjson.com/vs/editor.api-CalNCsUg.js:5:25329)\n' +
        '    at Yu.dispose (https://jotjson.com/vs/editor.api-CalNCsUg.js:459:25822)\n' +
        '    at _m.dispose (https://jotjson.com/vs/editor.api-CalNCsUg.js:459:26886)\n' +
        '    at ly.clearAndDisposeAll (https://jotjson.com/vs/editor.api-CalNCsUg.js:5:26890)\n' +
        '    at ly.dispose (https://jotjson.com/vs/editor.api-CalNCsUg.js:5:26824)';
      expect(classifyError(e)).toEqual({
        kind: 'suppress',
        reasonBucket: 'monacoCanceled',
      });
    });
  });

  describe('defensive: pathological error values must not escape', () => {
    it('forwards (does not throw) when name getter throws', () => {
      const e = new Proxy(
        {},
        {
          get(_target, prop) {
            if (prop === 'name') {
              throw new Error('getter blew up');
            }
            return undefined;
          },
        },
      );
      expect(() => classifyError(e)).not.toThrow();
      expect(classifyError(e)).toEqual({ kind: 'forward' });
    });

    it('forwards (does not throw) when message getter throws', () => {
      const e = new Proxy(
        {},
        {
          get(_target, prop) {
            if (prop === 'name') return 'Canceled';
            if (prop === 'message') throw new Error('message getter blew up');
            return undefined;
          },
        },
      );
      expect(() => classifyError(e)).not.toThrow();
      expect(classifyError(e)).toEqual({ kind: 'forward' });
    });
  });
});
