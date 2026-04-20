/**
 * Entra External ID JWT validation for incoming API requests.
 *
 * MSAL in the browser obtains an access token scoped to the API app
 * registration (e.g. `api://<apiClientId>/access_as_user`). Functions
 * validate those tokens here before exposing user-scoped data.
 *
 * Configuration via environment variables (all required for live checks):
 * - ENTRA_AUTHORITY — e.g. `https://<subdomain>.ciamlogin.com/<tenantId>/`
 * - ENTRA_API_AUDIENCE — the API application's client id or App ID URI
 *
 * If either is empty the middleware returns 401 for protected calls rather
 * than silently bypassing validation.
 */
import type { HttpRequest } from '@azure/functions';
import * as jwt from 'jsonwebtoken';
import type { GetPublicKeyOrSecret, JwtPayload } from 'jsonwebtoken';
import jwksClient from 'jwks-rsa';

export interface AuthenticatedPrincipal {
  /** Stable Entra object id — `oid` claim, falling back to `sub`. */
  id: string;
  /** Display name — `name` claim if present. */
  displayName?: string;
  /** Email — `email` or `preferred_username`. */
  email?: string;
  /** Raw validated JWT payload, for callers that need additional claims. */
  claims: JwtPayload;
}

export class AuthError extends Error {
  readonly statusCode = 401;
  constructor(message: string) {
    super(message);
    this.name = 'AuthError';
  }
}

function getAuthority(): string {
  return (process.env['ENTRA_AUTHORITY'] ?? '').trim().replace(/\/+$/, '');
}

/**
 * Entra External ID may issue access tokens whose `iss` claim uses the
 * tenant GUID subdomain (e.g. `https://<tenantId>.ciamlogin.com/...`) even
 * when the configured authority uses a vanity subdomain
 * (e.g. `https://<name>.ciamlogin.com/...`). Accept both forms, with and
 * without the `/v2.0` suffix, so validation works regardless of which
 * subdomain Entra picks when signing the token.
 */
function getAcceptedIssuers(authority: string): [string, ...string[]] | null {
  if (!authority) return null;
  const accepted = new Set<string>([authority, `${authority}/v2.0`]);
  const match = /^(https:\/\/)([^/]+)\.ciamlogin\.com\/([^/]+)(.*)$/i.exec(authority);
  if (match) {
    const [, scheme, , tenantId, rest] = match;
    const tenantHostAuthority = `${scheme}${tenantId}.ciamlogin.com/${tenantId}${rest}`;
    accepted.add(tenantHostAuthority);
    accepted.add(`${tenantHostAuthority}/v2.0`);
  }
  const [first, ...tail] = [...accepted];
  return [first, ...tail];
}

function getAudience(): string {
  return (process.env['ENTRA_API_AUDIENCE'] ?? '').trim();
}

/**
 * Entra v2.0 access tokens set `aud` to the API application's client id
 * (a bare GUID), while v1.0 tokens use the App ID URI (`api://<guid>`).
 * Accept both forms so the same configured audience works across tenants
 * regardless of which token version Entra emits.
 */
function getAcceptedAudiences(): [string, ...string[]] | null {
  const configured = getAudience();
  if (!configured) return null;
  const accepted = new Set<string>([configured]);
  const apiUriMatch = /^api:\/\/(.+)$/i.exec(configured);
  if (apiUriMatch) {
    accepted.add(apiUriMatch[1]);
  } else {
    accepted.add(`api://${configured}`);
  }
  const [first, ...rest] = [...accepted];
  return [first, ...rest];
}

/**
 * Resolves the JWKS URI from the authority. Entra publishes the OpenID
 * configuration at `<authority>/.well-known/openid-configuration`; this
 * helper hard-codes the canonical keys endpoint, which avoids a second
 * fetch for each cold-start token validation. The `jwks-rsa` client caches
 * fetched keys in-memory for subsequent calls.
 */
function buildJwksUri(authority: string): string {
  return `${authority}/discovery/v2.0/keys`;
}

type JwksClientLike = { getSigningKey: (kid: string) => Promise<{ getPublicKey: () => string }> };

let cachedClient: JwksClientLike | null = null;
let cachedAuthority = '';
let testOverrideClient: JwksClientLike | null = null;

function getJwksClient(authority: string): JwksClientLike {
  if (testOverrideClient) return testOverrideClient;
  if (cachedClient && cachedAuthority === authority) return cachedClient;
  cachedAuthority = authority;
  cachedClient = jwksClient({
    jwksUri: buildJwksUri(authority),
    cache: true,
    cacheMaxEntries: 5,
    cacheMaxAge: 10 * 60 * 1000,
    rateLimit: true,
    jwksRequestsPerMinute: 10
  }) as unknown as JwksClientLike;
  return cachedClient;
}

/**
 * Injectable hook for tests — swap in a fake JWKS client without touching
 * the network. Production code never calls this.
 */
export function __setJwksClientForTesting(client: JwksClientLike | null): void {
  testOverrideClient = client;
}

function getKey(authority: string): GetPublicKeyOrSecret {
  return (header, callback) => {
    if (!header.kid) {
      callback(new AuthError(`Missing kid (header=${JSON.stringify(header)})`));
      return;
    }
    getJwksClient(authority)
      .getSigningKey(header.kid)
      .then((key) => callback(null, key.getPublicKey()))
      .catch((err: unknown) =>
        callback(err instanceof Error ? err : new Error('JWKS lookup failed'))
      );
  };
}

function extractBearerToken(req: HttpRequest): string | null {
  const header = req.headers.get('authorization') ?? req.headers.get('Authorization');
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1] : null;
}

export async function verifyAccessToken(token: string): Promise<AuthenticatedPrincipal> {
  const authority = getAuthority();
  const audiences = getAcceptedAudiences();
  const issuers = getAcceptedIssuers(authority);
  if (!authority || !audiences || !issuers) {
    throw new AuthError('Auth not configured');
  }
  const payload = await new Promise<JwtPayload>((resolve, reject) => {
    jwt.verify(
      token,
      getKey(authority),
      {
        audience: audiences,
        issuer: issuers,
        algorithms: ['RS256']
      },
      (err, decoded) => {
        if (err) return reject(new AuthError(err.message));
        if (!decoded || typeof decoded === 'string') {
          return reject(new AuthError('Invalid token payload'));
        }
        resolve(decoded as JwtPayload);
      }
    );
  });

  const claims = payload as JwtPayload & {
    oid?: string;
    name?: string;
    email?: string;
    preferred_username?: string;
  };
  const id = claims.oid || claims.sub;
  if (!id) throw new AuthError('Token missing subject');
  return {
    id,
    displayName: claims.name,
    email: claims.email || claims.preferred_username,
    claims
  };
}

/**
 * Middleware-style helper for Functions routes. Call at the top of a
 * handler that should only execute for signed-in users.
 *
 * NOTE: Not wired to any route in M3a — lives ready for M4's blob CRUD.
 */
export async function requireAuth(req: HttpRequest): Promise<AuthenticatedPrincipal> {
  const token = extractBearerToken(req);
  if (!token) throw new AuthError('Missing bearer token');
  return verifyAccessToken(token);
}

// Re-exports retained for any pre-existing imports. Both SWA's x-ms-client-
// principal and Entra JWT models are now valid code paths; the SWA path is
// legacy and should not be used for new routes.
export type { JwtPayload };
