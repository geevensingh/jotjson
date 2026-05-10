import { generateKeyPairSync } from 'node:crypto';
import * as jwt from 'jsonwebtoken';
import type { HttpRequest } from '@azure/functions';
import type { TelemetryClient } from 'applicationinsights';
import {
  AuthError,
  __resetDevAuthWarnForTesting,
  __setJwksClientForTesting,
  isDevAuthBypassEnabled,
  requireAuth,
  tryAuth,
  tryDevAuthToken,
  verifyAccessToken,
} from './auth';
import {
  __resetTelemetryInitForTesting,
  __setTelemetryClientForTesting as __setTelemetryClientForTestingT,
} from './telemetry';

// Default backend telemetry to a silent null override for the whole file so
// existing rejection tests do not trigger the warn-once console output added
// by requireAuth's new emit path. Specs that need a mock client install one in
// their own beforeEach/afterEach (see 'auth.tokenRejected telemetry emission').
__setTelemetryClientForTestingT(null);

const AUTHORITY = 'https://example.ciamlogin.com/tenant-1';
const AUDIENCE = 'api://test-api-client-id';

function makeRequest(headers: Record<string, string> = {}): HttpRequest {
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  return {
    headers: {
      get: (name: string): string | null => lower[name.toLowerCase()] ?? null,
    },
  } as unknown as HttpRequest;
}

describe('shared/auth Entra JWT validation', () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
  });
  const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
  const publicPem = publicKey.export({ type: 'spki', format: 'pem' }) as string;

  beforeAll(() => {
    process.env.ENTRA_AUTHORITY = AUTHORITY;
    process.env.ENTRA_API_AUDIENCE = AUDIENCE;
    __setJwksClientForTesting({
      getSigningKey: async () => ({
        getPublicKey: () => publicPem,
      }),
    });
  });

  afterAll(() => {
    __setJwksClientForTesting(null);
    delete process.env.ENTRA_AUTHORITY;
    delete process.env.ENTRA_API_AUDIENCE;
  });

  function sign(claims: Record<string, unknown>, opts: jwt.SignOptions = {}): string {
    return jwt.sign(claims, privatePem, {
      algorithm: 'RS256',
      audience: AUDIENCE,
      issuer: AUTHORITY,
      expiresIn: '10m',
      header: { kid: 'test-kid', alg: 'RS256' },
      ...opts,
    });
  }

  it('validates a well-formed token and returns the principal', async () => {
    const token = sign({ oid: 'oid-1', name: 'Alice', email: 'a@example.com' });
    const principal = await verifyAccessToken(token);
    expect(principal.id).toBe('oid-1');
    expect(principal.displayName).toBe('Alice');
    expect(principal.email).toBe('a@example.com');
  });

  it('falls back from oid to sub for the stable id', async () => {
    const token = sign({ sub: 'sub-only' });
    const principal = await verifyAccessToken(token);
    expect(principal.id).toBe('sub-only');
  });

  it('falls back email to preferred_username', async () => {
    const token = sign({ oid: 'oid-1', preferred_username: 'u@example.com' });
    const principal = await verifyAccessToken(token);
    expect(principal.email).toBe('u@example.com');
  });

  it('rejects a token with a mismatched audience', async () => {
    const token = sign({ oid: 'oid-1' }, { audience: 'api://other' });
    await expect(verifyAccessToken(token)).rejects.toBeInstanceOf(AuthError);
  });

  it('rejects a token with a mismatched issuer', async () => {
    const token = sign({ oid: 'oid-1' }, { issuer: 'https://evil.example/' });
    await expect(verifyAccessToken(token)).rejects.toBeInstanceOf(AuthError);
  });

  it('rejects an expired token', async () => {
    const token = sign({ oid: 'oid-1' }, { expiresIn: '-1s' });
    await expect(verifyAccessToken(token)).rejects.toBeInstanceOf(AuthError);
  });

  it('rejects a token signed with a different key', async () => {
    const { privateKey: otherKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
    });
    const otherPem = otherKey.export({ type: 'pkcs8', format: 'pem' }) as string;
    const token = jwt.sign({ oid: 'oid-1' }, otherPem, {
      algorithm: 'RS256',
      audience: AUDIENCE,
      issuer: AUTHORITY,
      expiresIn: '10m',
      header: { kid: 'test-kid', alg: 'RS256' },
    });
    await expect(verifyAccessToken(token)).rejects.toBeInstanceOf(AuthError);
  });

  it('rejects a token with no kid', async () => {
    const token = jwt.sign({ oid: 'oid-1' }, privatePem, {
      algorithm: 'RS256',
      audience: AUDIENCE,
      issuer: AUTHORITY,
      expiresIn: '10m',
    });
    await expect(verifyAccessToken(token)).rejects.toBeInstanceOf(AuthError);
  });

  it('throws when auth is not configured', async () => {
    const savedAuthority = process.env.ENTRA_AUTHORITY;
    delete process.env.ENTRA_AUTHORITY;
    await expect(verifyAccessToken('anything')).rejects.toBeInstanceOf(AuthError);
    process.env.ENTRA_AUTHORITY = savedAuthority;
  });

  describe('requireAuth (request wrapper)', () => {
    it('extracts a bearer token from the Authorization header', async () => {
      const token = sign({ oid: 'oid-1', name: 'Req' });
      const principal = await requireAuth(makeRequest({ Authorization: `Bearer ${token}` }));
      expect(principal.id).toBe('oid-1');
    });

    it('rejects a request with no Authorization header', async () => {
      await expect(requireAuth(makeRequest({}))).rejects.toBeInstanceOf(AuthError);
    });

    it('rejects a request with a non-bearer Authorization scheme', async () => {
      await expect(requireAuth(makeRequest({ Authorization: 'Basic abc' }))).rejects.toBeInstanceOf(
        AuthError,
      );
    });

    it('prefers the custom X-Jotjson-Authorization header over Authorization', async () => {
      const customToken = sign({ oid: 'oid-custom' });
      const principal = await requireAuth(
        makeRequest({
          'X-Jotjson-Authorization': `Bearer ${customToken}`,
          Authorization: 'Bearer stripped-by-swa',
        }),
      );
      expect(principal.id).toBe('oid-custom');
    });
  });

  describe('tryAuth (optional auth wrapper)', () => {
    it('returns null when no Authorization header is present', async () => {
      const principal = await tryAuth(makeRequest({}));
      expect(principal).toBeNull();
    });

    it('returns null when the token is invalid (AuthError swallowed)', async () => {
      const expired = sign({ oid: 'oid-1' }, { expiresIn: '-1s' });
      const principal = await tryAuth(makeRequest({ Authorization: `Bearer ${expired}` }));
      expect(principal).toBeNull();
    });

    it('returns the principal for a valid token', async () => {
      const token = sign({ oid: 'oid-try', name: 'Tess', email: 't@example.com' });
      const principal = await tryAuth(makeRequest({ Authorization: `Bearer ${token}` }));
      expect(principal).not.toBeNull();
      expect(principal?.id).toBe('oid-try');
      expect(principal?.displayName).toBe('Tess');
      expect(principal?.email).toBe('t@example.com');
    });

    it('propagates non-AuthError infrastructure failures', async () => {
      const token = sign({ oid: 'oid-1' });
      const infraError = new Error('jwt infra boom');
      const jwtModule = jest.requireActual('jsonwebtoken') as typeof import('jsonwebtoken');
      const spy = jest.spyOn(jwtModule, 'verify').mockImplementationOnce(() => {
        throw infraError;
      });
      try {
        await expect(tryAuth(makeRequest({ Authorization: `Bearer ${token}` }))).rejects.toBe(
          infraError,
        );
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe('dev-auth bypass', () => {
    let savedBypass: string | undefined;
    let savedInstanceId: string | undefined;
    let savedHostname: string | undefined;
    let warnSpy: jest.SpyInstance;

    beforeEach(() => {
      savedBypass = process.env['JOTJSON_DEV_AUTH_BYPASS'];
      savedInstanceId = process.env['WEBSITE_INSTANCE_ID'];
      savedHostname = process.env['WEBSITE_HOSTNAME'];
      delete process.env['JOTJSON_DEV_AUTH_BYPASS'];
      delete process.env['WEBSITE_INSTANCE_ID'];
      delete process.env['WEBSITE_HOSTNAME'];
      warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
      __resetDevAuthWarnForTesting();
    });

    afterEach(() => {
      if (savedBypass === undefined) delete process.env['JOTJSON_DEV_AUTH_BYPASS'];
      else process.env['JOTJSON_DEV_AUTH_BYPASS'] = savedBypass;
      if (savedInstanceId === undefined) delete process.env['WEBSITE_INSTANCE_ID'];
      else process.env['WEBSITE_INSTANCE_ID'] = savedInstanceId;
      if (savedHostname === undefined) delete process.env['WEBSITE_HOSTNAME'];
      else process.env['WEBSITE_HOSTNAME'] = savedHostname;
      warnSpy.mockRestore();
    });

    describe('isDevAuthBypassEnabled', () => {
      it('returns false when JOTJSON_DEV_AUTH_BYPASS is unset', () => {
        expect(isDevAuthBypassEnabled()).toBe(false);
      });

      it('returns false when JOTJSON_DEV_AUTH_BYPASS is anything but the literal "true"', () => {
        process.env['JOTJSON_DEV_AUTH_BYPASS'] = '1';
        expect(isDevAuthBypassEnabled()).toBe(false);
        process.env['JOTJSON_DEV_AUTH_BYPASS'] = 'TRUE';
        expect(isDevAuthBypassEnabled()).toBe(false);
        process.env['JOTJSON_DEV_AUTH_BYPASS'] = 'yes';
        expect(isDevAuthBypassEnabled()).toBe(false);
      });

      it('returns true when JOTJSON_DEV_AUTH_BYPASS=true and WEBSITE_* vars are absent', () => {
        process.env['JOTJSON_DEV_AUTH_BYPASS'] = 'true';
        expect(isDevAuthBypassEnabled()).toBe(true);
      });

      it('returns false when WEBSITE_INSTANCE_ID is set even with bypass=true', () => {
        process.env['JOTJSON_DEV_AUTH_BYPASS'] = 'true';
        process.env['WEBSITE_INSTANCE_ID'] = 'abc';
        expect(isDevAuthBypassEnabled()).toBe(false);
      });

      it('returns false when WEBSITE_HOSTNAME is an Azure-shaped value', () => {
        process.env['JOTJSON_DEV_AUTH_BYPASS'] = 'true';
        process.env['WEBSITE_HOSTNAME'] = 'jotjson.azurestaticapps.net';
        expect(isDevAuthBypassEnabled()).toBe(false);
        process.env['WEBSITE_HOSTNAME'] = 'jotjson.azurewebsites.net';
        expect(isDevAuthBypassEnabled()).toBe(false);
        process.env['WEBSITE_HOSTNAME'] = 'jot.example.com';
        expect(isDevAuthBypassEnabled()).toBe(false);
      });

      it('returns true when WEBSITE_HOSTNAME is the localhost form Core Tools sets', () => {
        // Azure Functions Core Tools 4.x sets WEBSITE_HOSTNAME=localhost:7071
        // on a developer workstation - the bypass must still engage.
        process.env['JOTJSON_DEV_AUTH_BYPASS'] = 'true';
        process.env['WEBSITE_HOSTNAME'] = 'localhost:7071';
        expect(isDevAuthBypassEnabled()).toBe(true);
        process.env['WEBSITE_HOSTNAME'] = 'localhost';
        expect(isDevAuthBypassEnabled()).toBe(true);
        process.env['WEBSITE_HOSTNAME'] = 'LOCALHOST:7071';
        expect(isDevAuthBypassEnabled()).toBe(true);
      });

      it('returns false for a hostname that merely starts with "localhost"', () => {
        // Defense in depth - prevent attacks via crafted hostnames.
        process.env['JOTJSON_DEV_AUTH_BYPASS'] = 'true';
        process.env['WEBSITE_HOSTNAME'] = 'localhost.evil.example.com';
        expect(isDevAuthBypassEnabled()).toBe(false);
      });
    });

    describe('tryDevAuthToken', () => {
      it('returns null when bypass is disabled', () => {
        expect(tryDevAuthToken('dev:dev-user-1')).toBeNull();
      });

      it('returns a populated principal for a valid dev:<userId> token', () => {
        process.env['JOTJSON_DEV_AUTH_BYPASS'] = 'true';
        const principal = tryDevAuthToken('dev:dev-user-1');
        expect(principal).not.toBeNull();
        expect(principal?.id).toBe('dev-user-1');
        expect(principal?.displayName).toBe('Dev User (dev-user-1)');
        expect(principal?.email).toBe('dev-user-1@dev.local');
        expect(principal?.claims['oid']).toBe('dev-user-1');
        expect(principal?.claims['sub']).toBe('dev-user-1');
        expect(principal?.claims['preferred_username']).toBe('dev-user-1@dev.local');
      });

      it('rejects malformed dev tokens (uppercase, spaces, missing prefix, too long)', () => {
        process.env['JOTJSON_DEV_AUTH_BYPASS'] = 'true';
        expect(tryDevAuthToken('dev:DevUser')).toBeNull();
        expect(tryDevAuthToken('dev:has space')).toBeNull();
        expect(tryDevAuthToken('dev-user-1')).toBeNull();
        expect(tryDevAuthToken('Bearer dev:dev-user-1')).toBeNull();
        expect(tryDevAuthToken('dev:' + 'a'.repeat(65))).toBeNull();
      });

      it('emits a one-time warning to console.warn when first invoked with a valid token', () => {
        process.env['JOTJSON_DEV_AUTH_BYPASS'] = 'true';
        // First valid call emits.
        tryDevAuthToken('dev:dev-user-1');
        const callsAfterFirst = warnSpy.mock.calls.length;
        expect(callsAfterFirst).toBeGreaterThanOrEqual(1);
        // Second valid call does not emit again (module-level dedupe).
        tryDevAuthToken('dev:dev-user-1');
        expect(warnSpy.mock.calls.length).toBe(callsAfterFirst);
      });
    });

    describe('verifyAccessToken / requireAuth / tryAuth integration', () => {
      it('verifyAccessToken returns the dev principal for dev:<userId> when bypass on', async () => {
        process.env['JOTJSON_DEV_AUTH_BYPASS'] = 'true';
        const principal = await verifyAccessToken('dev:dev-user-1');
        expect(principal.id).toBe('dev-user-1');
      });

      it('verifyAccessToken still rejects malformed dev: tokens via JWT path when bypass on', async () => {
        process.env['JOTJSON_DEV_AUTH_BYPASS'] = 'true';
        // 'dev:NOT MATCHING REGEX' is not accepted as a dev token, so it falls through
        // to JWT validation and is rejected as malformed JWT.
        await expect(verifyAccessToken('dev:UPPER!')).rejects.toBeInstanceOf(AuthError);
      });

      it('requireAuth honors dev token in X-Jotjson-Authorization header', async () => {
        process.env['JOTJSON_DEV_AUTH_BYPASS'] = 'true';
        const principal = await requireAuth(
          makeRequest({ 'X-Jotjson-Authorization': 'Bearer dev:dev-user-1' }),
        );
        expect(principal.id).toBe('dev-user-1');
      });

      it('tryAuth returns the dev principal for a valid dev token', async () => {
        process.env['JOTJSON_DEV_AUTH_BYPASS'] = 'true';
        const principal = await tryAuth(makeRequest({ Authorization: 'Bearer dev:dev-user-1' }));
        expect(principal?.id).toBe('dev-user-1');
      });

      it('regression: real Entra JWTs still validate when bypass is on', async () => {
        process.env['JOTJSON_DEV_AUTH_BYPASS'] = 'true';
        const token = sign({ oid: 'oid-real', name: 'Real User' });
        const principal = await verifyAccessToken(token);
        expect(principal.id).toBe('oid-real');
      });

      it('refuses to engage when WEBSITE_INSTANCE_ID indicates an Azure runtime', async () => {
        process.env['JOTJSON_DEV_AUTH_BYPASS'] = 'true';
        process.env['WEBSITE_INSTANCE_ID'] = 'cloud-sentinel';
        // Dev token format is rejected because bypass is force-disabled in Azure;
        // it falls through to JWT validation and fails as malformed.
        await expect(verifyAccessToken('dev:dev-user-1')).rejects.toBeInstanceOf(AuthError);
      });
    });
  });
});

describe('auth.tokenRejected telemetry emission', () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
  });
  const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
  const publicPem = publicKey.export({ type: 'spki', format: 'pem' }) as string;

  let mockTrackEvent: jest.Mock;
  let savedAuthority: string | undefined;
  let savedAudience: string | undefined;

  beforeEach(() => {
    __resetTelemetryInitForTesting();
    mockTrackEvent = jest.fn();
    __setTelemetryClientForTestingT({ trackEvent: mockTrackEvent } as unknown as TelemetryClient);
    savedAuthority = process.env['ENTRA_AUTHORITY'];
    savedAudience = process.env['ENTRA_API_AUDIENCE'];
    process.env['ENTRA_AUTHORITY'] = AUTHORITY;
    process.env['ENTRA_API_AUDIENCE'] = AUDIENCE;
    __setJwksClientForTesting({
      getSigningKey: async () => ({
        getPublicKey: () => publicPem,
      }),
    });
  });

  afterEach(() => {
    __resetTelemetryInitForTesting();
    __setTelemetryClientForTestingT(null);
    __setJwksClientForTesting(null);
    if (savedAuthority === undefined) delete process.env['ENTRA_AUTHORITY'];
    else process.env['ENTRA_AUTHORITY'] = savedAuthority;
    if (savedAudience === undefined) delete process.env['ENTRA_API_AUDIENCE'];
    else process.env['ENTRA_API_AUDIENCE'] = savedAudience;
  });

  function sign(claims: Record<string, unknown>, options: jwt.SignOptions = {}): string {
    return jwt.sign(claims, privatePem, {
      algorithm: 'RS256',
      audience: AUDIENCE,
      issuer: AUTHORITY,
      expiresIn: '10m',
      header: { kid: 'test-kid', alg: 'RS256' },
      ...options,
    });
  }

  it('emits missing_bearer when required auth has no bearer token', async () => {
    await expect(requireAuth(makeRequest({}))).rejects.toBeInstanceOf(AuthError);
    expect(mockTrackEvent).toHaveBeenCalledTimes(1);
    expect(mockTrackEvent).toHaveBeenCalledWith({
      name: 'auth.tokenRejected',
      properties: { reason: 'missing_bearer', authMode: 'required' },
      measurements: undefined,
    });
  });

  it('emits malformed when required auth has a non-bearer header', async () => {
    await expect(requireAuth(makeRequest({ Authorization: 'Basic abc' }))).rejects.toBeInstanceOf(
      AuthError,
    );
    expect(mockTrackEvent).toHaveBeenCalledTimes(1);
    expect(mockTrackEvent).toHaveBeenCalledWith({
      name: 'auth.tokenRejected',
      properties: { reason: 'malformed', authMode: 'required' },
      measurements: undefined,
    });
  });

  it('emits expired when required auth receives an expired token', async () => {
    const expiredToken = sign({ oid: 'oid-expired' }, { expiresIn: '-1h' });
    await expect(
      requireAuth(makeRequest({ Authorization: `Bearer ${expiredToken}` })),
    ).rejects.toBeInstanceOf(AuthError);
    expect(mockTrackEvent).toHaveBeenCalledTimes(1);
    expect(mockTrackEvent).toHaveBeenCalledWith({
      name: 'auth.tokenRejected',
      properties: { reason: 'expired', authMode: 'required' },
      measurements: undefined,
    });
  });

  it('emits invalid_signature when required auth receives a bad signature', async () => {
    const token = sign({ oid: 'oid-invalid-signature' });
    await expect(
      requireAuth(makeRequest({ Authorization: `Bearer ${token}X` })),
    ).rejects.toBeInstanceOf(AuthError);
    expect(mockTrackEvent).toHaveBeenCalledTimes(1);
    expect(mockTrackEvent).toHaveBeenCalledWith({
      name: 'auth.tokenRejected',
      properties: { reason: 'invalid_signature', authMode: 'required' },
      measurements: undefined,
    });
  });

  it('emits config_missing when required auth is not configured', async () => {
    const token = sign({ oid: 'oid-config-missing' });
    delete process.env['ENTRA_AUTHORITY'];
    await expect(
      requireAuth(makeRequest({ Authorization: `Bearer ${token}` })),
    ).rejects.toBeInstanceOf(AuthError);
    expect(mockTrackEvent).toHaveBeenCalledTimes(1);
    expect(mockTrackEvent).toHaveBeenCalledWith({
      name: 'auth.tokenRejected',
      properties: { reason: 'config_missing', authMode: 'required' },
      measurements: undefined,
    });
  });

  it('does not emit when optional auth rejects a token', async () => {
    const expiredToken = sign({ oid: 'oid-optional-expired' }, { expiresIn: '-1h' });
    const principal = await tryAuth(makeRequest({ Authorization: `Bearer ${expiredToken}` }));
    expect(principal).toBeNull();
    expect(mockTrackEvent).not.toHaveBeenCalled();
  });
});

describe('auth.tokenAccepted telemetry emission', () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
  });
  const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
  const publicPem = publicKey.export({ type: 'spki', format: 'pem' }) as string;

  let mockTrackEvent: jest.Mock;
  let savedAuthority: string | undefined;
  let savedAudience: string | undefined;

  beforeEach(() => {
    __resetTelemetryInitForTesting();
    mockTrackEvent = jest.fn();
    __setTelemetryClientForTestingT({ trackEvent: mockTrackEvent } as unknown as TelemetryClient);
    savedAuthority = process.env['ENTRA_AUTHORITY'];
    savedAudience = process.env['ENTRA_API_AUDIENCE'];
    process.env['ENTRA_AUTHORITY'] = AUTHORITY;
    process.env['ENTRA_API_AUDIENCE'] = AUDIENCE;
    __setJwksClientForTesting({
      getSigningKey: async () => ({
        getPublicKey: () => publicPem,
      }),
    });
  });

  afterEach(() => {
    __resetTelemetryInitForTesting();
    __setTelemetryClientForTestingT(null);
    __setJwksClientForTesting(null);
    if (savedAuthority === undefined) delete process.env['ENTRA_AUTHORITY'];
    else process.env['ENTRA_AUTHORITY'] = savedAuthority;
    if (savedAudience === undefined) delete process.env['ENTRA_API_AUDIENCE'];
    else process.env['ENTRA_API_AUDIENCE'] = savedAudience;
  });

  function sign(claims: Record<string, unknown>, options: jwt.SignOptions = {}): string {
    return jwt.sign(claims, privatePem, {
      algorithm: 'RS256',
      audience: AUDIENCE,
      issuer: AUTHORITY,
      expiresIn: '10m',
      header: { kid: 'test-kid', alg: 'RS256' },
      ...options,
    });
  }

  it('emits authMode=required when requireAuth verifies a valid token', async () => {
    const token = sign({ oid: 'oid-accepted-required' });
    const principal = await requireAuth(makeRequest({ Authorization: `Bearer ${token}` }));
    expect(principal.id).toBe('oid-accepted-required');
    expect(mockTrackEvent).toHaveBeenCalledTimes(1);
    expect(mockTrackEvent).toHaveBeenCalledWith({
      name: 'auth.tokenAccepted',
      properties: { authMode: 'required' },
      measurements: undefined,
    });
  });

  it('emits authMode=optional when tryAuth verifies a valid token', async () => {
    const token = sign({ oid: 'oid-accepted-optional' });
    const principal = await tryAuth(makeRequest({ Authorization: `Bearer ${token}` }));
    expect(principal?.id).toBe('oid-accepted-optional');
    expect(mockTrackEvent).toHaveBeenCalledTimes(1);
    expect(mockTrackEvent).toHaveBeenCalledWith({
      name: 'auth.tokenAccepted',
      properties: { authMode: 'optional' },
      measurements: undefined,
    });
  });

  it('does not emit auth.tokenAccepted when requireAuth rejects', async () => {
    await expect(requireAuth(makeRequest({}))).rejects.toBeInstanceOf(AuthError);
    expect(mockTrackEvent).toHaveBeenCalledTimes(1);
    expect(mockTrackEvent).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'auth.tokenRejected' }),
    );
    expect(mockTrackEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ name: 'auth.tokenAccepted' }),
    );
  });

  it('does not emit auth.tokenAccepted when tryAuth fails to verify', async () => {
    const expiredToken = sign({ oid: 'oid-tryauth-expired' }, { expiresIn: '-1h' });
    const principal = await tryAuth(makeRequest({ Authorization: `Bearer ${expiredToken}` }));
    expect(principal).toBeNull();
    expect(mockTrackEvent).not.toHaveBeenCalled();
  });
});
