/**
 * Entra External ID JWT validation for incoming API requests.
 *
 * MSAL in the browser obtains an access token scoped to the API app
 * registration (e.g. `api://<apiClientId>/access_as_user`). Functions
 * validate those tokens here before exposing user-scoped data.
 *
 * Configuration via environment variables (all required for live checks):
 * - ENTRA_AUTHORITY - e.g. `https://<subdomain>.ciamlogin.com/<tenantId>/`
 * - ENTRA_API_AUDIENCE - the API application's client id or App ID URI
 *
 * If either is empty the middleware returns 401 for protected calls rather
 * than silently bypassing validation.
 */
import type { HttpRequest } from '@azure/functions';
import type { GetPublicKeyOrSecret, JwtPayload } from 'jsonwebtoken';
import * as jwt from 'jsonwebtoken';
// Pinned to jwks-rsa v3.x. v4 upgrades to jose v6, which is ESM-only
// (no CJS dist). Jest's vm.Script runtime cannot parse `export` syntax,
// so any test suite that transitively imports this module fails to
// parse. Revisit when Jest stabilizes require(esm) without
// --experimental-vm-modules, or jose republishes a CJS build. The major
// is blocked from Dependabot in .github/dependabot.yml.
import jwksClient from 'jwks-rsa';
import { trackEvent } from './telemetry';

export type AuthRejectReason =
  | 'missing_bearer'
  | 'malformed'
  | 'expired'
  | 'invalid_signature'
  | 'config_missing';

export interface AuthenticatedPrincipal {
  /** Stable Entra object id - `oid` claim, falling back to `sub`. */
  id: string;
  /** Display name - `name` claim if present. */
  displayName?: string;
  /** Email - `email` or `preferred_username`. */
  email?: string;
  /** Raw validated JWT payload, for callers that need additional claims. */
  claims: JwtPayload;
}

export class AuthError extends Error {
  readonly statusCode = 401;
  readonly reason: AuthRejectReason | undefined;
  constructor(message: string, reason?: AuthRejectReason) {
    super(message);
    this.name = 'AuthError';
    this.reason = reason;
  }
}

function getAuthority(): string {
  return (process.env['ENTRA_AUTHORITY'] ?? '').trim().replace(/\/+$/, '');
}

/**
 * Local-only dev-auth bypass. Engaged only when:
 *
 * - `JOTJSON_DEV_AUTH_BYPASS=true` is set in the Functions process env, AND
 * - `WEBSITE_INSTANCE_ID` is unset (Azure App Service / Functions / Static
 *   Web Apps always set this; Azure Functions Core Tools never sets it
 *   locally), AND
 * - `WEBSITE_HOSTNAME` is either unset or matches `localhost(:<port>)?`.
 *   Azure Functions Core Tools 4.x sets `WEBSITE_HOSTNAME=localhost:7071`
 *   on a developer workstation, so the mere presence of this var is not
 *   an Azure indicator; we only reject Azure-shaped values like
 *   `<site>.azurewebsites.net` or custom domains.
 *
 * The two `WEBSITE_*` guards mean a leaked `JOTJSON_DEV_AUTH_BYPASS=true`
 * value cannot engage the bypass in any Azure-hosted environment. This is
 * defense-in-depth: the env var alone should be enough, but the platform
 * indicators provide a second independent check.
 *
 * When engaged, `verifyAccessToken` accepts the synthetic token form
 * `dev:<userId>` (where `userId` matches `^[a-z0-9_-]{1,64}$`) and
 * synthesizes an `AuthenticatedPrincipal` for it. Any token that does not
 * match the dev shape continues through normal Entra JWT validation, so
 * real tokens are never silently accepted on a misconfigured local box.
 */
const LOCALHOST_HOSTNAME_RE = /^localhost(:\d+)?$/i;
export function isDevAuthBypassEnabled(): boolean {
  if (process.env['JOTJSON_DEV_AUTH_BYPASS'] !== 'true') return false;
  if (process.env['WEBSITE_INSTANCE_ID']) return false;
  const hostname = process.env['WEBSITE_HOSTNAME'];
  if (hostname && !LOCALHOST_HOSTNAME_RE.test(hostname)) return false;
  return true;
}

const DEV_TOKEN_RE = /^dev:([a-z0-9_-]{1,64})$/;
let devAuthWarnEmitted = false;

function emitDevAuthWarnOnce(): void {
  if (devAuthWarnEmitted) return;
  devAuthWarnEmitted = true;
  console.warn(
    '[auth] JOTJSON_DEV_AUTH_BYPASS is enabled. ' +
      'Synthetic dev:<userId> tokens are being accepted on this process. ' +
      'This must never run in production.',
  );
}

/**
 * Test seam: resets the module-level dedupe so that tests can verify
 * the one-time warning behavior across multiple cases. Production code
 * must never call this.
 */
export function __resetDevAuthWarnForTesting(): void {
  devAuthWarnEmitted = false;
}

/**
 * Returns a synthesized principal for a `dev:<userId>` token when the
 * bypass is enabled, or `null` otherwise. Caller is responsible for
 * dispatching real JWTs to `verifyAccessToken`'s normal path when this
 * helper returns `null`.
 */
export function tryDevAuthToken(token: string): AuthenticatedPrincipal | null {
  if (!isDevAuthBypassEnabled()) return null;
  const match = DEV_TOKEN_RE.exec(token);
  if (!match) return null;
  emitDevAuthWarnOnce();
  const userId = match[1];
  const displayName = `Dev User (${userId})`;
  const email = `${userId}@dev.local`;
  return {
    id: userId,
    displayName,
    email,
    claims: {
      oid: userId,
      sub: userId,
      name: displayName,
      preferred_username: email,
      email,
    } as JwtPayload,
  };
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
  const lib = jwksClient({
    jwksUri: buildJwksUri(authority),
    cache: true,
    cacheMaxEntries: 5,
    cacheMaxAge: 10 * 60 * 1000,
    rateLimit: true,
    jwksRequestsPerMinute: 10,
  });
  // Wrap the library client in a narrow adapter so callers see only the
  // single overload of `getSigningKey` that we actually use. The library's
  // overloaded callback/promise signatures don't structurally match
  // `JwksClientLike` directly.
  cachedClient = {
    getSigningKey: (kid: string) => lib.getSigningKey(kid),
  };
  return cachedClient;
}

/**
 * Injectable hook for tests - swap in a fake JWKS client without touching
 * the network. Production code never calls this.
 */
export function __setJwksClientForTesting(client: JwksClientLike | null): void {
  testOverrideClient = client;
}

function getKey(authority: string): GetPublicKeyOrSecret {
  return (header, callback) => {
    if (!header.kid) {
      callback(new AuthError('Missing kid'));
      return;
    }
    getJwksClient(authority)
      .getSigningKey(header.kid)
      .then((key) => callback(null, key.getPublicKey()))
      .catch((error: unknown) =>
        callback(error instanceof Error ? error : new Error('JWKS lookup failed')),
      );
  };
}

type BearerTokenResult =
  | { kind: 'absent' }
  | { kind: 'malformed' }
  | { kind: 'token'; token: string };

function extractBearerToken(req: HttpRequest): BearerTokenResult {
  const custom =
    req.headers.get('x-jotjson-authorization') ?? req.headers.get('X-Jotjson-Authorization');
  const fallback = req.headers.get('authorization') ?? req.headers.get('Authorization');
  const header = custom ?? fallback;
  if (!header) return { kind: 'absent' };
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match) return { kind: 'malformed' };
  return { kind: 'token', token: match[1] };
}

export async function verifyAccessToken(token: string): Promise<AuthenticatedPrincipal> {
  const devPrincipal = tryDevAuthToken(token);
  if (devPrincipal) return devPrincipal;
  const authority = getAuthority();
  const audiences = getAcceptedAudiences();
  const issuers = getAcceptedIssuers(authority);
  if (!authority || !audiences || !issuers) {
    throw new AuthError('Auth not configured', 'config_missing');
  }
  const payload = await new Promise<JwtPayload>((resolve, reject) => {
    jwt.verify(
      token,
      getKey(authority),
      {
        audience: audiences,
        issuer: issuers,
        algorithms: ['RS256'],
      },
      (error, decoded) => {
        if (error) {
          return reject(
            new AuthError(
              error.message,
              error.name === 'TokenExpiredError' ? 'expired' : 'invalid_signature',
            ),
          );
        }
        if (!decoded || typeof decoded === 'string') {
          return reject(new AuthError('Invalid token payload', 'invalid_signature'));
        }
        resolve(decoded as JwtPayload);
      },
    );
  });

  const claims = payload as JwtPayload & {
    oid?: string;
    name?: string;
    email?: string;
    preferred_username?: string;
  };
  const id = claims.oid || claims.sub;
  if (!id) throw new AuthError('Token missing subject', 'invalid_signature');
  return {
    id,
    displayName: claims.name,
    email: claims.email || claims.preferred_username,
    claims,
  };
}

/**
 * Middleware-style helper for Functions routes. Call at the top of a
 * handler that should only execute for signed-in users.
 *
 * NOTE: Not wired to any route in M3a - lives ready for M4's blob CRUD.
 */
export async function requireAuth(req: HttpRequest): Promise<AuthenticatedPrincipal> {
  const result = extractBearerToken(req);
  if (result.kind === 'absent') {
    trackEvent('auth.tokenRejected', { reason: 'missing_bearer', authMode: 'required' });
    throw new AuthError('Missing bearer token', 'missing_bearer');
  }
  if (result.kind === 'malformed') {
    trackEvent('auth.tokenRejected', { reason: 'malformed', authMode: 'required' });
    throw new AuthError('Malformed bearer header', 'malformed');
  }
  try {
    const principal = await verifyAccessToken(result.token);
    trackEvent('auth.tokenAccepted', { authMode: 'required' });
    return principal;
  } catch (error) {
    if (error instanceof AuthError && error.reason) {
      trackEvent('auth.tokenRejected', { reason: error.reason, authMode: 'required' });
    }
    throw error;
  }
}

/**
 * Best-effort auth: returns the principal when the request carries a valid
 * bearer token, or `null` when there is no token / the token is invalid.
 * Used by routes that are publicly readable (e.g. GET /api/blobs/{slug}) but
 * still want to identify the caller for side effects like history logging.
 * Token-validation failures are swallowed so anonymous callers are never
 * 401'd by accident; non-AuthError exceptions still propagate so genuine
 * infrastructure problems are surfaced.
 */
export async function tryAuth(req: HttpRequest): Promise<AuthenticatedPrincipal | null> {
  const result = extractBearerToken(req);
  if (result.kind !== 'token') return null;
  try {
    const principal = await verifyAccessToken(result.token);
    trackEvent('auth.tokenAccepted', { authMode: 'optional' });
    return principal;
  } catch (error) {
    if (error instanceof AuthError) return null;
    throw error;
  }
}

// Re-exports retained for any pre-existing imports. Both SWA's x-ms-client-
// principal and Entra JWT models are now valid code paths; the SWA path is
// legacy and should not be used for new routes.
export type { JwtPayload };
