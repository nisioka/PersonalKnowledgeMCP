/**
 * Permission guard — the single choke point for scope authorization.
 *
 * Design §5: "scope is a data label; access is decided by the token." Every tool
 * routes scope decisions through here so that adding a new tool cannot
 * accidentally bypass authorization. The rules:
 *
 *   1. Validate the bearer token -> principal.
 *   2. Derive the allowed scope set from the principal.
 *   3. Intersect any client-requested scopes with the allowed set (drop the rest).
 *   4. Read filters ALWAYS include `shared` (shared knowledge is visible to all).
 *   5. Writes to a scope outside the allowed set are rejected.
 */
import type { Principal } from "../config.js";
import { isScope, type Scope } from "../types.js";

export class AuthError extends Error {
  constructor(
    message: string,
    /** 401 = unauthenticated, 403 = authenticated but not permitted. */
    readonly status: 401 | 403 = 401,
  ) {
    super(message);
    this.name = "AuthError";
  }
}

/** Extract the bearer token from an Authorization header value. */
export function parseBearer(authorization: string | undefined): string | null {
  if (!authorization) return null;
  const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
  return match ? (match[1] as string).trim() : null;
}

/** Resolve a token to a principal or throw AuthError(401). */
export function authenticate(token: string | null, tokens: Map<string, Principal>): Principal {
  if (!token) throw new AuthError("missing bearer token", 401);
  const principal = tokens.get(token);
  if (!principal) throw new AuthError("invalid token", 401);
  return principal;
}

/**
 * Compute the scope set to use in a read query.
 *
 * `shared` (when allowed) is always included. If the caller requested specific
 * scopes, they are intersected with the allowed set; anything outside is
 * silently dropped rather than erroring, matching "the client's requested scope
 * is not trusted".
 */
export function resolveReadScopes(principal: Principal, requested?: Scope[]): Scope[] {
  const allowed = new Set(principal.scopes);
  let effective: Set<Scope>;
  if (requested && requested.length > 0) {
    effective = new Set(requested.filter((s) => allowed.has(s)));
    // An explicit request naming only forbidden scopes is a hard 403 — we do not
    // silently substitute shared for data the caller deliberately asked to see.
    if (effective.size === 0) throw new AuthError("no readable scope in request", 403);
  } else {
    effective = new Set(allowed);
  }
  // shared knowledge is visible to everyone whose token permits it (design §5).
  if (allowed.has("shared")) effective.add("shared");
  return [...effective];
}

/**
 * Resolve and authorize the scope a write should target.
 * Falls back to the principal's default write scope when none is given.
 */
export function resolveWriteScope(principal: Principal, requested?: Scope | null): Scope {
  const target = requested ?? principal.defaultWriteScope;
  if (!isScope(target)) throw new AuthError(`invalid scope "${target}"`, 403);
  if (!principal.scopes.includes(target)) {
    throw new AuthError(`not permitted to write scope "${target}"`, 403);
  }
  return target;
}
