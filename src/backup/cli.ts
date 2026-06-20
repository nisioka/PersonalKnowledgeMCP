/**
 * Backup/restore CLI. Intended to be run by system cron daily (design §9.2).
 *
 *   node dist/backup/cli.js backup
 *   node dist/backup/cli.js restore [targetPath]
 */
import "dotenv/config";
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
    const name = await runRestore(config, target);
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
