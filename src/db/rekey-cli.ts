/**
 * Migrate the knowledge DB between plaintext and SQLCipher encryption:
 *
 *   node dist/db/rekey-cli.js encrypt [dbPath]   # plaintext -> encrypted
 *   node dist/db/rekey-cli.js decrypt [dbPath]   # encrypted -> plaintext
 *
 * The passphrase comes from PK_DB_PASSPHRASE; dbPath defaults to PK_DB_PATH
 * (then data/knowledge.db). Stop the MCP server first.
 */
import "dotenv/config";
import { decryptInPlace, encryptInPlace } from "./rekey.js";

function main(): void {
  const cmd = process.argv[2];
  const dbPath = process.argv[3] ?? process.env.PK_DB_PATH ?? "data/knowledge.db";
  const key = process.env.PK_DB_PASSPHRASE;
  if (cmd !== "encrypt" && cmd !== "decrypt") {
    process.stderr.write("usage: rekey-cli.js encrypt|decrypt [dbPath]\n");
    process.exit(1);
  }
  // Reject a missing OR blank/whitespace-only passphrase (matches config.ts): a
  // failed secret injection must not silently rekey the DB to an empty key.
  if (key === undefined || key.trim().length === 0) {
    throw new Error("PK_DB_PASSPHRASE is required");
  }
  process.stderr.write(
    "[rekey] WARNING: stop the MCP server (pk-mcp.service) before migrating to avoid corruption.\n",
  );
  if (cmd === "encrypt") {
    encryptInPlace(dbPath, key);
    process.stdout.write(`[rekey] encrypted ${dbPath} (SQLCipher)\n`);
  } else {
    decryptInPlace(dbPath, key);
    process.stdout.write(`[rekey] decrypted ${dbPath} to plaintext\n`);
  }
}

try {
  main();
} catch (err) {
  process.stderr.write(`[rekey] error: ${(err as Error).message}\n`);
  process.exit(1);
}
