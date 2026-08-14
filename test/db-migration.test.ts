import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type DB } from "../src/db/index.js";

/**
 * The schema is the baseline (version 1); there is no legacy backfill. These
 * tests just exercise the migration scaffold: a fresh DB is stamped at the
 * baseline version and re-opening is a no-op. Future schema changes add steps to
 * migrate() and would get their own tests.
 */
describe("db schema versioning scaffold (§9.5)", () => {
  let dir: string;
  let db: DB | undefined;

  afterEach(() => {
    db?.close();
    db = undefined;
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("stamps a fresh DB at the baseline user_version", () => {
    dir = mkdtempSync(join(tmpdir(), "pk-mig-"));
    db = openDatabase(join(dir, "fresh.db"), { embeddingDim: 256 });
    expect(db.pragma("user_version", { simple: true })).toBe(1);
    // Baseline schema present and vocabulary empty.
    expect((db.prepare(`SELECT COUNT(*) AS c FROM doc_types`).get() as { c: number }).c).toBe(0);
    const cols = db.pragma("table_info(documents)") as { name: string }[];
    expect(cols.some((c) => c.name === "lifecycle")).toBe(true);
  });

  it("is idempotent when re-opening", () => {
    dir = mkdtempSync(join(tmpdir(), "pk-mig-"));
    const path = join(dir, "reopen.db");
    openDatabase(path, { embeddingDim: 256 }).close();
    db = openDatabase(path, { embeddingDim: 256 });
    expect(db.pragma("user_version", { simple: true })).toBe(1);
  });
});
