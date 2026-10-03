import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openDatabase, type DB } from "../src/db/index.js";
import { HashingEmbedder } from "../src/embedding.js";
import { DocumentStore, ValidationError, todayLocal } from "../src/store/documents.js";
import { DocTypeRegistry } from "../src/doctype/registry.js";
import { documentTitle, itemKey, parseExtractedDates } from "../src/store/doc-dates.js";
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

interface DateRow {
  id: number;
  doc_id: number;
  date: string;
  kind: string;
  title: string;
  source: string;
  item_key: string;
  review_status: string;
  reviewed_at: string | null;
}

describe("doc_dates helpers", () => {
  it("itemKey ignores width, case, whitespace and punctuation", () => {
    const key = itemKey("2031-05-10", "運動会（雨天順延）");
    expect(itemKey("2031-05-10", " 運動会 (雨天順延) ")).toBe(key);
    expect(itemKey("2031-05-10", "PTA 総会")).toBe(itemKey("2031-05-10", "ｐｔａ総会"));
    expect(itemKey("2031-05-11", "運動会（雨天順延）")).not.toBe(key);
    expect(itemKey("2031-05-10", "運動会の予行")).not.toBe(key);
  });

  it("parseExtractedDates keeps well-formed entries and reports the rest", () => {
    expect(parseExtractedDates({})).toEqual({ dates: [], problems: [] });
    expect(parseExtractedDates({ dates: "2031-05-10" }).problems).toHaveLength(1);

    const { dates, problems } = parseExtractedDates({
      dates: [
        { date: "2031-05-10", kind: "event", title: " 運動会 " },
        { date: "2031-02-31", kind: "event", title: "存在しない日" },
        { date: "2031-05-12", kind: "行事", title: "種別が不正" },
        { date: "2031-05-13", kind: "deadline", title: "  " },
        "2031-05-14",
      ],
    });
    expect(dates).toEqual([{ date: "2031-05-10", kind: "event", title: "運動会" }]);
    expect(problems).toHaveLength(4);
    expect(problems[0]).toContain("extracted.dates[1].date");
  });

  it("documentTitle prefers extracted.title, then the file name, then doc_type", () => {
    const base = { extracted: {}, raw_path: null, doc_type: null };
    expect(documentTitle({ ...base, extracted: { title: " 遠足のお知らせ " }, raw_path: "/x/a.pdf" })).toBe("遠足のお知らせ");
    expect(documentTitle({ ...base, raw_path: "/data/files/shared/2031-04-01_遠足のお知らせ.pdf", doc_type: "学校手紙" })).toBe(
      "遠足のお知らせ",
    );
    expect(documentTitle({ ...base, doc_type: "学校手紙" })).toBe("学校手紙");
    expect(documentTitle(base)).toBeNull();
  });
});

describe("doc_dates sync and review", () => {
  let db: DB;
  let store: DocumentStore;

  beforeEach(() => {
    db = openDatabase(":memory:", { embeddingDim: DIM, ensureDir: false });
    store = new DocumentStore(db, new HashingEmbedder(DIM), new DocTypeRegistry(db));
  });
  afterEach(() => db.close());

  const rowsOf = (docId: number) =>
    db.prepare(`SELECT * FROM doc_dates WHERE doc_id = ? ORDER BY date, id`).all(docId) as DateRow[];
  const countAll = () => (db.prepare(`SELECT COUNT(*) AS c FROM doc_dates`).get() as { c: number }).c;

  /** A fictional school letter with two dated items. */
  const letter = (overrides: Record<string, unknown> = {}) => ({
    full_text: "遠足のお知らせ 持ち物はお弁当と水筒です",
    scope: "shared" as const,
    extracted: {
      title: "遠足のお知らせ",
      dates: [
        { date: "2031-05-10", kind: "event", title: "遠足" },
        { date: "2031-05-02", kind: "deadline", title: "参加申込の締切" },
      ],
    },
    ...overrides,
  });

  describe("on register", () => {
    it("stores extracted.dates as pending rows", async () => {
      const { document } = await store.register(full, letter());
      expect(rowsOf(document.id)).toMatchObject([
        { date: "2031-05-02", kind: "deadline", title: "参加申込の締切", source: "extracted", review_status: "pending", reviewed_at: null },
        { date: "2031-05-10", kind: "event", title: "遠足", source: "extracted", review_status: "pending", reviewed_at: null },
      ]);
    });

    it("adds valid_until as an expiry, but not the no-expiry sentinel", async () => {
      const { document: dated } = await store.register(full, {
        full_text: "加湿器の保証書",
        extracted: { title: "加湿器の保証書" },
        valid_until: "2032-03-31",
      });
      expect(rowsOf(dated.id)).toMatchObject([
        { date: "2032-03-31", kind: "expiry", title: "加湿器の保証書の有効期限", source: "valid_until", review_status: "pending" },
      ]);

      const { document: forever } = await store.register(full, { full_text: "期限のないメモ" });
      expect(rowsOf(forever.id)).toEqual([]);
    });

    it("rejects malformed extracted.dates without storing anything", async () => {
      await expect(
        store.register(full, { full_text: "x", extracted: { dates: [{ date: "2031/05/10", kind: "event", title: "遠足" }] } }),
      ).rejects.toThrow(ValidationError);
      await expect(store.register(full, { full_text: "x", extracted: { dates: { date: "2031-05-10" } } })).rejects.toThrow(
        /extracted\.dates must be an array/,
      );
      expect((db.prepare(`SELECT COUNT(*) AS c FROM documents`).get() as { c: number }).c).toBe(0);
    });

    it("collapses the same item listed twice", async () => {
      const { document } = await store.register(full, {
        full_text: "x",
        extracted: {
          dates: [
            { date: "2031-05-10", kind: "event", title: "遠足" },
            { date: "2031-05-10", kind: "event", title: " 遠足 " },
          ],
        },
      });
      expect(rowsOf(document.id)).toHaveLength(1);
    });
  });

  describe("on re-extraction (update)", () => {
    it("carries the review over by item_key and resets reworded items", async () => {
      const { document } = await store.register(full, letter());
      const [deadline, trip] = rowsOf(document.id) as [DateRow, DateRow];
      store.reviewDates(full, document.id, { approve_all: true, reject_ids: [deadline.id] });

      await store.update(full, document.id, {
        extracted: {
          title: "遠足のお知らせ",
          dates: [
            { date: "2031-05-10", kind: "deadline", title: "遠足 " }, // same item: cosmetic change, new kind
            { date: "2031-05-02", kind: "deadline", title: "参加申込の締切" }, // same item, was rejected
            { date: "2031-05-10", kind: "event", title: "遠足（現地集合）" }, // reworded → a new item
            { date: "2031-05-20", kind: "event", title: "保護者会" }, // new
          ],
        },
      });

      const after = rowsOf(document.id);
      expect(after.map((r) => [r.date, r.title, r.kind, r.review_status])).toEqual([
        ["2031-05-02", "参加申込の締切", "deadline", "rejected"],
        ["2031-05-10", "遠足", "deadline", "approved"],
        ["2031-05-10", "遠足（現地集合）", "event", "pending"],
        ["2031-05-20", "保護者会", "event", "pending"],
      ]);
      // The carried-over rows are the same rows (ids and review time are kept).
      expect(after.find((r) => r.title === "遠足")).toMatchObject({ id: trip.id });
      expect(after.find((r) => r.title === "遠足")?.reviewed_at).not.toBeNull();
    });

    it("drops items that are no longer extracted", async () => {
      const { document } = await store.register(full, letter());
      await store.update(full, document.id, { extracted: { dates: [{ date: "2031-05-10", kind: "event", title: "遠足" }] } });
      expect(rowsOf(document.id).map((r) => r.title)).toEqual(["遠足"]);
    });

    it("keeps reviews when an update does not touch the dates", async () => {
      const { document } = await store.register(full, letter());
      store.reviewDates(full, document.id, { approve_all: true });
      await store.update(full, document.id, { full_text: "遠足のお知らせ（訂正版）" });
      expect(rowsOf(document.id).every((r) => r.review_status === "approved")).toBe(true);
    });

    it("re-keys the valid_until row on the date only", async () => {
      const { document } = await store.register(full, {
        full_text: "加湿器の保証書",
        extracted: { title: "加湿器の保証書" },
        valid_until: "2032-03-31",
      });
      store.reviewDates(full, document.id, { approve_all: true });

      // Renaming the document refreshes the title but keeps the approval.
      await store.update(full, document.id, { extracted: { title: "加湿器 保証書（延長）" } });
      expect(rowsOf(document.id)).toMatchObject([{ title: "加湿器 保証書（延長）の有効期限", review_status: "approved" }]);

      // Moving the expiry is a different date to confirm.
      await store.update(full, document.id, { valid_until: "2033-03-31" });
      expect(rowsOf(document.id)).toMatchObject([{ date: "2033-03-31", review_status: "pending" }]);

      await store.update(full, document.id, { valid_until: "9999-12-31" });
      expect(rowsOf(document.id)).toEqual([]);
    });

    it("rejects malformed dates in the patch and leaves the rows alone", async () => {
      const { document } = await store.register(full, letter());
      await expect(
        store.update(full, document.id, { extracted: { dates: [{ date: "2031-05-10", kind: "party", title: "遠足" }] } }),
      ).rejects.toThrow(ValidationError);
      expect(rowsOf(document.id)).toHaveLength(2);
    });
  });

  describe("upcoming", () => {
    it("returns the period's dates in date order with only the digest fields", async () => {
      const { document } = await store.register(full, letter());
      const { from, to, items } = store.upcoming(full, { from: "2031-05-02", to: "2031-05-10" });
      expect([from, to]).toEqual(["2031-05-02", "2031-05-10"]);
      expect(items).toEqual([
        { date: "2031-05-02", kind: "deadline", title: "参加申込の締切", review_status: "pending", doc_id: document.id, scope: "shared" },
        { date: "2031-05-10", kind: "event", title: "遠足", review_status: "pending", doc_id: document.id, scope: "shared" },
      ]);
      expect(store.upcoming(full, { from: "2031-05-03", to: "2031-05-09" }).items).toEqual([]);
    });

    it("defaults to today through 10 days ahead", async () => {
      await store.register(full, {
        full_text: "今月の予定",
        extracted: {
          dates: [
            { date: dayOffset(-1), kind: "event", title: "きのうの予定" },
            { date: dayOffset(0), kind: "event", title: "きょうの予定" },
            { date: dayOffset(10), kind: "event", title: "10日後の予定" },
            { date: dayOffset(11), kind: "event", title: "11日後の予定" },
          ],
        },
      });
      const { from, to, items } = store.upcoming(full);
      expect([from, to]).toEqual([dayOffset(0), dayOffset(10)]);
      expect(items.map((i) => i.title)).toEqual(["きょうの予定", "10日後の予定"]);
    });

    it("leaves out rejected dates but keeps pending and approved ones", async () => {
      const { document } = await store.register(full, letter());
      const [deadline] = rowsOf(document.id) as [DateRow, DateRow];
      store.reviewDates(full, document.id, { approve_all: true, reject_ids: [deadline.id] });
      await store.update(full, document.id, {
        extracted: { ...letter().extracted, dates: [...letter().extracted.dates, { date: "2031-05-20", kind: "event", title: "保護者会" }] },
      });
      const items = store.upcoming(full, { from: "2031-05-01", to: "2031-05-31" }).items;
      expect(items.map((i) => [i.title, i.review_status])).toEqual([
        ["遠足", "approved"],
        ["保護者会", "pending"],
      ]);
    });

    it("leaves out deleted documents, and shows them again once restored", async () => {
      const { document } = await store.register(full, letter());
      const period = { from: "2031-05-01", to: "2031-05-31" };
      store.softDelete(full, document.id);
      expect(store.upcoming(full, period).items).toEqual([]);
      await store.restore(full, document.id);
      expect(store.upcoming(full, period).items).toHaveLength(2);
    });

    it("leaves out superseded documents", async () => {
      const first = await store.register(full, letter({ dedup_key: "遠足:2031" }));
      const second = await store.register(
        full,
        letter({ dedup_key: "遠足:2031", extracted: { dates: [{ date: "2031-05-17", kind: "event", title: "遠足（延期）" }] } }),
      );
      expect(second.superseded).toEqual([first.document.id]);
      const items = store.upcoming(full, { from: "2031-05-01", to: "2031-05-31" }).items;
      expect(items.map((i) => [i.doc_id, i.title])).toEqual([[second.document.id, "遠足（延期）"]]);
    });

    it("removes the rows when a document is hard-deleted", async () => {
      const { document } = await store.register(full, letter());
      expect(countAll()).toBe(2);
      store.hardDelete(full, document.id);
      expect(countAll()).toBe(0);
    });

    it("enforces read scopes", async () => {
      await store.register(full, letter({ scope: "private" }));
      const shared = await store.register(full, letter({ scope: "shared" }));
      const period = { from: "2031-05-01", to: "2031-05-31" };

      expect(store.upcoming(family, period).items.every((i) => i.doc_id === shared.document.id)).toBe(true);
      expect(store.upcoming(family, period).items).toHaveLength(2);
      expect(store.upcoming(full, period).items).toHaveLength(4);
      expect(store.upcoming(full, { ...period, scopes: ["private"] }).items).toHaveLength(4); // shared is always readable
      expect(store.upcoming(full, { ...period, scopes: ["work"] }).items).toHaveLength(2);
      expect(() => store.upcoming(family, { ...period, scopes: ["private"] })).toThrow(AuthError);
    });

    it("validates the period", () => {
      expect(() => store.upcoming(full, { from: "2031-02-31" })).toThrow(ValidationError);
      expect(() => store.upcoming(full, { from: "2031-05-10", to: "2031-05-09" })).toThrow(ValidationError);
    });
  });

  describe("list_pending", () => {
    it("groups pending dates by document, with its title and the row ids", async () => {
      const { document } = await store.register(full, letter());
      const rows = rowsOf(document.id);
      expect(store.listPendingDates(full)).toEqual({
        total_documents: 1,
        documents: [
          {
            doc_id: document.id,
            title: "遠足のお知らせ",
            doc_type: null,
            scope: "shared",
            items: [
              { id: rows[0]!.id, date: "2031-05-02", kind: "deadline", title: "参加申込の締切" },
              { id: rows[1]!.id, date: "2031-05-10", kind: "event", title: "遠足" },
            ],
          },
        ],
      });
    });

    it("falls back to the start of the text when a document has no title", async () => {
      await store.register(full, { full_text: "回覧 ".repeat(30), extracted: { dates: [{ date: "2031-05-10", kind: "event", title: "清掃" }] } });
      const [doc] = store.listPendingDates(full).documents;
      expect(doc!.title.endsWith("…")).toBe(true);
      expect(doc!.title.length).toBe(41);
    });

    it("only lists what is still pending", async () => {
      const partly = await store.register(full, letter());
      const done = await store.register(full, letter());
      store.reviewDates(full, done.document.id, { approve_all: true });
      store.reviewDates(full, partly.document.id, { reject_ids: [rowsOf(partly.document.id)[0]!.id] });

      const { documents } = store.listPendingDates(full);
      expect(documents.map((d) => d.doc_id)).toEqual([partly.document.id]);
      expect(documents[0]!.items.map((i) => i.title)).toEqual(["遠足"]);
    });

    it("can be narrowed to one document", async () => {
      const a = await store.register(full, letter());
      const b = await store.register(full, letter());
      const only = store.listPendingDates(full, { doc_id: b.document.id });
      expect(only.documents.map((d) => d.doc_id)).toEqual([b.document.id]);
      expect(store.listPendingDates(full, { doc_id: a.document.id + 1000 }).documents).toEqual([]);
    });

    it("limits documents (never a document's items) and puts the nearest date first", async () => {
      const past = await store.register(full, {
        full_text: "過ぎた予定",
        extracted: { dates: [{ date: dayOffset(-30), kind: "event", title: "過ぎた予定" }] },
      });
      const later = await store.register(full, {
        full_text: "先の予定",
        extracted: { dates: [{ date: dayOffset(20), kind: "event", title: "先の予定" }] },
      });
      const soon = await store.register(full, {
        full_text: "近い予定",
        extracted: {
          dates: [
            { date: dayOffset(40), kind: "event", title: "ずっと先の予定" },
            { date: dayOffset(3), kind: "event", title: "近い予定" },
          ],
        },
      });

      expect(store.listPendingDates(full).documents.map((d) => d.doc_id)).toEqual([
        soon.document.id,
        later.document.id,
        past.document.id,
      ]);
      const limited = store.listPendingDates(full, { limit: 1 });
      expect(limited.total_documents).toBe(3);
      expect(limited.documents).toHaveLength(1);
      expect(limited.documents[0]!.items).toHaveLength(2);
    });

    it("enforces read scopes and skips deleted documents", async () => {
      await store.register(full, letter({ scope: "private" }));
      const shared = await store.register(full, letter({ scope: "shared" }));
      expect(store.listPendingDates(family).documents.map((d) => d.doc_id)).toEqual([shared.document.id]);
      expect(store.listPendingDates(work, { scopes: ["work"] }).documents.map((d) => d.doc_id)).toEqual([shared.document.id]);

      store.softDelete(full, shared.document.id);
      expect(store.listPendingDates(family).documents).toEqual([]);
    });
  });

  describe("review_dates", () => {
    it("rejects one date at a time, then approves the rest", async () => {
      const { document } = await store.register(full, letter());
      const [deadline, trip] = rowsOf(document.id) as [DateRow, DateRow];

      // A per-row reject button: nothing else changes.
      expect(store.reviewDates(full, document.id, { reject_ids: [deadline.id] })).toEqual({
        doc_id: document.id,
        approved: [],
        rejected: [deadline.id],
        pending: 1,
      });
      expect(rowsOf(document.id).map((r) => r.review_status)).toEqual(["rejected", "pending"]);

      // "Approve all" confirms what is left.
      expect(store.reviewDates(full, document.id, { approve_all: true })).toEqual({
        doc_id: document.id,
        approved: [trip.id],
        rejected: [],
        pending: 0,
      });
      const after = rowsOf(document.id);
      expect(after.map((r) => r.review_status)).toEqual(["rejected", "approved"]);
      expect(after.every((r) => /^\d{4}-\d{2}-\d{2}T/.test(r.reviewed_at ?? ""))).toBe(true);
    });

    it("approves all and rejects some in one call", async () => {
      const { document } = await store.register(full, letter());
      const [deadline, trip] = rowsOf(document.id) as [DateRow, DateRow];
      expect(store.reviewDates(full, document.id, { approve_all: true, reject_ids: [deadline.id] })).toMatchObject({
        approved: [trip.id],
        rejected: [deadline.id],
        pending: 0,
      });
    });

    it("can reject an approved date; repeating a rejection changes nothing", async () => {
      const { document } = await store.register(full, letter());
      const [deadline] = rowsOf(document.id) as [DateRow, DateRow];
      store.reviewDates(full, document.id, { approve_all: true });
      expect(store.reviewDates(full, document.id, { reject_ids: [deadline.id] }).rejected).toEqual([deadline.id]);
      expect(store.reviewDates(full, document.id, { reject_ids: [deadline.id] }).rejected).toEqual([]);
      expect(rowsOf(document.id).map((r) => r.review_status)).toEqual(["rejected", "approved"]);
    });

    it("refuses ids that belong to another document, changing nothing", async () => {
      const a = await store.register(full, letter());
      const b = await store.register(full, letter());
      const foreign = rowsOf(b.document.id)[0]!.id;
      expect(() => store.reviewDates(full, a.document.id, { approve_all: true, reject_ids: [foreign] })).toThrow(ValidationError);
      expect([...rowsOf(a.document.id), ...rowsOf(b.document.id)].every((r) => r.review_status === "pending")).toBe(true);
    });

    it("requires something to do", async () => {
      const { document } = await store.register(full, letter());
      expect(() => store.reviewDates(full, document.id, {})).toThrow(ValidationError);
      expect(() => store.reviewDates(full, document.id, { approve_all: false, reject_ids: [] })).toThrow(ValidationError);
    });

    it("needs write access to the document's scope", async () => {
      const priv = await store.register(full, letter({ scope: "private" }));
      const shared = await store.register(full, letter({ scope: "shared" }));
      expect(() => store.reviewDates(family, priv.document.id, { approve_all: true })).toThrow();
      expect(rowsOf(priv.document.id).every((r) => r.review_status === "pending")).toBe(true);
      // Anyone who may write the scope may review it.
      expect(store.reviewDates(family, shared.document.id, { approve_all: true }).approved).toHaveLength(2);
    });
  });
});
