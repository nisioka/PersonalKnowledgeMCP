import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openDatabase, type DB } from "../src/db/index.js";
import { HashingEmbedder } from "../src/embedding.js";
import { DocumentStore, ValidationError, todayLocal } from "../src/store/documents.js";
import { AuthError } from "../src/auth/guard.js";
import type { Principal } from "../src/config.js";

const full: Principal = { name: "full", scopes: ["private", "work", "shared"], defaultWriteScope: "private" };
const work: Principal = { name: "work", scopes: ["work", "shared"], defaultWriteScope: "work" };
const family: Principal = { name: "family", scopes: ["shared"], defaultWriteScope: "shared" };

const DIM = 256;

function dayOffset(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return todayLocal(d);
}

describe("DocumentStore", () => {
  let db: DB;
  let store: DocumentStore;

  beforeEach(() => {
    db = openDatabase(":memory:", { embeddingDim: DIM, ensureDir: false });
    store = new DocumentStore(db, new HashingEmbedder(DIM));
  });
  afterEach(() => db.close());

  it("registers a document with defaults", async () => {
    const { document: doc } = await store.register(full, { full_text: "自宅の住所は東京都です" });
    expect(doc.id).toBeGreaterThan(0);
    expect(doc.scope).toBe("private"); // full's default write scope
    expect(doc.valid_until).toBe("9999-12-31");
    expect(doc.source_type).toBe("mcp");
    expect(doc.deleted).toBe(false);
  });

  it("rejects empty full_text", async () => {
    await expect(store.register(full, { full_text: "   " })).rejects.toThrow(ValidationError);
  });

  it("rejects malformed valid_until", async () => {
    await expect(
      store.register(full, { full_text: "x", valid_until: "2026/01/01" }),
    ).rejects.toThrow(ValidationError);
  });

  it("enforces write scope authorization", async () => {
    await expect(store.register(family, { full_text: "x", scope: "private" })).rejects.toThrow(AuthError);
  });

  it("finds documents by keyword within scope", async () => {
    await store.register(full, { full_text: "電子レンジの保証書 保証期限あり", doc_type: "保証書", scope: "private" });
    const hits = await store.search(full, { query: "保証書" });
    expect(hits.length).toBe(1);
    expect(hits[0]!.doc_type).toBe("保証書");
    expect(hits[0]!.snippet).toContain("保証書");
  });

  it("hides other scopes from a limited token", async () => {
    await store.register(full, { full_text: "秘密のメモ privatemarker", scope: "private" });
    await store.register(full, { full_text: "共有の連絡先 sharedmarker", scope: "shared" });

    const familyHits = await store.search(family, { query: "privatemarker OR sharedmarker" });
    // family can only read shared.
    expect(familyHits.every((h) => h.scope === "shared")).toBe(true);
    expect(familyHits.some((h) => h.scope === "private")).toBe(false);
  });

  it("includes shared results for a work token", async () => {
    await store.register(full, { full_text: "業務メモ workmarker", scope: "work" });
    await store.register(full, { full_text: "共有メモ sharedmarker2", scope: "shared" });
    const hits = await store.search(work, { query: "workmarker OR sharedmarker2" });
    const scopes = new Set(hits.map((h) => h.scope));
    expect(scopes.has("work")).toBe(true);
    expect(scopes.has("shared")).toBe(true);
  });

  it("excludes expired documents by default but includes them on request", async () => {
    await store.register(full, { full_text: "去年のイベント案内 expired", valid_until: dayOffset(-1) });
    const def = await store.search(full, { query: "イベント" });
    expect(def.length).toBe(0);
    const hist = await store.search(full, { query: "イベント", include_expired: true });
    expect(hist.length).toBe(1);
  });

  it("excludes logically deleted documents", async () => {
    const { document: doc } = await store.register(full, { full_text: "削除予定のメモ deletetest" });
    db.prepare("UPDATE documents SET deleted = 1 WHERE id = ?").run(doc.id);
    const hits = await store.search(full, { query: "削除予定" });
    expect(hits.length).toBe(0);
  });

  it("filters by doc_type", async () => {
    await store.register(full, { full_text: "手紙A letter", doc_type: "学校手紙" });
    await store.register(full, { full_text: "保証書A letter", doc_type: "保証書" });
    const hits = await store.search(full, { query: "letter", doc_type: "保証書" });
    expect(hits.length).toBe(1);
    expect(hits[0]!.doc_type).toBe("保証書");
  });

  it("supports vector and hybrid modes", async () => {
    await store.register(full, { full_text: "alpha beta gamma keyword document" });
    const vec = await store.search(full, { query: "alpha beta gamma", mode: "vector" });
    expect(vec.length).toBe(1);
    const hyb = await store.search(full, { query: "alpha keyword", mode: "hybrid" });
    expect(hyb.length).toBe(1);
  });

  it("get() respects scope and lifecycle", async () => {
    const { document: priv } = await store.register(full, { full_text: "private get test", scope: "private" });
    expect(store.get(full, priv.id)?.id).toBe(priv.id);
    expect(store.get(family, priv.id)).toBeNull(); // family cannot read private
  });

  it("does not leak query punctuation into FTS errors", async () => {
    await store.register(full, { full_text: "簡単なメモ note" });
    const hits = await store.search(full, { query: '"(weird] query)*' });
    expect(Array.isArray(hits)).toBe(true);
  });

  it("supersedes prior versions via dedup_key (non-history doc_type)", async () => {
    const first = await store.register(full, {
      full_text: "保育園の電話番号 03-1111 numkey",
      doc_type: "連絡先",
      dedup_key: "保育園:電話",
      scope: "shared",
    });
    const second = await store.register(full, {
      full_text: "保育園の電話番号 03-2222 numkey",
      doc_type: "連絡先",
      dedup_key: "保育園:電話",
      scope: "shared",
    });
    expect(second.superseded).toContain(first.document.id);

    const hits = await store.search(family, { query: "numkey" });
    expect(hits.length).toBe(1); // only the latest remains visible
    expect(hits[0]!.snippet).toContain("03-2222");
  });

  it("does NOT supersede for history-preserving doc_types", async () => {
    const a = await store.register(full, {
      full_text: "2025年の固定資産税 taxkey", doc_type: "固定資産税", dedup_key: "固定資産税",
    });
    const b = await store.register(full, {
      full_text: "2026年の固定資産税 taxkey", doc_type: "固定資産税", dedup_key: "固定資産税",
    });
    expect(b.superseded).toHaveLength(0);
    const hits = await store.search(full, { query: "taxkey" });
    expect(hits.length).toBe(2);
    void a;
  });

  it("updates a document and re-indexes new text", async () => {
    const { document } = await store.register(full, { full_text: "old content updatekey" });
    const updated = await store.update(full, document.id, { full_text: "new content freshtoken" });
    expect(updated.full_text).toBe("new content freshtoken");
    expect((await store.search(full, { query: "freshtoken" })).length).toBe(1);
    expect((await store.search(full, { query: "updatekey" })).length).toBe(0);
  });

  it("enforces scope on update and delete", async () => {
    const { document } = await store.register(full, { full_text: "private secret upd", scope: "private" });
    await expect(store.update(family, document.id, { full_text: "x" })).rejects.toThrow();
    expect(() => store.softDelete(family, document.id)).toThrow();
  });

  it("soft-deletes and restores", async () => {
    const { document } = await store.register(full, { full_text: "archiveme softkey" });
    store.softDelete(full, document.id);
    expect((await store.search(full, { query: "softkey" })).length).toBe(0);
    await store.restore(full, document.id);
    expect((await store.search(full, { query: "softkey" })).length).toBe(1);
  });

  it("hard-deletes and drops the search indexes", async () => {
    const { document } = await store.register(full, { full_text: "removeme hardkey" });
    store.hardDelete(full, document.id);
    expect(() => store.getForMutation(full, document.id)).toThrow();
    expect((await store.search(full, { query: "hardkey" })).length).toBe(0);
  });

  it("drops superseded/deleted docs from the vector index (no KNN pollution)", async () => {
    // Same text repeatedly; only the live row should survive in the vec index.
    await store.register(full, { full_text: "knnpollute alpha", doc_type: "連絡先", dedup_key: "k", scope: "shared" });
    await store.register(full, { full_text: "knnpollute alpha", doc_type: "連絡先", dedup_key: "k", scope: "shared" });
    const live = await store.register(full, { full_text: "knnpollute alpha", doc_type: "連絡先", dedup_key: "k", scope: "shared" });

    const vecHits = await store.search(full, { query: "knnpollute alpha", mode: "vector", limit: 10 });
    expect(vecHits.map((h) => h.id)).toEqual([live.document.id]);

    const vecRows = db.prepare("SELECT COUNT(*) c FROM documents_vec").get() as { c: number };
    expect(vecRows.c).toBe(1);

    // Soft-deleting the survivor must also clear the vector index.
    store.softDelete(full, live.document.id);
    expect((await store.search(full, { query: "knnpollute alpha", mode: "vector" })).length).toBe(0);
    expect((db.prepare("SELECT COUNT(*) c FROM documents_vec").get() as { c: number }).c).toBe(0);
  });

  it("finds upcoming expiries within a window", async () => {
    await store.register(full, { full_text: "保証 soon", valid_until: dayOffset(5), doc_type: "保証書" });
    await store.register(full, { full_text: "保証 far", valid_until: dayOffset(60), doc_type: "保証書" });
    await store.register(full, { full_text: "no expiry" }); // sentinel, excluded
    const upcoming = store.findUpcomingExpiries(14);
    expect(upcoming.length).toBe(1);
    expect(upcoming[0]!.days_left).toBe(5);
  });
});
