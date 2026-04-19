import { generateKeyPairSync } from 'node:crypto';
import * as jwt from 'jsonwebtoken';
import type { HttpRequest } from '@azure/functions';
import {
  AuthError,
  __setJwksClientForTesting,
  requireAuth,
  verifyAccessToken
} from './auth';

const AUTHORITY = 'https://example.ciamlogin.com/tenant-1';
const AUDIENCE = 'api://test-api-client-id';

function makeRequest(headers: Record<string, string> = {}): HttpRequest {
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  return {
    headers: {
      get: (name: string): string | null => lower[name.toLowerCase()] ?? null
    }
  } as unknown as HttpRequest;
}

describe('shared/auth Entra JWT validation', () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048
  });
  const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
  const publicPem = publicKey.export({ type: 'spki', format: 'pem' }) as string;

  beforeAll(() => {
    process.env.ENTRA_AUTHORITY = AUTHORITY;
    process.env.ENTRA_API_AUDIENCE = AUDIENCE;
    __setJwksClientForTesting({
      getSigningKey: async () => ({
        getPublicKey: () => publicPem
      })
    });
  });

  afterAll(() => {
    __setJwksClientForTesting(null);
    delete process.env.ENTRA_AUTHORITY;
    delete process.env.ENTRA_API_AUDIENCE;
  });

  function sign(
    claims: Record<string, unknown>,
    opts: jwt.SignOptions = {}
  ): string {
    return jwt.sign(claims, privatePem, {
      algorithm: 'RS256',
      audience: AUDIENCE,
      issuer: AUTHORITY,
      expiresIn: '10m',
      header: { kid: 'test-kid', alg: 'RS256' },
      ...opts
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
      modulusLength: 2048
    });
    const otherPem = otherKey.export({ type: 'pkcs8', format: 'pem' }) as string;
    const token = jwt.sign({ oid: 'oid-1' }, otherPem, {
      algorithm: 'RS256',
      audience: AUDIENCE,
      issuer: AUTHORITY,
      expiresIn: '10m',
      header: { kid: 'test-kid', alg: 'RS256' }
    });
    await expect(verifyAccessToken(token)).rejects.toBeInstanceOf(AuthError);
  });

  it('rejects a token with no kid', async () => {
    const token = jwt.sign({ oid: 'oid-1' }, privatePem, {
      algorithm: 'RS256',
      audience: AUDIENCE,
      issuer: AUTHORITY,
      expiresIn: '10m'
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
      const principal = await requireAuth(
        makeRequest({ Authorization: `Bearer ${token}` })
      );
      expect(principal.id).toBe('oid-1');
    });

    it('rejects a request with no Authorization header', async () => {
      await expect(requireAuth(makeRequest({}))).rejects.toBeInstanceOf(AuthError);
    });

    it('rejects a request with a non-bearer Authorization scheme', async () => {
      await expect(
        requireAuth(makeRequest({ Authorization: 'Basic abc' }))
      ).rejects.toBeInstanceOf(AuthError);
    });
  });
});
