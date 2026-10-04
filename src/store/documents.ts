/**
 * Document store: the only place that reads/writes the `documents` table and
 * its derived `doc_dates` rows.
 *
 * Every operation routes scope decisions through auth/guard so authorization
 * cannot be bypassed, and search always applies the default lifecycle filter
 * (design §4): `deleted = 0 AND valid_until >= today`.
 */
import type { Principal } from "../config.js";
import type { DB } from "../db/index.js";
import type { Embedder } from "../embedding.js";
import { DocTypeRegistry } from "../doctype/registry.js";
import { resolveReadScopes, resolveWriteScope } from "../auth/guard.js";
import {
  documentTitle,
  isValidYmd,
  parseExtractedDates,
  parseExtractedJson,
  syncDocDates,
} from "./doc-dates.js";
import {
  NO_EXPIRY,
  isLifecycle,
  type DocumentRow,
  type Lifecycle,
  type PendingDate,
  type PendingDocument,
  type PendingParams,
  type PendingResult,
  type RegisterInput,
  type RegisterResult,
  type ReviewInput,
  type ReviewResult,
  type ReviewStatus,
  type Scope,
  type SearchHit,
  type SearchMode,
  type SearchParams,
  type UpcomingDate,
  type UpcomingExpiry,
  type UpcomingParams,
  type UpdatePatch,
} from "../types.js";

export class NotFoundError extends Error {
  constructor(message = "document not found or not accessible") {
    super(message);
    this.name = "NotFoundError";
  }
}

const SNIPPET_LEN = 600;
/** Fallback label length when a document has no title to show in `list_pending`. */
const TITLE_SNIPPET_LEN = 40;
/** `upcoming` looks this many days ahead when `to` is omitted. */
const UPCOMING_DEFAULT_DAYS = 10;

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

/** Local-time `YYYY-MM-DD`. Exposed for callers/tests that need "today". */
export function todayLocal(d: Date = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** `days` after a `YYYY-MM-DD` date, as `YYYY-MM-DD`. */
function addDays(ymd: string, days: number): string {
  const [y, m, d] = ymd.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** Reject malformed `extracted.dates` on the way in, so the caller can fix them. */
function assertValidDates(extracted: Record<string, unknown>): void {
  const { problems } = parseExtractedDates(extracted);
  if (problems.length > 0) throw new ValidationError(problems.join("; "));
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function toSnippet(fullText: string): string {
  const oneLine = fullText.replace(/\s+/g, " ").trim();
  return oneLine.length > SNIPPET_LEN ? oneLine.slice(0, SNIPPET_LEN) + "…" : oneLine;
}

/** Serialize a Float32Array to a little-endian BLOB for sqlite-vec. */
function vecBlob(vec: Float32Array): Buffer {
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}

/** Build an FTS5 MATCH expression that won't throw on punctuation. */
function ftsQuery(query: string): string {
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.replace(/"/g, ""))
    .filter((t) => t.length > 0)
    .map((t) => `"${t}"`);
  // OR favors recall for a small personal KB; ranking sorts the rest out.
  return terms.join(" OR ");
}

interface RawDocRow {
  id: number;
  source_type: string;
  raw_path: string | null;
  full_text: string;
  doc_type: string | null;
  lifecycle: string;
  extracted: string;
  scope: string;
  valid_until: string;
  deleted: number;
  dedup_key: string | null;
  created_at: string;
}

/** Convert a raw `documents` row (JSON as text, flags as integers) to a DocumentRow. */
function parseRow(raw: RawDocRow): DocumentRow {
  return {
    id: raw.id,
    source_type: raw.source_type,
    raw_path: raw.raw_path,
    full_text: raw.full_text,
    doc_type: raw.doc_type,
    lifecycle: raw.lifecycle as Lifecycle,
    extracted: parseExtractedJson(raw.extracted),
    scope: raw.scope as Scope,
    valid_until: raw.valid_until,
    deleted: raw.deleted !== 0,
    dedup_key: raw.dedup_key,
    created_at: raw.created_at,
  };
}

/** Shape a matched row as a search hit: the full text plus a one-line snippet of it. */
function toHit(raw: RawDocRow, score: number): SearchHit {
  const doc = parseRow(raw);
  return {
    id: doc.id,
    source_type: doc.source_type,
    raw_path: doc.raw_path,
    doc_type: doc.doc_type,
    scope: doc.scope,
    valid_until: doc.valid_until,
    created_at: doc.created_at,
    score,
    snippet: toSnippet(doc.full_text),
    full_text: doc.full_text,
    extracted: doc.extracted,
  };
}

export class DocumentStore {
  private readonly docTypes: DocTypeRegistry;

  constructor(
    private readonly db: DB,
    private readonly embedder: Embedder,
    docTypes?: DocTypeRegistry,
  ) {
    this.docTypes = docTypes ?? new DocTypeRegistry(db);
  }

  /** Insert a new document. Scope is authorized via the guard, never trusted. */
  async register(principal: Principal, input: RegisterInput): Promise<RegisterResult> {
    const fullText = (input.full_text ?? "").trim();
    if (fullText.length === 0) throw new ValidationError("full_text is required");

    const scope = resolveWriteScope(principal, input.scope);

    const validUntil = input.valid_until ?? NO_EXPIRY;
    if (!isValidYmd(validUntil)) {
      throw new ValidationError(`valid_until must be a real 'YYYY-MM-DD' date (or omit for ${NO_EXPIRY})`);
    }

    if (input.extracted !== undefined && (typeof input.extracted !== "object" || input.extracted === null)) {
      throw new ValidationError("extracted must be a JSON object");
    }
    const extracted = input.extracted ?? {};
    assertValidDates(extracted);
    const extractedJson = JSON.stringify(extracted);
    const sourceType = input.source_type ?? "mcp";
    const rawPath = input.raw_path ?? null;
    const docType = input.doc_type ?? null;
    const dedupKey = input.dedup_key ?? null;

    // doc_type is a curated vocabulary (§9.5): null or a known entry only.
    // Unknown types are rejected — create them first via upsert_doc_type.
    const spec = docType !== null ? this.docTypes.get(docType) : undefined;
    if (docType !== null && spec === undefined) {
      throw new ValidationError(
        `unknown doc_type "${docType}": create it first with upsert_doc_type (see list_doc_types), or omit doc_type`,
      );
    }

    // Lifecycle governs superseding, not the type. Default from the type's hint
    // when a known type is given, else 'singleton'. Overridable per document.
    const lifecycle: Lifecycle = input.lifecycle ?? spec?.default_lifecycle ?? "singleton";
    if (!isLifecycle(lifecycle)) {
      throw new ValidationError(`lifecycle must be one of 'singleton' | 'history'`);
    }

    // Supersede prior versions only for singleton documents with a dedup key (§9.1).
    const supersede = dedupKey !== null && lifecycle === "singleton" && (input.supersede ?? true);

    // Embedding is async; compute it before the synchronous transaction.
    const embedding = vecBlob(await this.embedder.embed(fullText));

    const tx = this.db.transaction(() => {
      const info = this.db
        .prepare(
          `INSERT INTO documents (source_type, raw_path, full_text, doc_type, lifecycle, extracted, scope, valid_until, dedup_key)
           VALUES (@sourceType, @rawPath, @fullText, @docType, @lifecycle, @extracted, @scope, @validUntil, @dedupKey)`,
        )
        .run({ sourceType, rawPath, fullText, docType, lifecycle, extracted: extractedJson, scope, validUntil, dedupKey });
      const id = Number(info.lastInsertRowid);
      this.syncSearchIndexes(id, fullText, docType, embedding);
      syncDocDates(this.db, { id, extracted, raw_path: rawPath, doc_type: docType, valid_until: validUntil });

      let superseded: number[] = [];
      if (supersede) {
        const rows = this.db
          .prepare(
            `SELECT id FROM documents
             WHERE scope = ? AND doc_type IS ? AND dedup_key = ? AND id <> ? AND deleted = 0`,
          )
          .all(scope, docType, dedupKey, id) as { id: number }[];
        superseded = rows.map((r) => r.id);
        if (superseded.length > 0) {
          const placeholders = superseded.map(() => "?").join(",");
          this.db.prepare(`UPDATE documents SET deleted = 1 WHERE id IN (${placeholders})`).run(...superseded);
          // Drop superseded rows from the search indexes too: sqlite-vec applies
          // the KNN cut BEFORE the deleted=0 filter, so stale vectors would
          // consume the k budget and could crowd out live results.
          for (const sId of superseded) this.dropSearchIndexes(sId);
        }
      }
      return { id, superseded };
    });

    const { id, superseded } = tx();
    const row = this.db.prepare(`SELECT * FROM documents WHERE id = ?`).get(id) as RawDocRow;
    return { document: parseRow(row), superseded };
  }

  /** Insert/replace the FTS and vector rows for a document id. */
  private syncSearchIndexes(id: number, fullText: string, docType: string | null, embedding: Buffer): void {
    this.db.prepare(`DELETE FROM documents_fts WHERE rowid = ?`).run(id);
    this.db
      .prepare(`INSERT INTO documents_fts (rowid, full_text, doc_type) VALUES (?, ?, ?)`)
      .run(id, fullText, docType ?? "");
    // sqlite-vec's vec0 requires a BigInt for the integer primary key.
    this.db.prepare(`DELETE FROM documents_vec WHERE document_id = ?`).run(BigInt(id));
    this.db.prepare(`INSERT INTO documents_vec (document_id, embedding) VALUES (?, ?)`).run(BigInt(id), embedding);
  }

  /** Remove a document's search-index rows (used on hard delete). */
  private dropSearchIndexes(id: number): void {
    this.db.prepare(`DELETE FROM documents_fts WHERE rowid = ?`).run(id);
    this.db.prepare(`DELETE FROM documents_vec WHERE document_id = ?`).run(BigInt(id));
  }

  /** Scope-checked fetch by id (respects lifecycle filter unless overridden). */
  get(principal: Principal, id: number, includeExpired = false): DocumentRow | null {
    const scopes = resolveReadScopes(principal);
    const placeholders = scopes.map(() => "?").join(",");
    const expiryClause = includeExpired ? "" : "AND valid_until >= ?";
    const params: unknown[] = [id, ...scopes];
    if (!includeExpired) params.push(todayLocal());
    const row = this.db
      .prepare(
        `SELECT * FROM documents
         WHERE id = ? AND deleted = 0 AND scope IN (${placeholders}) ${expiryClause}`,
      )
      .get(...params) as RawDocRow | undefined;
    return row ? parseRow(row) : null;
  }

  /**
   * Fetch a document for mutation: readable-scope checked, but ignoring the
   * lifecycle filter (so expired/deleted rows can be previewed, corrected, or
   * restored). The caller must additionally hold write permission on its scope.
   */
  getForMutation(principal: Principal, id: number): DocumentRow {
    const scopes = resolveReadScopes(principal);
    const placeholders = scopes.map(() => "?").join(",");
    const row = this.db
      .prepare(`SELECT * FROM documents WHERE id = ? AND scope IN (${placeholders})`)
      .get(id, ...scopes) as RawDocRow | undefined;
    if (!row) throw new NotFoundError();
    // Must be permitted to write the document's current scope.
    resolveWriteScope(principal, row.scope as Scope);
    return parseRow(row);
  }

  /** Apply a partial update. Re-embeds and re-indexes when full_text changes. */
  async update(principal: Principal, id: number, patch: UpdatePatch): Promise<DocumentRow> {
    const current = this.getForMutation(principal, id);

    const next: DocumentRow = { ...current };
    if (patch.full_text !== undefined) {
      const t = patch.full_text.trim();
      if (t.length === 0) throw new ValidationError("full_text cannot be empty");
      next.full_text = t;
    }
    if (patch.scope !== undefined) next.scope = resolveWriteScope(principal, patch.scope);
    if (patch.valid_until !== undefined) {
      if (!isValidYmd(patch.valid_until)) {
        throw new ValidationError(`valid_until must be a real 'YYYY-MM-DD' date (or ${NO_EXPIRY})`);
      }
      next.valid_until = patch.valid_until;
    }
    if (patch.extracted !== undefined) {
      if (typeof patch.extracted !== "object" || patch.extracted === null) {
        throw new ValidationError("extracted must be a JSON object");
      }
      assertValidDates(patch.extracted);
      next.extracted = patch.extracted;
    }
    if (patch.doc_type !== undefined) {
      if (patch.doc_type !== null && !this.docTypes.isKnown(patch.doc_type)) {
        throw new ValidationError(
          `unknown doc_type "${patch.doc_type}": create it first with upsert_doc_type, or set null`,
        );
      }
      next.doc_type = patch.doc_type;
    }
    if (patch.lifecycle !== undefined) {
      if (!isLifecycle(patch.lifecycle)) throw new ValidationError(`lifecycle must be 'singleton' | 'history'`);
      next.lifecycle = patch.lifecycle;
    }
    if (patch.source_type !== undefined) next.source_type = patch.source_type;
    if (patch.raw_path !== undefined) next.raw_path = patch.raw_path;
    if (patch.deleted !== undefined) next.deleted = patch.deleted;
    if (patch.dedup_key !== undefined) next.dedup_key = patch.dedup_key;

    // Re-embed when the text changed, or when un-deleting (indexes were dropped
    // on soft-delete and must be rebuilt). A document that ends up deleted has
    // its indexes dropped instead (KNN pollution — see syncSearchIndexes notes).
    const unDeleting = next.deleted === false && current.deleted;
    const reembed = !next.deleted && (patch.full_text !== undefined || unDeleting);
    const embedding = reembed ? vecBlob(await this.embedder.embed(next.full_text)) : null;

    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE documents SET source_type=@source_type, raw_path=@raw_path, full_text=@full_text,
             doc_type=@doc_type, lifecycle=@lifecycle, extracted=@extracted, scope=@scope, valid_until=@valid_until,
             deleted=@deleted, dedup_key=@dedup_key
           WHERE id=@id`,
        )
        .run({
          id,
          source_type: next.source_type,
          raw_path: next.raw_path,
          full_text: next.full_text,
          doc_type: next.doc_type,
          lifecycle: next.lifecycle,
          extracted: JSON.stringify(next.extracted),
          scope: next.scope,
          valid_until: next.valid_until,
          deleted: next.deleted ? 1 : 0,
          dedup_key: next.dedup_key,
        });
      if (next.deleted) this.dropSearchIndexes(id);
      else if (reembed && embedding) this.syncSearchIndexes(id, next.full_text, next.doc_type, embedding);
      else this.db.prepare(`UPDATE documents_fts SET doc_type = ? WHERE rowid = ?`).run(next.doc_type ?? "", id);
      // Re-extraction lands here: reviews carry over to dates whose item_key is unchanged.
      syncDocDates(this.db, next);
    });
    tx();
    return parseRow(this.db.prepare(`SELECT * FROM documents WHERE id = ?`).get(id) as RawDocRow);
  }

  /** Logical delete (manual archive, §4). Reversible via restore(). */
  softDelete(principal: Principal, id: number): DocumentRow {
    this.getForMutation(principal, id); // scope + write check
    const tx = this.db.transaction(() => {
      this.db.prepare(`UPDATE documents SET deleted = 1 WHERE id = ?`).run(id);
      // Keep the search indexes clean so soft-deleted docs cannot pollute KNN.
      this.dropSearchIndexes(id);
    });
    tx();
    return parseRow(this.db.prepare(`SELECT * FROM documents WHERE id = ?`).get(id) as RawDocRow);
  }

  /** Un-delete a logically deleted document; rebuilds its search indexes. */
  async restore(principal: Principal, id: number): Promise<DocumentRow> {
    const doc = this.getForMutation(principal, id);
    const embedding = vecBlob(await this.embedder.embed(doc.full_text));
    const tx = this.db.transaction(() => {
      this.db.prepare(`UPDATE documents SET deleted = 0 WHERE id = ?`).run(id);
      this.syncSearchIndexes(id, doc.full_text, doc.doc_type, embedding);
    });
    tx();
    return parseRow(this.db.prepare(`SELECT * FROM documents WHERE id = ?`).get(id) as RawDocRow);
  }

  /** Physical delete (irreversible). Reserved for "truly remove this" (§4). Its doc_dates cascade. */
  hardDelete(principal: Principal, id: number): { id: number } {
    this.getForMutation(principal, id);
    const tx = this.db.transaction(() => {
      this.dropSearchIndexes(id);
      this.db.prepare(`DELETE FROM documents WHERE id = ?`).run(id);
    });
    tx();
    return { id };
  }

  /**
   * Documents expiring within `withinDays` (today .. today+N), across all
   * scopes. Intended for the server-side reminder cron, not user requests.
   */
  findUpcomingExpiries(withinDays: number, from: Date = new Date()): UpcomingExpiry[] {
    const today = todayLocal(from);
    const until = new Date(from);
    until.setDate(until.getDate() + withinDays);
    const untilStr = todayLocal(until);
    const rows = this.db
      .prepare(
        `SELECT * FROM documents
         WHERE deleted = 0 AND valid_until >= ? AND valid_until <= ? AND valid_until <> ?
         ORDER BY valid_until ASC`,
      )
      .all(today, untilStr, NO_EXPIRY) as RawDocRow[];
    const todayMs = Date.parse(today + "T00:00:00Z");
    return rows.map((raw) => {
      const doc = parseRow(raw);
      const daysLeft = Math.round((Date.parse(doc.valid_until + "T00:00:00Z") - todayMs) / 86400000);
      return {
        id: doc.id,
        doc_type: doc.doc_type,
        scope: doc.scope,
        valid_until: doc.valid_until,
        snippet: toSnippet(doc.full_text),
        days_left: daysLeft,
      };
    });
  }

  /**
   * Dates falling in `from..to` (inclusive), oldest first, within readable
   * scopes. Rejected dates and dates of deleted/superseded documents are left
   * out; pending ones are included so the caller can flag them as unconfirmed.
   */
  upcoming(principal: Principal, params: UpcomingParams = {}): { from: string; to: string; items: UpcomingDate[] } {
    const from = params.from ?? todayLocal();
    if (!isValidYmd(from)) throw new ValidationError("from must be a real 'YYYY-MM-DD' date");
    const to = params.to ?? addDays(from, UPCOMING_DEFAULT_DAYS);
    if (!isValidYmd(to)) throw new ValidationError("to must be a real 'YYYY-MM-DD' date");
    if (to < from) throw new ValidationError("to must not be before from");

    const scopes = resolveReadScopes(principal, params.scopes);
    const items = this.db
      .prepare(
        `SELECT dd.date, dd.kind, dd.title, dd.review_status, dd.doc_id, d.scope
         FROM doc_dates dd
         JOIN documents d ON d.id = dd.doc_id
         WHERE dd.date >= ? AND dd.date <= ? AND dd.review_status <> 'rejected'
           AND d.deleted = 0 AND d.scope IN (${scopes.map(() => "?").join(",")})
         ORDER BY dd.date, dd.doc_id, dd.id`,
      )
      .all(from, to, ...scopes) as UpcomingDate[];
    return { from, to, items };
  }

  /**
   * Dates awaiting review, grouped by document. `limit` caps documents, never a
   * document's items: a reviewer approving "all" must have seen all of them.
   * Documents with the nearest upcoming pending date come first.
   */
  listPendingDates(principal: Principal, params: PendingParams = {}): PendingResult {
    const scopes = resolveReadScopes(principal, params.scopes);
    const limit = clamp(params.limit ?? 20, 1, 100);
    const docFilter = params.doc_id === undefined ? "" : "AND dd.doc_id = ?";
    const docParams = params.doc_id === undefined ? [] : [params.doc_id];

    const groups = this.db
      .prepare(
        `SELECT dd.doc_id, MIN(CASE WHEN dd.date >= ? THEN dd.date END) AS next_date
         FROM doc_dates dd
         JOIN documents d ON d.id = dd.doc_id
         WHERE dd.review_status = 'pending' AND d.deleted = 0
           AND d.scope IN (${scopes.map(() => "?").join(",")}) ${docFilter}
         GROUP BY dd.doc_id
         ORDER BY next_date IS NULL, next_date, dd.doc_id`,
      )
      .all(todayLocal(), ...scopes, ...docParams) as { doc_id: number }[];

    const documents = groups.slice(0, limit).map(({ doc_id }): PendingDocument => {
      const doc = parseRow(this.db.prepare(`SELECT * FROM documents WHERE id = ?`).get(doc_id) as RawDocRow);
      const items = this.db
        .prepare(
          `SELECT id, date, kind, title FROM doc_dates
           WHERE doc_id = ? AND review_status = 'pending'
           ORDER BY date, id`,
        )
        .all(doc_id) as PendingDate[];
      const snippet = toSnippet(doc.full_text);
      const title =
        documentTitle(doc) ??
        (snippet.length > TITLE_SNIPPET_LEN ? snippet.slice(0, TITLE_SNIPPET_LEN) + "…" : snippet);
      return { doc_id, title, doc_type: doc.doc_type, scope: doc.scope, items };
    });
    return { documents, total_documents: groups.length };
  }

  /**
   * Record a human's review of one document's dates: reject `reject_ids`, and
   * with `approve_all` approve everything still pending. Either may be used
   * alone, so dates can be rejected one at a time and the rest confirmed later.
   * Requires the same permission as any other write to the document.
   */
  reviewDates(principal: Principal, docId: number, input: ReviewInput): ReviewResult {
    this.getForMutation(principal, docId); // scope + write check
    const rejectIds = [...new Set(input.reject_ids ?? [])];
    if (!input.approve_all && rejectIds.length === 0) {
      throw new ValidationError("nothing to review: pass approve_all=true and/or reject_ids");
    }

    const tx = this.db.transaction((): ReviewResult => {
      const rows = this.db
        .prepare(`SELECT id, review_status FROM doc_dates WHERE doc_id = ? ORDER BY id`)
        .all(docId) as { id: number; review_status: ReviewStatus }[];
      const statusById = new Map(rows.map((r) => [r.id, r.review_status]));
      const unknown = rejectIds.filter((id) => !statusById.has(id));
      if (unknown.length > 0) {
        throw new ValidationError(`reject_ids not found on document ${docId}: ${unknown.join(", ")}`);
      }

      const mark = this.db.prepare(
        `UPDATE doc_dates SET review_status = ?, reviewed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`,
      );
      const rejected = rejectIds.filter((id) => statusById.get(id) !== "rejected");
      for (const id of rejected) mark.run("rejected", id);

      const rejecting = new Set(rejectIds);
      const stillPending = rows.filter((r) => r.review_status === "pending" && !rejecting.has(r.id)).map((r) => r.id);
      const approved = input.approve_all ? stillPending : [];
      for (const id of approved) mark.run("approved", id);

      return { doc_id: docId, approved, rejected, pending: stillPending.length - approved.length };
    });
    return tx();
  }

  /**
   * Search with scope enforcement and the default lifecycle filter. Hits carry
   * the full text unless `snippet_only` is set.
   */
  async search(principal: Principal, params: SearchParams): Promise<SearchHit[]> {
    const query = (params.query ?? "").trim();
    if (query.length === 0) throw new ValidationError("query is required");

    const scopes = resolveReadScopes(principal, params.scopes);
    const mode: SearchMode = params.mode ?? "keyword";
    const limit = clamp(params.limit ?? 10, 1, 100);
    const today = todayLocal();

    const filters = this.buildFilters(scopes, params.doc_type, params.include_expired, today);

    const hits =
      mode === "keyword"
        ? this.searchKeyword(query, filters, limit)
        : mode === "vector"
          ? await this.searchVector(query, filters, limit)
          : await this.searchHybrid(query, filters, limit);
    // The full text is the default; a caller listing broadly can opt out of its size.
    return params.snippet_only ? hits.map(({ full_text: _omitted, ...hit }) => hit) : hits;
  }

  /** Shared WHERE fragment + bound params for scope/lifecycle/doc_type. */
  private buildFilters(
    scopes: Scope[],
    docType: string | undefined,
    includeExpired: boolean | undefined,
    today: string,
  ): { sql: string; params: unknown[] } {
    const clauses = ["d.deleted = 0"];
    const params: unknown[] = [];

    clauses.push(`d.scope IN (${scopes.map(() => "?").join(",")})`);
    params.push(...scopes);

    if (!includeExpired) {
      clauses.push("d.valid_until >= ?");
      params.push(today);
    }
    if (docType) {
      clauses.push("d.doc_type = ?");
      params.push(docType);
    }
    return { sql: clauses.join(" AND "), params };
  }

  private searchKeyword(
    query: string,
    filters: { sql: string; params: unknown[] },
    limit: number,
  ): SearchHit[] {
    const match = ftsQuery(query);
    if (match.length === 0) return [];
    const rows = this.db
      .prepare(
        `SELECT d.*, bm25(documents_fts) AS rank
         FROM documents_fts
         JOIN documents d ON d.id = documents_fts.rowid
         WHERE documents_fts MATCH ? AND ${filters.sql}
         ORDER BY rank
         LIMIT ?`,
      )
      .all(match, ...filters.params, limit) as (RawDocRow & { rank: number })[];
    // bm25 is lower-is-better; negate so higher score == more relevant.
    return rows.map((r) => toHit(r, -r.rank));
  }

  private async searchVector(
    query: string,
    filters: { sql: string; params: unknown[] },
    limit: number,
  ): Promise<SearchHit[]> {
    const embedding = vecBlob(await this.embedder.embed(query));
    // Over-fetch KNN candidates because filters are applied after the KNN cut.
    const k = clamp(limit * 4, limit, 200);
    const rows = this.db
      .prepare(
        `SELECT d.*, v.distance AS distance
         FROM documents_vec v
         JOIN documents d ON d.id = v.document_id
         WHERE v.embedding MATCH ? AND k = ? AND ${filters.sql}
         ORDER BY v.distance
         LIMIT ?`,
      )
      .all(embedding, k, ...filters.params, limit) as (RawDocRow & { distance: number })[];
    return rows.map((r) => toHit(r, 1 / (1 + r.distance)));
  }

  /** Reciprocal Rank Fusion of keyword and vector results. */
  private async searchHybrid(
    query: string,
    filters: { sql: string; params: unknown[] },
    limit: number,
  ): Promise<SearchHit[]> {
    const pool = clamp(limit * 3, limit, 100);
    const [keyword, vector] = await Promise.all([
      Promise.resolve(this.searchKeyword(query, filters, pool)),
      this.searchVector(query, filters, pool),
    ]);

    const K = 60; // RRF constant
    const scores = new Map<number, number>();
    const byId = new Map<number, SearchHit>();
    for (const list of [keyword, vector]) {
      list.forEach((hit, idx) => {
        scores.set(hit.id, (scores.get(hit.id) ?? 0) + 1 / (K + idx + 1));
        if (!byId.has(hit.id)) byId.set(hit.id, hit);
      });
    }
    return [...scores.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([id, score]) => ({ ...(byId.get(id) as SearchHit), score }));
  }
}
