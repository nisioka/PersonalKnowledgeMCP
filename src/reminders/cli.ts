/**
 * Reminder CLI — run daily from system cron (design §4 / Phase 4):
 *
 *   node dist/reminders/cli.js
 *
 * Env: PK_REMINDER_DAYS (default 14), PK_REMINDER_WEBHOOK (Discord webhook).
 */
import "dotenv/config";
import { loadConfig } from "../config.js";
import { openDatabase } from "../db/index.js";
import { HashingEmbedder } from "../embedding.js";
import { DocumentStore } from "../store/documents.js";
import { runReminders } from "./reminder.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const db = openDatabase(config.dbPath, { embeddingDim: config.embedding.dimension });
  try {
    const store = new DocumentStore(db, new HashingEmbedder(config.embedding.dimension));
    const days = process.env.PK_REMINDER_DAYS ? Number(process.env.PK_REMINDER_DAYS) : 14;
    const result = await runReminders(store, days, process.env.PK_REMINDER_WEBHOOK);
    process.stdout.write(`[reminders] ${result.count} upcoming, posted=${result.posted}\n`);
  } finally {
    db.close();
  }
}

main().catch((err) => {
  process.stderr.write(`[reminders] error: ${(err as Error).message}\n`);
  process.exit(1);
});
