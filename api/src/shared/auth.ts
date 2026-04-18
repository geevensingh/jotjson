/**
 * Azure Static Web Apps injects the authenticated principal into the
 * `x-ms-client-principal` request header (base64-encoded JSON).
 * See: https://learn.microsoft.com/azure/static-web-apps/user-information
 */
import type { HttpRequest } from '@azure/functions';

export interface ClientPrincipal {
  identityProvider: string;
  userId: string;
  userDetails: string;
  userRoles: string[];
  claims?: { typ: string; val: string }[];
}

export function getClientPrincipal(req: HttpRequest): ClientPrincipal | null {
  const header = req.headers.get('x-ms-client-principal');
  if (!header) return null;
  try {
    const decoded = Buffer.from(header, 'base64').toString('utf8');
    return JSON.parse(decoded) as ClientPrincipal;
  } catch {
    return null;
  }
}

export function requireUser(req: HttpRequest): ClientPrincipal {
  const principal = getClientPrincipal(req);
  if (!principal) {
    const err = new Error('Unauthenticated');
    (err as Error & { statusCode?: number }).statusCode = 401;
    throw err;
  }
  return principal;
}
