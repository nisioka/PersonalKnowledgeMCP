/**
 * Encrypted SQLite backup to Google Drive (design §9.2).
 *
 * Scope: the SQLite DB only — original files (raw_path) are intentionally NOT
 * backed up. full_text keeps documents searchable after a restore; truly
 * important originals are kept by hand. The snapshot is taken via SQLite's
 * online backup API (WAL-safe) and encrypted before upload.
 */
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import Database from "better-sqlite3-multiple-ciphers";
import { google } from "googleapis";
import { applyCipherKey } from "../db/index.js";
import { decrypt, encrypt } from "./crypto.js";

export interface BackupConfig {
  dbPath: string;
  passphrase: string;
  folderId: string;
  /**
   * Passphrase the live DB is encrypted with (PK_DB_PASSPHRASE). Needed to read
   * an encrypted DB when snapshotting; omit when the DB is unencrypted.
   */
  dbKey?: string;
  /** Path to a Google service-account key JSON (GOOGLE_APPLICATION_CREDENTIALS). */
  credentialsPath?: string;
}

const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";

/** Take a WAL-safe snapshot of the DB and return it as a Buffer. */
export async function createSnapshot(dbPath: string, dbKey?: string): Promise<Buffer> {
  const dir = mkdtempSync(join(tmpdir(), "pk-backup-"));
  const snapshotPath = join(dir, "snapshot.db");
  try {
    if (dbKey) {
      // The online backup API rejects an encrypted source. `VACUUM INTO` instead
      // produces a transactionally consistent (WAL-safe) copy that inherits the
      // source's encryption, so the snapshot stays encrypted at rest too.
      // readonly + fileMustExist: never write to (or silently create) the source —
      // a missing/mis-set PK_DB_PATH must fail, not back up an empty DB.
      const db = new Database(dbPath, { readonly: true, fileMustExist: true });
      try {
        applyCipherKey(db, dbKey);
        db.exec(`VACUUM INTO '${snapshotPath.replace(/'/g, "''")}'`);
      } finally {
        db.close();
      }
    } else {
      const db = new Database(dbPath, { readonly: true });
      try {
        await db.backup(snapshotPath);
      } finally {
        db.close();
      }
    }
    return readFileSync(snapshotPath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function driveClient(credentialsPath?: string) {
  const auth = new google.auth.GoogleAuth({
    scopes: [DRIVE_SCOPE],
    ...(credentialsPath ? { keyFile: credentialsPath } : {}),
  });
  return google.drive({ version: "v3", auth });
}

function backupName(now = new Date()): string {
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  return `knowledge-${stamp}.db.enc`;
}

/** Snapshot -> encrypt -> upload. Returns the created Drive file id. */
export async function runBackup(config: BackupConfig, now = new Date()): Promise<string> {
  const snapshot = await createSnapshot(config.dbPath, config.dbKey);
  const encrypted = encrypt(snapshot, config.passphrase);
  const drive = driveClient(config.credentialsPath);
  const res = await drive.files.create({
    requestBody: { name: backupName(now), parents: [config.folderId] },
    media: { mimeType: "application/octet-stream", body: Readable.from(encrypted) },
    fields: "id,name",
  });
  if (!res.data.id) throw new Error("Drive upload returned no file id");
  return res.data.id;
}

/** Download the most recent backup, decrypt it, and write it to targetPath. */
export async function runRestore(config: BackupConfig, targetPath: string): Promise<string> {
  const drive = driveClient(config.credentialsPath);
  const list = await drive.files.list({
    // Match only our encrypted backups, not any file containing 'knowledge-'.
    q: `'${config.folderId}' in parents and name contains 'knowledge-' and name contains '.db.enc' and trashed = false`,
    orderBy: "createdTime desc",
    pageSize: 1,
    fields: "files(id,name)",
  });
  const file = list.data.files?.[0];
  if (!file?.id) throw new Error("no backup found in the configured folder");
  const res = await drive.files.get(
    { fileId: file.id, alt: "media" },
    { responseType: "arraybuffer" },
  );
  const plaintext = decrypt(Buffer.from(res.data as ArrayBuffer), config.passphrase);
  // Write to a temp file then atomically rename, so a mid-write failure cannot
  // leave a truncated/corrupt database at targetPath.
  const tmp = join(dirname(targetPath), `.restore-${process.pid}-${Date.now()}.tmp`);
  // 0o600: keep the DB owner-only (not umask-dependent). The bytes are the raw
  // snapshot — still SQLCipher-encrypted if the source DB was — so the server
  // reopens it with PK_DB_PASSPHRASE; restore itself stays key-agnostic.
  writeFileSync(tmp, plaintext, { mode: 0o600 });
  renameSync(tmp, targetPath);
  return file.name ?? file.id;
}

/** Build a BackupConfig from environment variables. */
export function backupConfigFromEnv(env: NodeJS.ProcessEnv = process.env): BackupConfig {
  const passphrase = env.PK_BACKUP_PASSPHRASE;
  const folderId = env.PK_BACKUP_FOLDER_ID;
  if (!passphrase) throw new Error("PK_BACKUP_PASSPHRASE is required");
  if (!folderId) throw new Error("PK_BACKUP_FOLDER_ID is required");
  // Match config.ts / rekey-cli.ts: a set-but-empty PK_DB_PASSPHRASE is a failed
  // secret injection — fail loudly instead of silently snapshotting as plaintext.
  const dbKey = env.PK_DB_PASSPHRASE;
  if (dbKey !== undefined && dbKey.trim().length === 0) {
    throw new Error("PK_DB_PASSPHRASE is set but empty");
  }
  return {
    dbPath: env.PK_DB_PATH ?? "data/knowledge.db",
    passphrase,
    folderId,
    dbKey,
    credentialsPath: env.GOOGLE_APPLICATION_CREDENTIALS,
  };
}
