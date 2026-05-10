import type { HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import type { TelemetryClient } from 'applicationinsights';
import {
  badRequest,
  forbidden,
  internalError,
  notFound,
  quotaExceeded,
  SECURITY_HEADERS,
  unauthorized,
  withSecurityHeaders,
} from './http';
import { __resetTelemetryInitForTesting, __setTelemetryClientForTesting } from './telemetry';

describe('shared/http response helpers', () => {
  it('unauthorized returns status 401 with the provided message', () => {
    const result = unauthorized('Bad token');
    expect(result.status).toBe(401);
    expect(result.jsonBody).toEqual({ error: 'Bad token' });
  });

  it('badRequest returns status 400 with the provided message', () => {
    const result = badRequest('Missing field');
    expect(result.status).toBe(400);
    expect(result.jsonBody).toEqual({ error: 'Missing field' });
  });

  it('notFound returns status 404 with the provided message', () => {
    const result = notFound('Blob not found');
    expect(result.status).toBe(404);
    expect(result.jsonBody).toEqual({ error: 'Blob not found' });
  });

  describe('forbidden', () => {
    let mockTrackEvent: jest.Mock;

    beforeEach(() => {
      __resetTelemetryInitForTesting();
      mockTrackEvent = jest.fn();
      __setTelemetryClientForTesting({ trackEvent: mockTrackEvent } as unknown as TelemetryClient);
    });

    afterEach(() => {
      __resetTelemetryInitForTesting();
      __setTelemetryClientForTesting(null);
    });

    it('returns status 403 with the provided message', () => {
      const result = forbidden('You do not own this blob', 'blob');
      expect(result.status).toBe(403);
      expect(result.jsonBody).toEqual({ error: 'You do not own this blob' });
    });

    it('emits access.forbidden with resource=blob and authMode=required', () => {
      forbidden('You do not own this blob', 'blob');
      expect(mockTrackEvent).toHaveBeenCalledTimes(1);
      expect(mockTrackEvent).toHaveBeenCalledWith({
        name: 'access.forbidden',
        properties: { resource: 'blob', authMode: 'required' },
        measurements: undefined,
      });
    });

    it('emits access.forbidden with resource=ruleSet and authMode=required', () => {
      forbidden('You do not own this rule set', 'ruleSet');
      expect(mockTrackEvent).toHaveBeenCalledTimes(1);
      expect(mockTrackEvent).toHaveBeenCalledWith({
        name: 'access.forbidden',
        properties: { resource: 'ruleSet', authMode: 'required' },
        measurements: undefined,
      });
    });

    it('emits exactly once per call (no double-emit)', () => {
      forbidden('first', 'blob');
      forbidden('second', 'ruleSet');
      expect(mockTrackEvent).toHaveBeenCalledTimes(2);
    });
  });

  describe('quotaExceeded', () => {
    let mockTrackEvent: jest.Mock;

    beforeEach(() => {
      __resetTelemetryInitForTesting();
      mockTrackEvent = jest.fn();
      __setTelemetryClientForTesting({ trackEvent: mockTrackEvent } as unknown as TelemetryClient);
    });

    afterEach(() => {
      __resetTelemetryInitForTesting();
      __setTelemetryClientForTesting(null);
    });

    it('returns status 409 with the provided message and quota_exceeded code', () => {
      const result = quotaExceeded('Blob quota of 100 reached', {
        resource: 'blob',
        via: 'create',
        count: 100,
        limit: 100,
      });
      expect(result.status).toBe(409);
      expect(result.jsonBody).toEqual({
        error: 'Blob quota of 100 reached',
        code: 'quota_exceeded',
      });
    });

    it('emits quota.exceeded with resource=blob, via=create, and the supplied measurements', () => {
      quotaExceeded('Blob quota of 100 reached', {
        resource: 'blob',
        via: 'create',
        count: 100,
        limit: 100,
      });
      expect(mockTrackEvent).toHaveBeenCalledTimes(1);
      expect(mockTrackEvent).toHaveBeenCalledWith({
        name: 'quota.exceeded',
        properties: { resource: 'blob', authMode: 'required', via: 'create' },
        measurements: { count: 100, limit: 100 },
      });
    });

    it('emits quota.exceeded with resource=ruleSet and via=create', () => {
      quotaExceeded('Rule set quota of 20 reached', {
        resource: 'ruleSet',
        via: 'create',
        count: 20,
        limit: 20,
      });
      expect(mockTrackEvent).toHaveBeenCalledTimes(1);
      expect(mockTrackEvent).toHaveBeenCalledWith({
        name: 'quota.exceeded',
        properties: { resource: 'ruleSet', authMode: 'required', via: 'create' },
        measurements: { count: 20, limit: 20 },
      });
    });

    it('emits quota.exceeded with resource=ruleSet and via=clone', () => {
      quotaExceeded('Rule set quota of 20 reached', {
        resource: 'ruleSet',
        via: 'clone',
        count: 20,
        limit: 20,
      });
      expect(mockTrackEvent).toHaveBeenCalledTimes(1);
      expect(mockTrackEvent).toHaveBeenCalledWith({
        name: 'quota.exceeded',
        properties: { resource: 'ruleSet', authMode: 'required', via: 'clone' },
        measurements: { count: 20, limit: 20 },
      });
    });

    it('passes count > limit through unchanged when the caller is over quota', () => {
      // Defends the documented contract that count is the raw observed
      // size, not clamped, so historical overages stay queryable.
      quotaExceeded('Blob quota of 100 reached', {
        resource: 'blob',
        via: 'create',
        count: 105,
        limit: 100,
      });
      expect(mockTrackEvent).toHaveBeenCalledWith({
        name: 'quota.exceeded',
        properties: { resource: 'blob', authMode: 'required', via: 'create' },
        measurements: { count: 105, limit: 100 },
      });
    });

    it('emits exactly once per call (no double-emit)', () => {
      quotaExceeded('first', { resource: 'blob', via: 'create', count: 100, limit: 100 });
      quotaExceeded('second', { resource: 'ruleSet', via: 'clone', count: 20, limit: 20 });
      expect(mockTrackEvent).toHaveBeenCalledTimes(2);
    });
  });

  describe('internalError', () => {
    it('logs structured error via context and returns status 500', () => {
      const errorSpy = jest.fn();
      const context = { error: errorSpy } as unknown as InvocationContext;
      const cause = new Error('cosmos-down');

      const result = internalError(context, 'getMe read', cause);

      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(errorSpy).toHaveBeenCalledWith('getMe read error', cause);
      expect(result.status).toBe(500);
      expect(result.jsonBody).toEqual({ error: 'Internal error' });
    });

    it('returns the same generic body regardless of the underlying error', () => {
      const context = { error: jest.fn() } as unknown as InvocationContext;
      const result = internalError(context, 'putMePreferences write', 'string-shaped-error');

      expect(result.status).toBe(500);
      expect(result.jsonBody).toEqual({ error: 'Internal error' });
    });
  });
});

describe('shared/http withSecurityHeaders', () => {
  const fakeRequest = {} as unknown as HttpRequest;

  function makeContext(): InvocationContext {
    return { error: jest.fn() } as unknown as InvocationContext;
  }

  it('exports a SECURITY_HEADERS map with the expected header set', () => {
    expect(SECURITY_HEADERS).toEqual({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
    });
  });

  it('merges SECURITY_HEADERS into a successful response and preserves status + body', async () => {
    const handler = jest.fn(async () => ({ status: 200, jsonBody: { ok: true } }));
    const wrapped = withSecurityHeaders(handler);

    const result = await wrapped(fakeRequest, makeContext());

    expect(result.status).toBe(200);
    expect(result.jsonBody).toEqual({ ok: true });
    expect(result.headers).toEqual(SECURITY_HEADERS);
  });

  it('preserves disjoint handler-set headers (e.g. ETag) alongside security headers', async () => {
    const handler = jest.fn(async () => ({
      status: 200,
      headers: { ETag: '"42"' },
      jsonBody: { ok: true },
    }));
    const wrapped = withSecurityHeaders(handler);

    const result = await wrapped(fakeRequest, makeContext());

    expect(result.headers).toEqual({ ETag: '"42"', ...SECURITY_HEADERS });
  });

  it('overrides handler-set values for keys present in SECURITY_HEADERS', async () => {
    // If a handler tries to weaken a security header (e.g., set its own
    // X-Frame-Options to ALLOW-FROM), the wrapper must still ship the
    // strict value. SECURITY_HEADERS is spread last to enforce this.
    const handler = jest.fn(async () => ({
      status: 200,
      headers: { 'X-Frame-Options': 'ALLOW-FROM https://evil.example' },
      jsonBody: {},
    }));
    const wrapped = withSecurityHeaders(handler);

    const result = await wrapped(fakeRequest, makeContext());

    expect(result.headers?.['X-Frame-Options']).toBe('DENY');
  });

  it('handles a synchronous handler return (not just async)', async () => {
    const handler = jest.fn((() => ({ status: 200, jsonBody: { sync: true } })) as never);
    const wrapped = withSecurityHeaders(handler as never);

    const result = await wrapped(fakeRequest, makeContext());

    expect(result.status).toBe(200);
    expect(result.jsonBody).toEqual({ sync: true });
    expect(result.headers).toEqual(SECURITY_HEADERS);
  });

  it('returns 500 with security headers when the handler throws', async () => {
    const cause = new Error('boom');
    const handler = jest.fn(async () => {
      throw cause;
    });
    const context = makeContext();
    const wrapped = withSecurityHeaders(handler);

    const result = await wrapped(fakeRequest, context);

    expect(result.status).toBe(500);
    expect(result.jsonBody).toEqual({ error: 'Internal error' });
    expect(result.headers).toEqual(SECURITY_HEADERS);
    expect(context.error).toHaveBeenCalledWith('Unhandled handler error:', cause);
  });

  it('returns 500 with security headers when the handler rejects asynchronously', async () => {
    const handler = jest.fn(async () => {
      await Promise.resolve();
      throw new Error('async boom');
    });
    const context = makeContext();
    const wrapped = withSecurityHeaders(handler);

    const result = await wrapped(fakeRequest, context);

    expect(result.status).toBe(500);
    expect(result.headers).toEqual(SECURITY_HEADERS);
    expect(context.error).toHaveBeenCalledTimes(1);
  });

  it('forwards the request and context arguments to the wrapped handler', async () => {
    const handler = jest.fn(async () => ({ status: 200 }) satisfies HttpResponseInit);
    const context = makeContext();
    const wrapped = withSecurityHeaders(handler);

    await wrapped(fakeRequest, context);

    expect(handler).toHaveBeenCalledWith(fakeRequest, context);
  });
});
