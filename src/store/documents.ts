/**
 * Document store: the only place that reads/writes the `documents` table.
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
  NO_EXPIRY,
  type DocumentRow,
  type RegisterInput,
  type RegisterResult,
  type Scope,
  type SearchHit,
  type SearchMode,
  type SearchParams,
  type UpcomingExpiry,
  type UpdatePatch,
} from "../types.js";

export class NotFoundError extends Error {
  constructor(message = "document not found or not accessible") {
    super(message);
    this.name = "NotFoundError";
  }
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SNIPPET_LEN = 600;

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
  extracted: string;
  scope: string;
  valid_until: string;
  deleted: number;
  dedup_key: string | null;
  created_at: string;
}

function parseRow(raw: RawDocRow): DocumentRow {
  let extracted: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(raw.extracted) as unknown;
    if (parsed && typeof parsed === "object") extracted = parsed as Record<string, unknown>;
  } catch {
    // Corrupt JSON should not break a read; fall back to empty meta.
  }
  return {
    id: raw.id,
    source_type: raw.source_type,
    raw_path: raw.raw_path,
    full_text: raw.full_text,
    doc_type: raw.doc_type,
    extracted,
    scope: raw.scope as Scope,
    valid_until: raw.valid_until,
    deleted: raw.deleted !== 0,
    dedup_key: raw.dedup_key,
    created_at: raw.created_at,
  };
}

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
    this.docTypes = docTypes ?? new DocTypeRegistry();
  }

  /** Insert a new document. Scope is authorized via the guard, never trusted. */
  async register(principal: Principal, input: RegisterInput): Promise<RegisterResult> {
    const fullText = (input.full_text ?? "").trim();
    if (fullText.length === 0) throw new ValidationError("full_text is required");

    const scope = resolveWriteScope(principal, input.scope);

    const validUntil = input.valid_until ?? NO_EXPIRY;
    if (!DATE_RE.test(validUntil)) {
      throw new ValidationError(`valid_until must be 'YYYY-MM-DD' (or omit for ${NO_EXPIRY})`);
    }

    if (input.extracted !== undefined && (typeof input.extracted !== "object" || input.extracted === null)) {
      throw new ValidationError("extracted must be a JSON object");
    }
    const extractedJson = JSON.stringify(input.extracted ?? {});
    const sourceType = input.source_type ?? "mcp";
    const rawPath = input.raw_path ?? null;
    const docType = input.doc_type ?? null;
    const dedupKey = input.dedup_key ?? null;

    // Supersede prior versions only for non-history doc_types with a dedup key (§9.1).
    const supersede =
      dedupKey !== null &&
      !this.docTypes.keepsHistory(docType) &&
      (input.supersede ?? true);

    // Embedding is async; compute it before the synchronous transaction.
    const embedding = vecBlob(await this.embedder.embed(fullText));

    const tx = this.db.transaction(() => {
      const info = this.db
        .prepare(
          `INSERT INTO documents (source_type, raw_path, full_text, doc_type, extracted, scope, valid_until, dedup_key)
           VALUES (@sourceType, @rawPath, @fullText, @docType, @extracted, @scope, @validUntil, @dedupKey)`,
        )
        .run({ sourceType, rawPath, fullText, docType, extracted: extractedJson, scope, validUntil, dedupKey });
      const id = Number(info.lastInsertRowid);
      this.syncSearchIndexes(id, fullText, docType, embedding);

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
      if (!DATE_RE.test(patch.valid_until)) {
        throw new ValidationError(`valid_until must be 'YYYY-MM-DD' (or ${NO_EXPIRY})`);
      }
      next.valid_until = patch.valid_until;
    }
    if (patch.extracted !== undefined) {
      if (typeof patch.extracted !== "object" || patch.extracted === null) {
        throw new ValidationError("extracted must be a JSON object");
      }
      next.extracted = patch.extracted;
    }
    if (patch.doc_type !== undefined) next.doc_type = patch.doc_type;
    if (patch.source_type !== undefined) next.source_type = patch.source_type;
    if (patch.raw_path !== undefined) next.raw_path = patch.raw_path;
    if (patch.deleted !== undefined) next.deleted = patch.deleted;
    if (patch.dedup_key !== undefined) next.dedup_key = patch.dedup_key;

    const reembed = patch.full_text !== undefined;
    const embedding = reembed ? vecBlob(await this.embedder.embed(next.full_text)) : null;

    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE documents SET source_type=@source_type, raw_path=@raw_path, full_text=@full_text,
             doc_type=@doc_type, extracted=@extracted, scope=@scope, valid_until=@valid_until,
             deleted=@deleted, dedup_key=@dedup_key
           WHERE id=@id`,
        )
        .run({
          id,
          source_type: next.source_type,
          raw_path: next.raw_path,
          full_text: next.full_text,
          doc_type: next.doc_type,
          extracted: JSON.stringify(next.extracted),
          scope: next.scope,
          valid_until: next.valid_until,
          deleted: next.deleted ? 1 : 0,
          dedup_key: next.dedup_key,
        });
      if (reembed && embedding) this.syncSearchIndexes(id, next.full_text, next.doc_type, embedding);
      else this.db.prepare(`UPDATE documents_fts SET doc_type = ? WHERE rowid = ?`).run(next.doc_type ?? "", id);
    });
    tx();
    return parseRow(this.db.prepare(`SELECT * FROM documents WHERE id = ?`).get(id) as RawDocRow);
  }

  /** Logical delete (manual archive, §4). Reversible via restore(). */
  softDelete(principal: Principal, id: number): DocumentRow {
    this.getForMutation(principal, id); // scope + write check
    this.db.prepare(`UPDATE documents SET deleted = 1 WHERE id = ?`).run(id);
    return parseRow(this.db.prepare(`SELECT * FROM documents WHERE id = ?`).get(id) as RawDocRow);
  }

  /** Un-delete a logically deleted document. */
  restore(principal: Principal, id: number): DocumentRow {
    this.getForMutation(principal, id);
    this.db.prepare(`UPDATE documents SET deleted = 0 WHERE id = ?`).run(id);
    return parseRow(this.db.prepare(`SELECT * FROM documents WHERE id = ?`).get(id) as RawDocRow);
  }

  /** Physical delete (irreversible). Reserved for "truly remove this" (§4). */
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

  /** Search with scope enforcement and the default lifecycle filter. */
  async search(principal: Principal, params: SearchParams): Promise<SearchHit[]> {
    const query = (params.query ?? "").trim();
    if (query.length === 0) throw new ValidationError("query is required");

    const scopes = resolveReadScopes(principal, params.scopes);
    const mode: SearchMode = params.mode ?? "keyword";
    const limit = clamp(params.limit ?? 10, 1, 100);
    const today = todayLocal();

    const filters = this.buildFilters(scopes, params.doc_type, params.include_expired, today);

    if (mode === "keyword") return this.searchKeyword(query, filters, limit);
    if (mode === "vector") return await this.searchVector(query, filters, limit);
    return await this.searchHybrid(query, filters, limit);
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
