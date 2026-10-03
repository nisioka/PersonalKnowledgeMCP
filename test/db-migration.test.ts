import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type DB } from "../src/db/index.js";

/**
 * schemaSql() always creates the current schema, so a fresh DB is stamped at the
 * current version; migrate() only has to bring an older DB's data up to date.
 */
describe("db schema versioning (§9.5)", () => {
  let dir: string;
  let db: DB | undefined;

  afterEach(() => {
    db?.close();
    db = undefined;
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("stamps a fresh DB at the current user_version", () => {
    dir = mkdtempSync(join(tmpdir(), "pk-mig-"));
    db = openDatabase(join(dir, "fresh.db"), { embeddingDim: 256 });
    expect(db.pragma("user_version", { simple: true })).toBe(2);
    // Schema present and vocabulary empty.
    expect((db.prepare(`SELECT COUNT(*) AS c FROM doc_types`).get() as { c: number }).c).toBe(0);
    const cols = db.pragma("table_info(documents)") as { name: string }[];
    expect(cols.some((c) => c.name === "lifecycle")).toBe(true);
    const dateCols = (db.pragma("table_info(doc_dates)") as { name: string }[]).map((c) => c.name);
    expect(dateCols).toEqual(["id", "doc_id", "date", "kind", "title", "source", "item_key", "review_status", "reviewed_at"]);
  });

  it("is idempotent when re-opening", () => {
    dir = mkdtempSync(join(tmpdir(), "pk-mig-"));
    const path = join(dir, "reopen.db");
    openDatabase(path, { embeddingDim: 256 }).close();
    db = openDatabase(path, { embeddingDim: 256 });
    expect(db.pragma("user_version", { simple: true })).toBe(2);
  });

  it("backfills doc_dates when upgrading a version 1 DB", () => {
    dir = mkdtempSync(join(tmpdir(), "pk-mig-"));
    const path = join(dir, "v1.db");

    // A version 1 DB: documents exist, doc_dates does not.
    const v1 = openDatabase(path, { embeddingDim: 256 });
    const insert = v1.prepare(
      `INSERT INTO documents (source_type, full_text, extracted, scope, valid_until, deleted)
       VALUES ('mcp', @full_text, @extracted, 'shared', @valid_until, @deleted)`,
    );
    insert.run({
      full_text: "遠足のお知らせ",
      extracted: JSON.stringify({
        title: "遠足のお知らせ",
        dates: [
          { date: "2031-05-10", kind: "event", title: "遠足" },
          { date: "5月2日", kind: "deadline", title: "書式が古い項目" },
        ],
      }),
      valid_until: "2031-05-10",
      deleted: 0,
    });
    insert.run({ full_text: "期限のないメモ", extracted: "{}", valid_until: "9999-12-31", deleted: 0 });
    insert.run({ full_text: "壊れたメタ", extracted: "not json", valid_until: "2031-06-30", deleted: 1 });
    v1.exec(`DROP TABLE doc_dates`);
    v1.pragma("user_version = 1");
    v1.close();

    db = openDatabase(path, { embeddingDim: 256 });
    expect(db.pragma("user_version", { simple: true })).toBe(2);
    const rows = db
      .prepare(`SELECT doc_id, date, kind, title, source, review_status FROM doc_dates ORDER BY doc_id, source`)
      .all();
    expect(rows).toEqual([
      { doc_id: 1, date: "2031-05-10", kind: "event", title: "遠足", source: "extracted", review_status: "pending" },
      { doc_id: 1, date: "2031-05-10", kind: "expiry", title: "遠足のお知らせの有効期限", source: "valid_until", review_status: "pending" },
      { doc_id: 3, date: "2031-06-30", kind: "expiry", title: "文書 #3 の有効期限", source: "valid_until", review_status: "pending" },
    ]);
  });
});
