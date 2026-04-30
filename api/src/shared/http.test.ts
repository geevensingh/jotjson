import type { InvocationContext } from '@azure/functions';
import {
  badRequest,
  forbidden,
  internalError,
  notFound,
  unauthorized
} from './http';

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

  it('forbidden returns status 403 with the provided message', () => {
    const result = forbidden('You do not own this blob');
    expect(result.status).toBe(403);
    expect(result.jsonBody).toEqual({ error: 'You do not own this blob' });
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
