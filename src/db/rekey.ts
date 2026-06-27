/**
 * One-time migration between a plaintext and an encrypted (SQLCipher) DB file.
 *
 * `PRAGMA rekey` re-encrypts every page of the existing file in place, so the
 * conversion is reversible and keeps all data, the FTS5 index, and the vector
 * table intact. Run with the MCP server stopped (an open handle to the file
 * would race the rewrite).
 */
import Database from "better-sqlite3-multiple-ciphers";
import { applyCipherKey } from "./index.js";

const escape = (s: string): string => s.replace(/'/g, "''");

/** Encrypt an existing plaintext DB at `dbPath` in place using `key`. */
export function encryptInPlace(dbPath: string, key: string): void {
  const db = new Database(dbPath);
  try {
    db.pragma("cipher='sqlcipher'");
    db.pragma(`rekey='${escape(key)}'`);
  } finally {
    db.close();
  }
}

/** Decrypt an existing encrypted DB at `dbPath` in place back to plaintext. */
export function decryptInPlace(dbPath: string, key: string): void {
  const db = new Database(dbPath);
  try {
    applyCipherKey(db, key);
    db.pragma("rekey=''");
  } finally {
    db.close();
  }
}
