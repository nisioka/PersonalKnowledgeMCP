/**
 * `doc_dates`: the dates a document mentions, one row each, kept apart from the
 * document so a human's review survives re-extraction.
 *
 * Rows are derived data — reconciled from `extracted.dates` and `valid_until`
 * whenever a document is registered or updated — except for `review_status` /
 * `reviewed_at`, which are carried over to the row with the same `item_key`.
 */
import type { DB } from "../db/index.js";
import {
  DATE_KINDS,
  NO_EXPIRY,
  type DateKind,
  type DateSource,
  type DocumentRow,
  type ExtractedDate,
} from "../types.js";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Format check PLUS calendar validity (rejects e.g. 2026-02-31). */
export function isValidYmd(value: string): boolean {
  if (!DATE_RE.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function isDateKind(value: unknown): value is DateKind {
  return typeof value === "string" && (DATE_KINDS as readonly string[]).includes(value);
}

/**
 * Read `extracted.dates`. Well-formed entries are returned; everything else is
 * described in `problems` so a caller can either reject the write (new input)
 * or ignore them (rows already stored).
 */
export function parseExtractedDates(extracted: Record<string, unknown>): {
  dates: ExtractedDate[];
  problems: string[];
} {
  const raw = extracted["dates"];
  if (raw === undefined || raw === null) return { dates: [], problems: [] };
  if (!Array.isArray(raw)) {
    return { dates: [], problems: ["extracted.dates must be an array of {date, kind, title}"] };
  }
  const dates: ExtractedDate[] = [];
  const problems: string[] = [];
  raw.forEach((entry: unknown, i) => {
    if (typeof entry !== "object" || entry === null) {
      problems.push(`extracted.dates[${i}] must be an object {date, kind, title}`);
      return;
    }
    const { date, kind, title } = entry as Record<string, unknown>;
    const at = `extracted.dates[${i}]`;
    const before = problems.length;
    if (typeof date !== "string" || !isValidYmd(date)) problems.push(`${at}.date must be a real 'YYYY-MM-DD' date`);
    if (!isDateKind(kind)) problems.push(`${at}.kind must be one of ${DATE_KINDS.map((k) => `'${k}'`).join(" | ")}`);
    if (typeof title !== "string" || title.trim().length === 0) problems.push(`${at}.title must be a non-empty string`);
    if (problems.length > before) return;
    dates.push({ date: date as string, kind: kind as DateKind, title: (title as string).trim() });
  });
  return { dates, problems };
}

/**
 * Key that identifies "the same item" across re-extractions: the date plus the
 * title with width/case folded and whitespace/punctuation dropped, so cosmetic
 * differences keep a review while a reworded title counts as a new item.
 */
export function itemKey(date: string, title: string): string {
  const normalized = title
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, "");
  return `${date}|${normalized}`;
}

/**
 * A short human name for a document: `extracted.title`, else the original file
 * name without its `<date>_` prefix and extension, else the doc_type.
 */
export function documentTitle(doc: Pick<DocumentRow, "extracted" | "raw_path" | "doc_type">): string | null {
  const title = doc.extracted["title"];
  if (typeof title === "string" && title.trim().length > 0) return title.trim();
  if (doc.raw_path) {
    const base = doc.raw_path.split(/[\\/]/).pop() ?? "";
    const name = base.replace(/\.[^.]+$/, "").replace(/^\d{4}-\d{2}-\d{2}_/, "").trim();
    if (name.length > 0) return name;
  }
  return doc.doc_type;
}

/** The document fields `doc_dates` rows are derived from. */
export type DatedDocument = Pick<DocumentRow, "id" | "extracted" | "raw_path" | "doc_type" | "valid_until">;

interface DesiredDate extends ExtractedDate {
  source: DateSource;
  item_key: string;
}

/** The rows a document should have, keyed by `source` + `item_key`. */
function desiredDates(doc: DatedDocument): Map<string, DesiredDate> {
  const desired = new Map<string, DesiredDate>();
  for (const d of parseExtractedDates(doc.extracted).dates) {
    const item_key = itemKey(d.date, d.title);
    const key = `extracted\n${item_key}`;
    // The same item listed twice collapses to its first occurrence.
    if (!desired.has(key)) desired.set(key, { ...d, source: "extracted", item_key });
  }
  if (doc.valid_until !== NO_EXPIRY) {
    // The title is generated, so only the date identifies this row: renaming the
    // document keeps its review, moving the expiry asks for a new one.
    const name = documentTitle(doc);
    const item_key = `${doc.valid_until}|`;
    desired.set(`valid_until\n${item_key}`, {
      date: doc.valid_until,
      kind: "expiry",
      title: name ? `${name}の有効期限` : `文書 #${doc.id} の有効期限`,
      source: "valid_until",
      item_key,
    });
  }
  return desired;
}

/**
 * Reconcile a document's `doc_dates` rows with its current `extracted.dates`
 * and `valid_until`. Rows whose `item_key` still exists keep their review; new
 * items start `pending`; items no longer present are removed. Call inside the
 * transaction that writes the document.
 */
export function syncDocDates(db: DB, doc: DatedDocument): void {
  const desired = desiredDates(doc);
  const existing = db
    .prepare(`SELECT id, source, item_key FROM doc_dates WHERE doc_id = ?`)
    .all(doc.id) as { id: number; source: string; item_key: string }[];

  const refresh = db.prepare(`UPDATE doc_dates SET kind = ?, title = ? WHERE id = ?`);
  const remove = db.prepare(`DELETE FROM doc_dates WHERE id = ?`);
  for (const row of existing) {
    const key = `${row.source}\n${row.item_key}`;
    const want = desired.get(key);
    if (!want) {
      remove.run(row.id);
      continue;
    }
    refresh.run(want.kind, want.title, row.id);
    desired.delete(key);
  }

  const insert = db.prepare(
    `INSERT INTO doc_dates (doc_id, date, kind, title, source, item_key)
     VALUES (@doc_id, @date, @kind, @title, @source, @item_key)`,
  );
  for (const want of desired.values()) insert.run({ doc_id: doc.id, ...want });
}

/** Parse the stored `extracted` JSON text; corrupt or non-object JSON reads as empty. */
export function parseExtractedJson(text: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>;
  } catch {
    // Corrupt JSON should not break a read; fall back to empty meta.
  }
  return {};
}

/** Build `doc_dates` for every stored document (the schema v2 migration step). */
export function backfillDocDates(db: DB): void {
  const rows = db
    .prepare(`SELECT id, raw_path, doc_type, extracted, valid_until FROM documents`)
    .all() as (Omit<DatedDocument, "extracted"> & { extracted: string })[];
  for (const row of rows) syncDocDates(db, { ...row, extracted: parseExtractedJson(row.extracted) });
}
