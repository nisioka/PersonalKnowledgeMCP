/**
 * SQLite setup: the `documents` table (plus `doc_types` and `doc_dates`), an
 * FTS5 index for keyword search, and a sqlite-vec virtual table for vector search.
 *
 * Design §4: `valid_until` and `deleted` are promoted to real, indexed columns
 * (not buried in the `extracted` JSON) because every search filters on them.
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database, { type Database as DB } from "better-sqlite3-multiple-ciphers";
import * as sqliteVec from "sqlite-vec";
import { backfillDocDates } from "../store/doc-dates.js";
import { NO_EXPIRY } from "../types.js";

export type { DB };

/**
 * Apply SQLCipher-compatible whole-file encryption to an open connection. Must
 * run before any other statement so the key applies to every page read/written.
 * The whole DB file — including the FTS5 index and WAL — is encrypted at rest;
 * decryption happens in memory, so search and every other query are unchanged.
 *
 * We pin the `sqlcipher` cipher scheme for a stable, portable on-disk format.
 * The key is interpolated (PRAGMA takes no bound parameters), so single quotes
 * are escaped by doubling.
 */
export function applyCipherKey(db: DB, key: string): void {
  db.pragma("cipher='sqlcipher'");
  db.pragma(`key='${key.replace(/'/g, "''")}'`);
}

/** Build the schema DDL. The vector dimension is fixed at table creation. */
function schemaSql(embeddingDim: number): string {
  return `
    CREATE TABLE IF NOT EXISTS documents (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      source_type  TEXT    NOT NULL,                       -- 'discord' | 'mcp' | ...
      raw_path     TEXT,                                   -- original file path; NULL for text-only
      full_text    TEXT    NOT NULL,                       -- OCR result or input text
      doc_type     TEXT,                                   -- semantic label; null or a doc_types.name
      lifecycle    TEXT    NOT NULL DEFAULT 'singleton'    -- behavior facet (§9.5): governs superseding
                     CHECK (lifecycle IN ('singleton','history')),
      extracted    TEXT    NOT NULL DEFAULT '{}',          -- JSON (JSON1); free-form extracted meta
      scope        TEXT    NOT NULL CHECK (scope IN ('private','work','shared')),
      valid_until  TEXT    NOT NULL DEFAULT '${NO_EXPIRY}',-- 'YYYY-MM-DD'; sentinel = no expiry
      deleted      INTEGER NOT NULL DEFAULT 0,             -- logical delete flag (manual archive)
      dedup_key    TEXT,                                   -- loose name-matching key for updates (§9.1)
      created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );

    -- doc_type vocabulary (§9.5). Starts empty; grown via upsert_doc_type.
    -- Behavior-free: default_lifecycle/expiry_hint are advisory prefill hints only.
    CREATE TABLE IF NOT EXISTS doc_types (
      name              TEXT PRIMARY KEY,
      description       TEXT NOT NULL DEFAULT '',
      default_lifecycle TEXT NOT NULL DEFAULT 'singleton'
                          CHECK (default_lifecycle IN ('singleton','history')),
      expiry_hint       TEXT NOT NULL DEFAULT '',
      source            TEXT NOT NULL DEFAULT 'user' CHECK (source IN ('builtin','user')),
      created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );

    -- Dates a document mentions, one row each, so a human's review survives
    -- re-extraction. Derived from documents.extracted.dates and valid_until; only
    -- review_status/reviewed_at are owned here (carried over by item_key).
    CREATE TABLE IF NOT EXISTS doc_dates (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      doc_id        INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      date          TEXT    NOT NULL,                       -- 'YYYY-MM-DD'
      kind          TEXT    NOT NULL CHECK (kind IN ('event','deadline','expiry')),
      title         TEXT    NOT NULL,                       -- shown as-is in notifications
      source        TEXT    NOT NULL CHECK (source IN ('extracted','valid_until')),
      item_key      TEXT    NOT NULL,                       -- date + normalized title; matches re-extractions
      review_status TEXT    NOT NULL DEFAULT 'pending'
                      CHECK (review_status IN ('pending','approved','rejected')),
      reviewed_at   TEXT,                                   -- when it was approved/rejected
      UNIQUE (doc_id, source, item_key)
    );
    CREATE INDEX IF NOT EXISTS idx_doc_dates_date ON doc_dates(date);
    CREATE INDEX IF NOT EXISTS idx_doc_dates_review ON doc_dates(review_status, doc_id);

    -- The default search filter is (scope IN ...) AND deleted=0 AND valid_until>=today.
    CREATE INDEX IF NOT EXISTS idx_documents_filter ON documents(scope, deleted, valid_until);
    CREATE INDEX IF NOT EXISTS idx_documents_doc_type ON documents(doc_type);
    -- Supports superseding prior versions of the same logical document (§9.1).
    CREATE INDEX IF NOT EXISTS idx_documents_dedup ON documents(scope, doc_type, dedup_key);

    -- Keyword search. Rows are kept in sync manually with documents.id as rowid.
    -- The trigram tokenizer gives substring matching across scripts (so Japanese
    -- works without a word segmenter); queries must be >= 3 characters to match.
    CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(
      full_text,
      doc_type,
      tokenize = 'trigram'
    );

    -- Vector search (sqlite-vec). Keyed by the document id.
    CREATE VIRTUAL TABLE IF NOT EXISTS documents_vec USING vec0(
      document_id INTEGER PRIMARY KEY,
      embedding FLOAT[${embeddingDim}]
    );
  `;
}

/**
 * Schema version. `schemaSql()` always describes the current schema, so a fresh
 * DB is created at this version; migrate() brings an older DB's *data* up to it.
 * To change the schema: bump SCHEMA_VERSION and add a `from < N` step in
 * migrate(). There is intentionally no legacy backfill for version 1 — any DB
 * older than that is discarded and recreated fresh.
 *
 *   1: baseline (documents.lifecycle + doc_types, §9.5)
 *   2: doc_dates
 */
const SCHEMA_VERSION = 2;

/** Stamp/upgrade the DB's user_version, running the steps it has not seen. */
function migrate(db: DB): void {
  const from = (db.pragma("user_version", { simple: true }) as number) ?? 0;
  if (from >= SCHEMA_VERSION) return;
  db.transaction(() => {
    // 2: documents stored before doc_dates existed get their rows now (a no-op
    // on a fresh DB). Tables themselves come from schemaSql().
    if (from < 2) backfillDocDates(db);
    db.pragma(`user_version = ${SCHEMA_VERSION}`);
  })();
}

export interface OpenDbOptions {
  embeddingDim: number;
  /** Skip mkdir for the parent dir (e.g. ':memory:'). */
  ensureDir?: boolean;
  /**
   * Passphrase for at-rest encryption (SQLCipher). When set, the DB file is
   * opened/created encrypted; an existing plaintext DB must be migrated first
   * (see `db/rekey`). Omit (or leave empty) to keep the DB unencrypted.
   */
  key?: string;
}

/** Open (creating if needed) the knowledge DB with all extensions loaded. */
export function openDatabase(path: string, options: OpenDbOptions): DB {
  if (options.ensureDir !== false && path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new Database(path);
  if (options.key) applyCipherKey(db, options.key);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  sqliteVec.load(db);
  db.exec(schemaSql(options.embeddingDim));
  migrate(db);
  return db;
}
