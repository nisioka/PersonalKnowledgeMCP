/**
 * Runtime configuration and the token -> principal registry.
 *
 * Phase 1 runs on the LAN. Tokens map to a principal that carries the set of
 * scopes the caller may read and write. The server NEVER trusts a scope the
 * client asks for; it is always intersected with the principal's allowed set
 * (see auth/guard.ts).
 */
import { isScope, type Scope } from "./types.js";

export interface Principal {
  /** Human-readable identity, also used in audit logs: 'full' | 'work' | 'family' | ... */
  name: string;
  /** Scopes this principal may read AND write. `shared` is included for all. */
  scopes: Scope[];
  /** Scope used when register/update omit one explicitly. */
  defaultWriteScope: Scope;
}

export interface AppConfig {
  host: string;
  port: number;
  dbPath: string;
  /**
   * Passphrase for at-rest DB encryption (SQLCipher). Undefined => unencrypted.
   * Sourced from PK_DB_PASSPHRASE; the same value is needed by the backup CLI.
   */
  dbKey?: string;
  /** Bearer token -> principal. */
  tokens: Map<string, Principal>;
  /** True when falling back to built-in dev tokens (logged loudly). */
  usingDevTokens: boolean;
  /**
   * Cloudflare Access: authenticated email -> principal (design §7). Honored
   * only when `trustAccessHeader` is true (i.e. the server sits behind Access,
   * which strips/sets the Cf-Access-Authenticated-User-Email header).
   */
  accessEmails: Map<string, Principal>;
  /** Trust the Cf-Access-Authenticated-User-Email header. Default false. */
  trustAccessHeader: boolean;
  embedding: {
    /** Dimension of the vector column. Fixed at DB creation time. */
    dimension: number;
  };
}

/**
 * Built-in tokens used only when PK_TOKENS is not set. Safe for LAN-only Phase 1
 * bring-up; replace before exposing the server beyond the local network.
 */
const DEV_TOKENS: Record<string, Principal> = {
  "full-dev-token": { name: "full", scopes: ["private", "work", "shared"], defaultWriteScope: "private" },
  "work-dev-token": { name: "work", scopes: ["work", "shared"], defaultWriteScope: "work" },
  "family-dev-token": { name: "family", scopes: ["shared"], defaultWriteScope: "shared" },
};

interface RawPrincipal {
  name: string;
  scopes: string[];
  defaultWriteScope?: string;
}

/**
 * Parse PK_TOKENS, a JSON object of `{ "<token>": { name, scopes, defaultWriteScope? } }`.
 * `shared` is always added to every principal's scope set so shared knowledge is
 * naturally visible to everyone.
 */
function parseTokens(json: string): Map<string, Principal> {
  const parsed = JSON.parse(json) as Record<string, RawPrincipal>;
  const tokens = new Map<string, Principal>();
  for (const [token, raw] of Object.entries(parsed)) {
    if (!raw || typeof raw.name !== "string" || !Array.isArray(raw.scopes)) {
      throw new Error(`PK_TOKENS: invalid principal for a token (name/scopes required)`);
    }
    const scopeSet = new Set<Scope>(["shared"]);
    for (const s of raw.scopes) {
      if (!isScope(s)) throw new Error(`PK_TOKENS: unknown scope "${s}" for principal "${raw.name}"`);
      scopeSet.add(s);
    }
    const scopes = [...scopeSet];
    let defaultWriteScope: Scope = "shared";
    if (raw.defaultWriteScope !== undefined) {
      if (!isScope(raw.defaultWriteScope)) {
        throw new Error(`PK_TOKENS: unknown defaultWriteScope for principal "${raw.name}"`);
      }
      if (!scopeSet.has(raw.defaultWriteScope)) {
        throw new Error(`PK_TOKENS: defaultWriteScope not in scopes for principal "${raw.name}"`);
      }
      defaultWriteScope = raw.defaultWriteScope;
    } else {
      // Prefer the first non-shared scope as the natural write target.
      defaultWriteScope = scopes.find((s) => s !== "shared") ?? "shared";
    }
    tokens.set(token, { name: raw.name, scopes, defaultWriteScope });
  }
  if (tokens.size === 0) throw new Error("PK_TOKENS: no tokens defined");
  return tokens;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  // Fail closed: only a completely unset PK_TOKENS falls back to DEV tokens. An
  // empty/whitespace value (e.g. a failed secret injection) must NOT silently
  // bypass auth — it errors loudly.
  const rawTokens = env.PK_TOKENS;
  const usingDevTokens = rawTokens === undefined;
  if (rawTokens !== undefined && rawTokens.trim().length === 0) {
    throw new Error("PK_TOKENS is set but empty");
  }
  const tokens = usingDevTokens ? new Map(Object.entries(DEV_TOKENS)) : parseTokens(rawTokens);

  // PK_ACCESS_EMAILS reuses the same principal shape, keyed by email.
  const accessEmails = env.PK_ACCESS_EMAILS
    ? new Map(
        [...parseTokens(env.PK_ACCESS_EMAILS).entries()].map(([email, p]) => [email.toLowerCase(), p]),
      )
    : new Map<string, Principal>();

  const dimension = env.PK_EMBEDDING_DIM ? Number(env.PK_EMBEDDING_DIM) : 256;
  if (!Number.isInteger(dimension) || dimension <= 0) {
    throw new Error(`PK_EMBEDDING_DIM must be a positive integer, got "${env.PK_EMBEDDING_DIM}"`);
  }

  const port = env.PK_PORT ? Number(env.PK_PORT) : 8848;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`PK_PORT must be an integer between 1 and 65535, got "${env.PK_PORT}"`);
  }

  // Like PK_TOKENS: a set-but-empty value usually means a failed secret
  // injection — fail loudly rather than silently storing the DB unencrypted.
  const dbKey = env.PK_DB_PASSPHRASE;
  if (dbKey !== undefined && dbKey.trim().length === 0) {
    throw new Error("PK_DB_PASSPHRASE is set but empty");
  }

  return {
    // Default to loopback so an unconfigured server is not exposed by accident.
    // Set PK_HOST=0.0.0.0 to accept LAN connections (see design §5).
    host: env.PK_HOST ?? "127.0.0.1",
    port,
    dbPath: env.PK_DB_PATH ?? "data/knowledge.db",
    dbKey,
    tokens,
    usingDevTokens,
    accessEmails,
    trustAccessHeader: env.PK_TRUST_ACCESS_HEADER === "true",
    embedding: { dimension },
  };
}
