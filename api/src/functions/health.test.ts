import type { HttpRequest, InvocationContext } from '@azure/functions';

// Intercept the app.http registration so importing health.ts doesn't try to
// register with the real Functions host at module load time.
jest.mock('@azure/functions', () => {
  const actual = jest.requireActual('@azure/functions');
  return { ...actual, app: { http: jest.fn() } };
});

import { health } from './health';

const ctx = { log: jest.fn(), error: jest.fn() } as unknown as InvocationContext;
const req = {} as unknown as HttpRequest;

describe('GET /api/health', () => {
  it('returns 200 with status, service, version, and timestamp', async () => {
    const res = await health(req, ctx);
    expect(res.status).toBe(200);
    const body = res.jsonBody as {
      status: string;
      service: string;
      version: string;
      timestamp: string;
    };
    expect(body.status).toBe('ok');
    expect(body.service).toBe('jotjson-api');
    expect(typeof body.version).toBe('string');
    expect(body.version.length).toBeGreaterThan(0);
    expect(typeof body.timestamp).toBe('string');
    expect(isNaN(new Date(body.timestamp).getTime())).toBe(false);
  });
});
