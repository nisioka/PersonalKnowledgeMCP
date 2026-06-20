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
import { resolveReadScopes, resolveWriteScope } from "../auth/guard.js";
import {
  NO_EXPIRY,
  type DocumentRow,
  type RegisterInput,
  type Scope,
  type SearchHit,
  type SearchMode,
  type SearchParams,
} from "../types.js";

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
  constructor(
    private readonly db: DB,
    private readonly embedder: Embedder,
  ) {}

  /** Insert a new document. Scope is authorized via the guard, never trusted. */
  async register(principal: Principal, input: RegisterInput): Promise<DocumentRow> {
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

    // Embedding is async; compute it before the synchronous transaction.
    const embedding = vecBlob(await this.embedder.embed(fullText));

    const insert = this.db.transaction(() => {
      const info = this.db
        .prepare(
          `INSERT INTO documents (source_type, raw_path, full_text, doc_type, extracted, scope, valid_until)
           VALUES (@sourceType, @rawPath, @fullText, @docType, @extracted, @scope, @validUntil)`,
        )
        .run({ sourceType, rawPath, fullText, docType, extracted: extractedJson, scope, validUntil });
      const id = Number(info.lastInsertRowid);

      this.db
        .prepare(`INSERT INTO documents_fts (rowid, full_text, doc_type) VALUES (?, ?, ?)`)
        .run(id, fullText, docType ?? "");
      // sqlite-vec's vec0 requires a BigInt for the integer primary key.
      this.db
        .prepare(`INSERT INTO documents_vec (document_id, embedding) VALUES (?, ?)`)
        .run(BigInt(id), embedding);
      return id;
    });

    const id = insert();
    const row = this.db.prepare(`SELECT * FROM documents WHERE id = ?`).get(id) as RawDocRow;
    return parseRow(row);
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
