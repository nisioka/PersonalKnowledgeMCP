/**
 * Proactive reminders (design §4 "能動的提案", Phase 4): a daily scan of
 * documents approaching their valid_until (warranty expiry, deadlines, event
 * dates) that posts a digest to Discord. Run from system cron via cli.ts.
 *
 * This is a server-side job, not a user request, so it scans across all scopes
 * — the digest goes to the owner's own Discord channel.
 */
import type { DocumentStore } from "../store/documents.js";
import type { UpcomingExpiry } from "../types.js";

// Discord caps webhook `content` at 2000 chars; stay safely under it.
const DISCORD_CONTENT_LIMIT = 1900;

/** Format a reminder digest, or null when nothing is upcoming. */
export function formatReminder(items: UpcomingExpiry[], withinDays: number): string | null {
  if (items.length === 0) return null;
  const header = `📌 ${withinDays}日以内に期限を迎える項目が ${items.length} 件あります:`;
  const lines: string[] = [];
  let length = header.length;
  let shown = 0;
  for (const it of items) {
    const when = it.days_left === 0 ? "今日" : `あと${it.days_left}日`;
    const type = it.doc_type ? `[${it.doc_type}] ` : "";
    const line = `• ${when}（${it.valid_until}）${type}${it.snippet.slice(0, 80)}`;
    if (length + line.length + 1 > DISCORD_CONTENT_LIMIT) break;
    lines.push(line);
    length += line.length + 1;
    shown++;
  }
  const omitted = items.length - shown;
  if (omitted > 0) lines.push(`…ほか ${omitted} 件`);
  return `${header}\n${lines.join("\n")}`;
}

/** POST a plain message to a Discord webhook (mentions disabled, with timeout). */
export async function postToDiscord(webhookUrl: string, content: string): Promise<void> {
  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    // Disable mention parsing so externally-sourced snippet text can't ping @everyone.
    body: JSON.stringify({ content, allowed_mentions: { parse: [] } }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    throw new Error(`Discord webhook failed: ${res.status} ${await res.text()}`);
  }
}

export interface ReminderResult {
  count: number;
  posted: boolean;
}

/** Scan upcoming expiries and, if any, post a digest to Discord. */
export async function runReminders(
  store: DocumentStore,
  withinDays: number,
  webhookUrl: string | undefined,
): Promise<ReminderResult> {
  const items = store.findUpcomingExpiries(withinDays);
  const message = formatReminder(items, withinDays);
  if (!message) return { count: 0, posted: false };
  if (webhookUrl) await postToDiscord(webhookUrl, message);
  else process.stdout.write(message + "\n");
  return { count: items.length, posted: !!webhookUrl };
}
