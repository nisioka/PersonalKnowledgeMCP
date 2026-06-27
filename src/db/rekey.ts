/**
 * One-time migration between a plaintext and an encrypted (SQLCipher) DB file.
 *
 * `PRAGMA rekey` re-encrypts every page of the existing file in place, so the
 * conversion is reversible and keeps all data, the FTS5 index, and the vector
 * table intact. Run with the MCP server stopped (an open handle to the file
 * would race the rewrite).
 */
import Database, { type Database as DB } from "better-sqlite3-multiple-ciphers";
import { applyCipherKey } from "./index.js";

const escape = (s: string): string => s.replace(/'/g, "''");

/**
 * Fold any WAL back into the main file and drop the -wal/-shm sidecars before
 * rekeying. `PRAGMA rekey` rewrites every page of the main DB, but a stale WAL
 * could otherwise keep plaintext pages around across the migration. Switching to
 * the rollback journal checkpoints + removes the WAL; callers restore WAL after.
 */
function rekeySafely(db: DB, run: () => void): void {
  db.pragma("journal_mode = DELETE");
  run();
  db.pragma("journal_mode = WAL");
}

/** Encrypt an existing plaintext DB at `dbPath` in place using `key`. */
export function encryptInPlace(dbPath: string, key: string): void {
  // fileMustExist: a wrong path must fail, not create (and "encrypt") an empty DB.
  const db = new Database(dbPath, { fileMustExist: true });
  try {
    db.pragma("cipher='sqlcipher'");
    rekeySafely(db, () => db.pragma(`rekey='${escape(key)}'`));
  } finally {
    db.close();
  }
}

/** Decrypt an existing encrypted DB at `dbPath` in place back to plaintext. */
export function decryptInPlace(dbPath: string, key: string): void {
  const db = new Database(dbPath, { fileMustExist: true });
  try {
    applyCipherKey(db, key);
    rekeySafely(db, () => db.pragma("rekey=''"));
  } finally {
    db.close();
  }
}
