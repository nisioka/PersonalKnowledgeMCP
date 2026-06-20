/**
 * Discord ingestion bot (design §1/§3, Phase 2). Drop an image/PDF (or text)
 * into a watched Discord channel; the bot OCRs + extracts (via the Python
 * service, when configured) and registers it into the same knowledge store the
 * MCP server reads. Originals are saved under PK_FILES_DIR; the DB keeps the path.
 *
 * Run: node dist/ingest/discord.js   (requires DISCORD_TOKEN)
 */
import "dotenv/config";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Client, Events, GatewayIntentBits, Partials, type Message } from "discord.js";
import { loadConfig } from "../config.js";
import { openDatabase } from "../db/index.js";
import { HashingEmbedder } from "../embedding.js";
import { DocumentStore } from "../store/documents.js";
import { DocTypeRegistry } from "../doctype/registry.js";
import { HttpIngestClient, type IngestClient, type IngestResult } from "./extractionClient.js";
import type { Principal } from "../config.js";
import type { Scope } from "../types.js";

/** The bot writes on behalf of the home owner. Default write scope is configurable. */
function ingestPrincipal(scope: Scope): Principal {
  return { name: "discord", scopes: ["private", "work", "shared"], defaultWriteScope: scope };
}

async function download(url: string): Promise<Buffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function handleMessage(
  message: Message,
  deps: { store: DocumentStore; ingest: IngestClient | null; filesDir: string; principal: Principal },
): Promise<void> {
  if (message.author.bot) return;
  const { store, ingest, filesDir, principal } = deps;
  const stored: string[] = [];

  for (const attachment of message.attachments.values()) {
    const buffer = await download(attachment.url);
    const localName = `${randomUUID()}-${attachment.name ?? "file"}`;
    const rawPath = join(filesDir, localName);
    mkdirSync(filesDir, { recursive: true });
    writeFileSync(rawPath, buffer);

    let result: IngestResult;
    if (ingest) {
      result = await ingest.ingestFile(buffer, attachment.name ?? localName, attachment.contentType ?? "application/octet-stream");
    } else {
      // No OCR service configured: keep the original, store any caption as text.
      result = { full_text: message.content || `(file: ${attachment.name})`, doc_type: null, extracted: {} };
    }

    const { document } = await store.register(principal, {
      full_text: result.full_text,
      source_type: "discord",
      raw_path: rawPath,
      doc_type: result.doc_type,
      extracted: result.extracted,
      valid_until: result.valid_until,
      dedup_key: result.dedup_key ?? null,
    });
    stored.push(`#${document.id} ${document.doc_type ?? "(no type)"} → ${document.scope}, expires ${document.valid_until}`);
  }

  if (message.attachments.size === 0 && message.content.trim()) {
    let result: IngestResult = { full_text: message.content.trim(), doc_type: null, extracted: {} };
    if (ingest) {
      try {
        result = await ingest.extractText(message.content.trim());
      } catch {
        // Fall back to storing raw text if extraction is unavailable.
      }
    }
    const { document } = await store.register(principal, {
      full_text: result.full_text,
      source_type: "discord",
      doc_type: result.doc_type,
      extracted: result.extracted,
      valid_until: result.valid_until,
      dedup_key: result.dedup_key ?? null,
    });
    stored.push(`#${document.id} ${document.doc_type ?? "(no type)"} → ${document.scope}`);
  }

  if (stored.length > 0) {
    await message.reply(`✅ 登録しました:\n${stored.join("\n")}`);
  }
}

function main(): void {
  const token = process.env.DISCORD_TOKEN;
  if (!token) throw new Error("DISCORD_TOKEN is required");

  const config = loadConfig();
  const db = openDatabase(config.dbPath, { embeddingDim: config.embedding.dimension });
  const store = new DocumentStore(db, new HashingEmbedder(config.embedding.dimension), new DocTypeRegistry());

  const ingestUrl = process.env.PK_INGEST_URL;
  const ingest = ingestUrl ? new HttpIngestClient(ingestUrl) : null;
  const filesDir = process.env.PK_FILES_DIR ?? "data/files";
  const scope = (process.env.PK_DISCORD_SCOPE as Scope) ?? "private";
  const principal = ingestPrincipal(scope);

  // Privacy guard: never ingest arbitrary server channels. Process only DMs and
  // explicitly allow-listed channel ids (PK_DISCORD_CHANNEL_IDS, comma-separated).
  const allowedChannels = new Set(
    (process.env.PK_DISCORD_CHANNEL_IDS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );

  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.DirectMessages],
    partials: [Partials.Channel],
  });

  client.once(Events.ClientReady, (c) => {
    const where = allowedChannels.size > 0 ? `DM + ${allowedChannels.size} channel(s)` : "DM only";
    process.stderr.write(
      `[discord] logged in as ${c.user.tag} (scope: ${scope}, ocr: ${ingest ? "on" : "off"}, watching: ${where})\n`,
    );
  });

  client.on(Events.MessageCreate, (message) => {
    const isDM = message.guildId === null;
    if (!isDM && !allowedChannels.has(message.channelId)) return;
    handleMessage(message, { store, ingest, filesDir, principal }).catch(async (err) => {
      process.stderr.write(`[discord] error: ${(err as Error).message}\n`);
      try {
        await message.reply(`⚠️ 取り込みに失敗しました: ${(err as Error).message}`);
      } catch {
        /* ignore reply failures */
      }
    });
  });

  void client.login(token);
}

main();
