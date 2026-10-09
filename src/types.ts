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

/**
 * Lifecycle of a document (design §9.5). This — not `doc_type` — is the sole
 * property that governs system behavior: `singleton` documents are superseded by
 * a newer version sharing scope/doc_type/dedup_key; `history` documents are never
 * auto-superseded (every version is kept). Stored per-document and overridable.
 */
export const LIFECYCLES = ["singleton", "history"] as const;
export type Lifecycle = (typeof LIFECYCLES)[number];

export function isLifecycle(value: unknown): value is Lifecycle {
  return typeof value === "string" && (LIFECYCLES as readonly string[]).includes(value);
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
  /** Behavior facet (§9.5). Governs superseding; independent of doc_type. */
  lifecycle: Lifecycle;
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
  /** Semantic label; must be null or a known vocabulary entry (§9.5). */
  doc_type?: string | null;
  /**
   * Behavior facet. Defaults to the doc_type's `default_lifecycle` when a known
   * type is given, else `singleton`. Overridable per document.
   */
  lifecycle?: Lifecycle;
  extracted?: Record<string, unknown>;
  /** Requested scope. Validated against the caller's token before use. */
  scope?: Scope;
  valid_until?: string;
  /**
   * Loose key identifying the logical document. When set on a `singleton`
   * document, prior entries with the same scope/doc_type/dedup_key are
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
  lifecycle?: Lifecycle;
  extracted?: Record<string, unknown>;
  scope?: Scope;
  valid_until?: string;
  deleted?: boolean;
  dedup_key?: string | null;
}

/** A doc_type vocabulary entry (§9.5). Persisted in the `doc_types` table. */
export interface DocTypeSpec {
  /** Canonical name (primary key). */
  name: string;
  /** Human description, also fed to the extraction prompt. */
  description: string;
  /**
   * Advisory default lifecycle used to prefill `register` when the caller omits
   * it. Never enforced — enforcement always reads the document's own lifecycle.
   */
  default_lifecycle: Lifecycle;
  /** Advisory hint for how `valid_until` should be estimated during extraction. */
  expiry_hint: string;
  /** Provenance: 'builtin' (seeded) or 'user' (created via upsert_doc_type). */
  source: "builtin" | "user";
  created_at: string;
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

/**
 * Kind of a date found in a document: `event` (行事・予定), `deadline`
 * (締切・提出), `expiry` (満了・有効期限).
 */
export const DATE_KINDS = ["event", "deadline", "expiry"] as const;
export type DateKind = (typeof DATE_KINDS)[number];

/**
 * Review state of a `doc_dates` row. Dates are extracted as candidates
 * (`pending`) and confirmed (`approved`) or dismissed (`rejected`) by a human.
 */
export const REVIEW_STATUSES = ["pending", "approved", "rejected"] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

/** Where a `doc_dates` row came from: `extracted.dates` or the document's `valid_until`. */
export type DateSource = "extracted" | "valid_until";

/** One entry of `extracted.dates`, as written by the extraction prompt. */
export interface ExtractedDate {
  /** `YYYY-MM-DD`. */
  date: string;
  kind: DateKind;
  /** Subject line, shown as-is in notifications. */
  title: string;
}

export interface UpcomingParams {
  /** First day (inclusive), `YYYY-MM-DD`. Default: today. */
  from?: string;
  /** Last day (inclusive), `YYYY-MM-DD`. Default: 10 days after `from`. */
  to?: string;
  /** Requested scope filter. Intersected with the token's allowed scopes. */
  scopes?: Scope[];
}

/** A row of the `upcoming` digest. Deliberately excludes `extracted`. */
export interface UpcomingDate {
  date: string;
  kind: DateKind;
  title: string;
  review_status: ReviewStatus;
  doc_id: number;
  scope: Scope;
}

export interface PendingParams {
  scopes?: Scope[];
  /** Max number of documents (not items) to return. */
  limit?: number;
  /** Restrict to a single document. */
  doc_id?: number;
}

export interface PendingDate {
  /** `doc_dates.id` — pass to `review_dates.reject_ids`. */
  id: number;
  date: string;
  kind: DateKind;
  title: string;
}

/** A document with dates awaiting review, with all of its pending items. */
export interface PendingDocument {
  doc_id: number;
  title: string;
  doc_type: string | null;
  scope: Scope;
  items: PendingDate[];
}

export interface PendingResult {
  documents: PendingDocument[];
  /** Number of documents with pending dates from today on, before `limit` was applied. */
  total_documents: number;
}

export interface ReviewInput {
  /** Approve every still-pending date of the document from today on (after rejections). */
  approve_all?: boolean;
  /** `doc_dates.id`s to reject. Must belong to the document. */
  reject_ids?: number[];
}

export interface ReviewResult {
  doc_id: number;
  /** Ids approved by this call. */
  approved: number[];
  /** Ids rejected by this call. */
  rejected: number[];
  /** Dates of the document from today on that are still pending afterwards. */
  pending: number;
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
  /** Leave `full_text` out of the hits, for broad listings where the excerpt is enough. */
  snippet_only?: boolean;
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
  /** The whole text. Absent when the search asked for `snippet_only`. */
  full_text?: string;
  extracted: Record<string, unknown>;
}
