import { describe, it, expect, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3-multiple-ciphers";
import { openDatabase } from "../src/db/index.js";
import { encryptInPlace } from "../src/db/rekey.js";
import { createSnapshot } from "../src/backup/backup.js";
import { HashingEmbedder } from "../src/embedding.js";
import { DocumentStore } from "../src/store/documents.js";

const DIM = 256;
const KEY = "correct horse battery staple";
const SECRET = "個人番号 123456789012";

const dirs: string[] = [];
function tmpDb(): string {
  const dir = mkdtempSync(join(tmpdir(), "pk-enc-"));
  dirs.push(dir);
  return join(dir, "knowledge.db");
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("at-rest encryption", () => {
  it("encrypts the DB file and round-trips with the key", async () => {
    const path = tmpDb();
    const db = openDatabase(path, { embeddingDim: DIM, key: KEY });
    const store = new DocumentStore(db, new HashingEmbedder(DIM));
    await store.register(
      { name: "full", scopes: ["private", "shared"], defaultWriteScope: "private" },
      { full_text: SECRET },
    );

    // Before checkpoint, the freshly written row lives in the WAL sidecar — it
    // too must be encrypted (the whole point of "WAL included").
    const wal = `${path}-wal`;
    if (existsSync(wal)) {
      const walRaw = readFileSync(wal);
      expect(walRaw.includes(Buffer.from(SECRET))).toBe(false);
      expect(walRaw.includes(Buffer.from("個人番号"))).toBe(false);
    }
    db.close();

    // The raw file must not contain the plaintext.
    const raw = readFileSync(path);
    expect(raw.includes(Buffer.from(SECRET))).toBe(false);
    expect(raw.includes(Buffer.from("個人番号"))).toBe(false);

    // Reopening with the correct key still finds it via FTS (search unaffected).
    const reopened = openDatabase(path, { embeddingDim: DIM, key: KEY });
    const store2 = new DocumentStore(reopened, new HashingEmbedder(DIM));
    const hits = await store2.search(
      { name: "full", scopes: ["private", "shared"], defaultWriteScope: "private" },
      { query: "123456789012" },
    );
    expect(hits.length).toBe(1);
    reopened.close();
  });

  it("rejects the wrong key", () => {
    const path = tmpDb();
    openDatabase(path, { embeddingDim: DIM, key: KEY }).close();
    expect(() => openDatabase(path, { embeddingDim: DIM, key: "wrong key" })).toThrow();
  });

  it("snapshots an encrypted DB (uncheckpointed WAL) to an encrypted buffer", async () => {
    const path = tmpDb();
    const db = openDatabase(path, { embeddingDim: DIM, key: KEY });
    const store = new DocumentStore(db, new HashingEmbedder(DIM));
    await store.register(
      { name: "full", scopes: ["private", "shared"], defaultWriteScope: "private" },
      { full_text: SECRET },
    );

    // Snapshot while the DB is still open: the row is in the WAL, not yet
    // checkpointed into the main file. This is the WAL-safe path the feature
    // promises — a separate readonly connection must still capture it.
    const snapshot = await createSnapshot(path, KEY);
    expect(snapshot.includes(Buffer.from(SECRET))).toBe(false);
    db.close();

    // The snapshot opens only with the same key and contains the WAL-era row.
    const snapDir = mkdtempSync(join(tmpdir(), "pk-snap-"));
    dirs.push(snapDir); // afterEach removes the whole dir, not just the file
    const snapPath = join(snapDir, "s.db");
    writeFileSync(snapPath, snapshot);
    const opened = new Database(snapPath);
    opened.pragma("cipher='sqlcipher'");
    opened.pragma(`key='${KEY}'`);
    const count = opened.prepare("SELECT count(*) AS c FROM documents").get() as { c: number };
    expect(count.c).toBe(1);
    opened.close();
  });

  it("migrates a plaintext DB to encrypted in place", async () => {
    const path = tmpDb();
    // Create plaintext with a row, then migrate.
    const plain = openDatabase(path, { embeddingDim: DIM });
    const store = new DocumentStore(plain, new HashingEmbedder(DIM));
    await store.register(
      { name: "full", scopes: ["private", "shared"], defaultWriteScope: "private" },
      { full_text: SECRET },
    );
    plain.close();
    expect(readFileSync(path).includes(Buffer.from(SECRET))).toBe(true); // was plaintext

    encryptInPlace(path, KEY);
    expect(readFileSync(path).includes(Buffer.from(SECRET))).toBe(false); // now encrypted

    const enc = openDatabase(path, { embeddingDim: DIM, key: KEY });
    const n = enc.prepare("SELECT count(*) AS c FROM documents").get() as { c: number };
    expect(n.c).toBe(1);
    enc.close();
  });
});
