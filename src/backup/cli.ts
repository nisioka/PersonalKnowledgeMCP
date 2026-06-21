/**
 * Backup/restore CLI. Intended to be run by system cron daily (design §9.2).
 *
 *   node dist/backup/cli.js backup
 *   node dist/backup/cli.js restore [targetPath]
 */
import "dotenv/config";
import { existsSync, rmSync } from "node:fs";
import { backupConfigFromEnv, runBackup, runRestore } from "./backup.js";

async function main(): Promise<void> {
  const cmd = process.argv[2] ?? "backup";
  const config = backupConfigFromEnv();

  if (cmd === "backup") {
    const id = await runBackup(config);
    process.stdout.write(`[backup] uploaded encrypted snapshot, file id ${id}\n`);
    return;
  }
  if (cmd === "restore") {
    const target = process.argv[3] ?? config.dbPath;
    // Overwriting a live DB file corrupts it: stop the MCP server first.
    process.stderr.write(
      "[restore] WARNING: stop the MCP server (pk-mcp.service) before restoring to avoid corruption.\n",
    );
    const name = await runRestore(config, target);
    // Only after a successful restore: the old -wal/-shm sidecars belong to the
    // previous DB and would corrupt the freshly restored file. Removing them
    // earlier would lose un-checkpointed data if the restore failed.
    for (const suffix of ["-wal", "-shm"]) {
      const sidecar = `${target}${suffix}`;
      if (existsSync(sidecar)) {
        rmSync(sidecar);
        process.stderr.write(`[restore] removed stale ${sidecar}\n`);
      }
    }
    process.stdout.write(`[restore] wrote ${name} -> ${target}\n`);
    return;
  }
  process.stderr.write(`unknown command "${cmd}" (use: backup | restore)\n`);
  process.exit(1);
}

main().catch((err) => {
  process.stderr.write(`[backup] error: ${(err as Error).message}\n`);
  process.exit(1);
});
