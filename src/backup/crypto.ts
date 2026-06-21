/**
 * Authenticated encryption for backups (design §9.2): the SQLite snapshot is
 * encrypted before it ever leaves the home server. AES-256-GCM with a key
 * derived from a passphrase via scrypt.
 *
 * File layout: MAGIC(5) | version(1) | salt(16) | iv(12) | tag(16) | ciphertext
 */
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

const MAGIC = Buffer.from("PKBAK", "ascii");
const VERSION = 1;
const SALT_LEN = 16;
const IV_LEN = 12;
const TAG_LEN = 16;
const KEY_LEN = 32;

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  // N=2^15 is a reasonable cost for a one-shot daily backup. The memory needed
  // (~128*N*r bytes) exceeds Node's default 32 MiB cap, so raise maxmem.
  return scryptSync(passphrase, salt, KEY_LEN, { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
}

export function encrypt(plaintext: Buffer, passphrase: string): Buffer {
  if (!passphrase) throw new Error("backup passphrase is required");
  const salt = randomBytes(SALT_LEN);
  const iv = randomBytes(IV_LEN);
  const key = deriveKey(passphrase, salt);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([MAGIC, Buffer.from([VERSION]), salt, iv, tag, ciphertext]);
}

export function decrypt(blob: Buffer, passphrase: string): Buffer {
  if (!passphrase) throw new Error("backup passphrase is required");
  let offset = 0;
  const magic = blob.subarray(offset, (offset += MAGIC.length));
  if (!magic.equals(MAGIC)) throw new Error("not a PK backup file (bad magic)");
  const version = blob[offset];
  offset += 1;
  if (version !== VERSION) throw new Error(`unsupported backup version ${version}`);
  const salt = blob.subarray(offset, (offset += SALT_LEN));
  const iv = blob.subarray(offset, (offset += IV_LEN));
  const tag = blob.subarray(offset, (offset += TAG_LEN));
  const ciphertext = blob.subarray(offset);
  const key = deriveKey(passphrase, salt);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}
