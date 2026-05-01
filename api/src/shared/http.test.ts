import type { InvocationContext } from '@azure/functions';
import type { TelemetryClient } from 'applicationinsights';
import {
  badRequest,
  forbidden,
  internalError,
  notFound,
  quotaExceeded,
  unauthorized
} from './http';
import {
  __resetTelemetryInitForTesting,
  __setTelemetryClientForTesting
} from './telemetry';

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
        measurements: undefined
      });
    });

    it('emits access.forbidden with resource=ruleSet and authMode=required', () => {
      forbidden('You do not own this rule set', 'ruleSet');
      expect(mockTrackEvent).toHaveBeenCalledTimes(1);
      expect(mockTrackEvent).toHaveBeenCalledWith({
        name: 'access.forbidden',
        properties: { resource: 'ruleSet', authMode: 'required' },
        measurements: undefined
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
        limit: 100
      });
      expect(result.status).toBe(409);
      expect(result.jsonBody).toEqual({
        error: 'Blob quota of 100 reached',
        code: 'quota_exceeded'
      });
    });

    it('emits quota.exceeded with resource=blob, via=create, and the supplied measurements', () => {
      quotaExceeded('Blob quota of 100 reached', {
        resource: 'blob',
        via: 'create',
        count: 100,
        limit: 100
      });
      expect(mockTrackEvent).toHaveBeenCalledTimes(1);
      expect(mockTrackEvent).toHaveBeenCalledWith({
        name: 'quota.exceeded',
        properties: { resource: 'blob', authMode: 'required', via: 'create' },
        measurements: { count: 100, limit: 100 }
      });
    });

    it('emits quota.exceeded with resource=ruleSet and via=create', () => {
      quotaExceeded('Rule set quota of 20 reached', {
        resource: 'ruleSet',
        via: 'create',
        count: 20,
        limit: 20
      });
      expect(mockTrackEvent).toHaveBeenCalledTimes(1);
      expect(mockTrackEvent).toHaveBeenCalledWith({
        name: 'quota.exceeded',
        properties: { resource: 'ruleSet', authMode: 'required', via: 'create' },
        measurements: { count: 20, limit: 20 }
      });
    });

    it('emits quota.exceeded with resource=ruleSet and via=clone', () => {
      quotaExceeded('Rule set quota of 20 reached', {
        resource: 'ruleSet',
        via: 'clone',
        count: 20,
        limit: 20
      });
      expect(mockTrackEvent).toHaveBeenCalledTimes(1);
      expect(mockTrackEvent).toHaveBeenCalledWith({
        name: 'quota.exceeded',
        properties: { resource: 'ruleSet', authMode: 'required', via: 'clone' },
        measurements: { count: 20, limit: 20 }
      });
    });

    it('passes count > limit through unchanged when the caller is over quota', () => {
      // Defends the documented contract that count is the raw observed
      // size, not clamped, so historical overages stay queryable.
      quotaExceeded('Blob quota of 100 reached', {
        resource: 'blob',
        via: 'create',
        count: 105,
        limit: 100
      });
      expect(mockTrackEvent).toHaveBeenCalledWith({
        name: 'quota.exceeded',
        properties: { resource: 'blob', authMode: 'required', via: 'create' },
        measurements: { count: 105, limit: 100 }
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
