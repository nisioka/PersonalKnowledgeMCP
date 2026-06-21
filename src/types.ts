/**
 * Core domain types shared across the knowledge base.
 *
 * The design keeps a single physical store and separates access logically by
 * `scope`. A document always pairs raw data (`rawPath` / `fullText`) with
 * extracted metadata (`extracted` JSON) so extraction rules can be grown later
 * without breaking existing rows.
 */

/** Sentinel used for "no expiry" so the search filter can stay a single
 *  `valid_until >= today` comparison instead of juggling NULLs. */
export const NO_EXPIRY = "9999-12-31";

export const SCOPES = ["private", "work", "shared"] as const;
export type Scope = (typeof SCOPES)[number];

export function isScope(value: unknown): value is Scope {
  return typeof value === "string" && (SCOPES as readonly string[]).includes(value);
}

/** A document as stored in the `documents` table. */
export interface DocumentRow {
  id: number;
  source_type: string;
  raw_path: string | null;
  full_text: string;
  doc_type: string | null;
  /** Parsed `extracted` JSON. Stored as TEXT in SQLite. */
  extracted: Record<string, unknown>;
  scope: Scope;
  /** `YYYY-MM-DD`. `NO_EXPIRY` means no expiry. */
  valid_until: string;
  deleted: boolean;
  /** Loose name-matching key used to supersede prior versions (§9.1). */
  dedup_key: string | null;
  created_at: string;
}

/** Input accepted by the `register` tool / store function. */
export interface RegisterInput {
  full_text: string;
  source_type?: string;
  raw_path?: string | null;
  doc_type?: string | null;
  extracted?: Record<string, unknown>;
  /** Requested scope. Validated against the caller's token before use. */
  scope?: Scope;
  valid_until?: string;
  /**
   * Loose key identifying the logical document. When set on a non-history
   * doc_type, prior entries with the same scope/doc_type/dedup_key are
   * superseded (soft-deleted) unless `supersede` is false (§9.1).
   */
  dedup_key?: string | null;
  /** Override automatic superseding. Default: supersede when dedup_key is set. */
  supersede?: boolean;
}

/** Result of a register: the new doc plus any superseded prior versions. */
export interface RegisterResult {
  document: DocumentRow;
  superseded: number[];
}

/** Fields an `update` may change. All optional; omitted fields are unchanged. */
export interface UpdatePatch {
  full_text?: string;
  source_type?: string;
  raw_path?: string | null;
  doc_type?: string | null;
  extracted?: Record<string, unknown>;
  scope?: Scope;
  valid_until?: string;
  deleted?: boolean;
  dedup_key?: string | null;
}

/** A document approaching expiry, for the proactive reminder cron (§4 / Phase 4). */
export interface UpcomingExpiry {
  id: number;
  doc_type: string | null;
  scope: Scope;
  valid_until: string;
  snippet: string;
  days_left: number;
}

export type SearchMode = "keyword" | "vector" | "hybrid";

export interface SearchParams {
  query: string;
  mode?: SearchMode;
  /** Requested scope filter. Intersected with the token's allowed scopes. */
  scopes?: Scope[];
  doc_type?: string;
  /** Drop the `valid_until >= today` filter for history lookups. */
  include_expired?: boolean;
  limit?: number;
}

export interface SearchHit {
  id: number;
  source_type: string;
  raw_path: string | null;
  doc_type: string | null;
  scope: Scope;
  valid_until: string;
  created_at: string;
  /** Combined relevance score; higher is better. */
  score: number;
  /** Excerpt of `full_text`. */
  snippet: string;
  extracted: Record<string, unknown>;
}
