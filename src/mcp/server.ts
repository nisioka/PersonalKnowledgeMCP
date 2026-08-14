/**
 * MCP server wiring: register / search / update / delete / restore / list_doc_types.
 *
 * A server is built per request with the authenticated principal captured in
 * closure, so scope enforcement (via the store + guard) always uses the real
 * caller identity rather than anything the client claims.
 *
 * Destructive operations (update, delete) are asymmetric (§9.4): reads are free,
 * but a destructive call without `confirm: true` returns a summary of what would
 * change and makes no mutation — the caller must re-issue with confirm to apply.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Principal } from "../config.js";
import { AuthError } from "../auth/guard.js";
import { DocumentStore, NotFoundError, ValidationError } from "../store/documents.js";
import { DocTypeRegistry } from "../doctype/registry.js";
import { LIFECYCLES, SCOPES, type DocumentRow } from "../types.js";
import { audit } from "../audit.js";
import { SERVER_NAME, VERSION } from "../version.js";

export interface ToolContext {
  store: DocumentStore;
  principal: Principal;
  docTypes: DocTypeRegistry;
}

const scopeEnum = z.enum(SCOPES);
const lifecycleEnum = z.enum(LIFECYCLES);

/**
 * Mutating the shared doc_type vocabulary is a curator action, restricted to a
 * principal with full scope coverage (the primary owner). Throws AuthError
 * otherwise, which errorContent surfaces as a safe 403-style message.
 */
function requireVocabularyAdmin(principal: Principal): void {
  const covers = SCOPES.every((s) => principal.scopes.includes(s));
  if (!covers) {
    throw new AuthError("changing the doc_type vocabulary requires a full-access token", 403);
  }
}

function jsonContent(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] };
}

function errorContent(error: unknown) {
  const known =
    error instanceof AuthError ||
    error instanceof ValidationError ||
    error instanceof NotFoundError;
  // Known errors carry safe, user-facing messages. For anything else, log the
  // detail server-side and return a generic message so internals aren't leaked.
  if (!known) {
    const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
    process.stderr.write(`[error] ${detail}\n`);
  }
  const message = known ? (error as Error).message : "internal error";
  return { isError: true as const, content: [{ type: "text" as const, text: message }] };
}

/** Compact, human-readable summary of a document for confirmation previews. */
function summarize(doc: DocumentRow) {
  const snippet = doc.full_text.replace(/\s+/g, " ").trim().slice(0, 160);
  return {
    id: doc.id,
    doc_type: doc.doc_type,
    scope: doc.scope,
    valid_until: doc.valid_until,
    deleted: doc.deleted,
    snippet: snippet.length < doc.full_text.length ? snippet + "…" : snippet,
  };
}

export function buildServer(ctx: ToolContext): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: VERSION },
    { capabilities: { tools: {}, prompts: {} } },
  );

  server.registerTool(
    "register",
    {
      title: "Register knowledge",
      description:
        "Store a piece of household knowledge (text, optionally with an original file path). " +
        "Raw text is always kept alongside extracted metadata. The scope you request is " +
        "authorized against your token. Set dedup_key to supersede a prior version of the " +
        "same logical document (skipped for history-preserving doc_types).",
      inputSchema: {
        full_text: z.string().min(1).describe("The full text to store (OCR result or input text)."),
        source_type: z.string().optional().describe("Ingestion path, e.g. 'mcp' | 'discord'. Default 'mcp'."),
        raw_path: z.string().nullable().optional().describe("Path to the original file, if any."),
        doc_type: z
          .string()
          .nullable()
          .optional()
          .describe("Semantic label; must be null or a known type (see list_doc_types). Unknown types are rejected."),
        lifecycle: lifecycleEnum
          .optional()
          .describe("'singleton' (latest wins, supersedes) or 'history' (keep every version). Default from the doc_type, else 'singleton'."),
        extracted: z.record(z.unknown()).optional().describe("Extracted metadata as a JSON object."),
        scope: scopeEnum.optional().describe("Target scope. Defaults to your token's default write scope."),
        valid_until: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional()
          .describe("Expiry date 'YYYY-MM-DD'. Omit for no expiry (9999-12-31)."),
        dedup_key: z.string().nullable().optional().describe("Loose key identifying the logical document."),
        supersede: z.boolean().optional().describe("Override auto-superseding of prior versions."),
      },
    },
    async (args) => {
      try {
        const { document, superseded } = await ctx.store.register(ctx.principal, args);
        audit("register", ctx.principal.name, { id: document.id, scope: document.scope, superseded });
        return jsonContent({
          ok: true,
          id: document.id,
          scope: document.scope,
          valid_until: document.valid_until,
          superseded,
          doc_type_known: ctx.docTypes.isKnown(document.doc_type),
        });
      } catch (error) {
        return errorContent(error);
      }
    },
  );

  server.registerTool(
    "search",
    {
      title: "Search knowledge",
      description:
        "Search stored household knowledge. By default only non-deleted, non-expired documents " +
        "within scopes your token can read are returned. Use include_expired for history lookups.",
      inputSchema: {
        query: z.string().min(1).describe("Free-text query (>= 3 chars for keyword matching)."),
        mode: z.enum(["keyword", "vector", "hybrid"]).optional().describe("Search mode. Default 'keyword'."),
        scopes: z.array(scopeEnum).optional().describe("Restrict to these scopes (intersected with your token)."),
        doc_type: z.string().optional().describe("Restrict to a single doc_type."),
        include_expired: z.boolean().optional().describe("Include expired documents for history lookups."),
        limit: z.number().int().min(1).max(100).optional().describe("Max results. Default 10."),
      },
    },
    async (args) => {
      try {
        const hits = await ctx.store.search(ctx.principal, args);
        return jsonContent({ ok: true, count: hits.length, results: hits });
      } catch (error) {
        return errorContent(error);
      }
    },
  );

  server.registerTool(
    "update",
    {
      title: "Update knowledge (destructive)",
      description:
        "Overwrite fields of an existing document. This is destructive: without confirm=true it " +
        "returns a preview of the current record and makes NO change. Re-issue with confirm=true to apply.",
      inputSchema: {
        id: z.number().int().describe("Document id to update."),
        confirm: z.boolean().optional().describe("Must be true to actually apply the change."),
        full_text: z.string().optional(),
        source_type: z.string().optional(),
        raw_path: z.string().nullable().optional(),
        doc_type: z.string().nullable().optional(),
        lifecycle: lifecycleEnum.optional(),
        extracted: z.record(z.unknown()).optional(),
        scope: scopeEnum.optional(),
        valid_until: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        deleted: z.boolean().optional(),
        dedup_key: z.string().nullable().optional(),
      },
    },
    async (args) => {
      try {
        const { id, confirm, ...patch } = args;
        if (!confirm) {
          const current = ctx.store.getForMutation(ctx.principal, id);
          return jsonContent({
            ok: true,
            requires_confirmation: true,
            action: "update",
            current: summarize(current),
            requested_changes: patch,
            note: "Re-issue update with confirm=true to apply.",
          });
        }
        const updated = await ctx.store.update(ctx.principal, id, patch);
        audit("update", ctx.principal.name, { id });
        return jsonContent({ ok: true, updated: summarize(updated) });
      } catch (error) {
        return errorContent(error);
      }
    },
  );

  server.registerTool(
    "delete",
    {
      title: "Delete knowledge (destructive)",
      description:
        "Delete a document. mode='soft' (default) logically archives it (reversible via restore); " +
        "mode='hard' physically removes it (irreversible). Without confirm=true returns a preview only.",
      inputSchema: {
        id: z.number().int().describe("Document id to delete."),
        mode: z.enum(["soft", "hard"]).optional().describe("'soft' (default) or 'hard'."),
        confirm: z.boolean().optional().describe("Must be true to actually delete."),
      },
    },
    async (args) => {
      try {
        const mode = args.mode ?? "soft";
        if (!args.confirm) {
          const current = ctx.store.getForMutation(ctx.principal, args.id);
          return jsonContent({
            ok: true,
            requires_confirmation: true,
            action: `delete (${mode})`,
            current: summarize(current),
            note: `Re-issue delete with confirm=true to ${mode === "hard" ? "permanently remove" : "archive"} it.`,
          });
        }
        if (mode === "hard") {
          ctx.store.hardDelete(ctx.principal, args.id);
          audit("delete.hard", ctx.principal.name, { id: args.id });
          return jsonContent({ ok: true, deleted: args.id, mode: "hard" });
        }
        const doc = ctx.store.softDelete(ctx.principal, args.id);
        audit("delete.soft", ctx.principal.name, { id: args.id });
        return jsonContent({ ok: true, archived: summarize(doc), mode: "soft" });
      } catch (error) {
        return errorContent(error);
      }
    },
  );

  server.registerTool(
    "restore",
    {
      title: "Restore archived knowledge",
      description: "Un-delete a logically (soft) deleted document.",
      inputSchema: { id: z.number().int().describe("Document id to restore.") },
    },
    async (args) => {
      try {
        const doc = await ctx.store.restore(ctx.principal, args.id);
        audit("restore", ctx.principal.name, { id: args.id });
        return jsonContent({ ok: true, restored: summarize(doc) });
      } catch (error) {
        return errorContent(error);
      }
    },
  );

  server.registerTool(
    "list_doc_types",
    {
      title: "List doc_type vocabulary",
      description:
        "List the doc_type vocabulary so new documents reuse existing names rather than introducing " +
        "spelling variants. The vocabulary starts empty and grows via upsert_doc_type; register only " +
        "accepts a doc_type that is null or listed here. Each entry carries an advisory default_lifecycle.",
      inputSchema: {},
    },
    async () => {
      try {
        return jsonContent({ ok: true, doc_types: ctx.docTypes.list() });
      } catch (error) {
        return errorContent(error);
      }
    },
  );

  server.registerTool(
    "upsert_doc_type",
    {
      title: "Create or edit a doc_type",
      description:
        "Add a new doc_type to the vocabulary, or edit an existing one. doc_type is a purely semantic " +
        "label; its default_lifecycle is only an advisory prefill for register (the document's own " +
        "lifecycle is what governs behavior). Requires a full-access token.",
      inputSchema: {
        name: z.string().min(1).describe("Canonical doc_type name (e.g. '製品保証')."),
        description: z.string().optional().describe("Human description; also shown to extraction."),
        default_lifecycle: lifecycleEnum
          .optional()
          .describe("Advisory default for register: 'singleton' (default) or 'history'."),
        expiry_hint: z.string().optional().describe("How valid_until is usually estimated for this type."),
      },
    },
    async (args) => {
      try {
        requireVocabularyAdmin(ctx.principal);
        const spec = ctx.docTypes.upsert(args);
        audit("doc_type.upsert", ctx.principal.name, { name: spec.name });
        return jsonContent({ ok: true, doc_type: spec });
      } catch (error) {
        return errorContent(error);
      }
    },
  );

  server.registerTool(
    "delete_doc_type",
    {
      title: "Delete a doc_type",
      description:
        "Remove a doc_type from the vocabulary. Refused if documents still use it, unless force=true. " +
        "Removing a type never changes the documents themselves — their label just becomes 'unknown' " +
        "again. Requires a full-access token.",
      inputSchema: {
        name: z.string().min(1).describe("doc_type name to remove."),
        force: z.boolean().optional().describe("Remove even if documents still use it."),
      },
    },
    async (args) => {
      try {
        requireVocabularyAdmin(ctx.principal);
        const { removed, inUse } = ctx.docTypes.remove(args.name, args.force ?? false);
        if (!removed && inUse > 0) {
          return jsonContent({
            ok: false,
            removed: false,
            in_use: inUse,
            note: `doc_type "${args.name}" is used by ${inUse} document(s). Re-issue with force=true to remove it anyway.`,
          });
        }
        audit("doc_type.delete", ctx.principal.name, { name: args.name, forced: args.force ?? false });
        return jsonContent({ ok: true, removed, in_use: inUse });
      } catch (error) {
        return errorContent(error);
      }
    },
  );

  // Prompt that guides Claude to do OCR + structure extraction ITSELF (using the
  // client's own multimodal ability) and then call `register`. This removes the
  // need for a server-side Anthropic API key / Python OCR: attach a document in
  // Claude (Code / Desktop / app, or via a Claude Code Discord bridge), run this
  // prompt, and the extraction is billed under the user's existing Claude plan.
  server.registerPrompt(
    "ingest_document",
    {
      title: "Ingest a document into the knowledge base",
      description:
        "Read an attached document (image/PDF/text), extract structured metadata, and register it. " +
        "Does the OCR/extraction client-side (no API key needed).",
    },
    () => {
      const types = ctx.docTypes.list();
      const vocab =
        types.length === 0
          ? "（まだ語彙は空です。無理に型を作らず doc_type: null で登録してよい）"
          : types
              .map(
                (d) =>
                  `- ${d.name}: ${d.description}（既定 lifecycle=${d.default_lifecycle}／${d.expiry_hint}）`,
              )
              .join("\n");
      const text = [
        "添付された書類（画像／PDF／テキスト）を読み取り、家庭内ナレッジベースに登録してください。",
        "",
        "手順:",
        "1. 書類の全文を文字起こしする（これを register の full_text に渡す）。",
        "2. 内容から構造化メタデータを抽出する。",
        "3. personal-knowledge の register ツールを呼ぶ。",
        "",
        "register に渡す値の決め方:",
        "- doc_type: 下記の既知リストに合うものがあればそれを使う。合うものが無ければ doc_type: null で登録する。",
        "  同じ種類を今後も繰り返し登録すると分かっている場合に限り、先に upsert_doc_type で綺麗な意味名の型を作ってから使う（勝手に増やしすぎない）。",
        "- lifecycle: 『最新だけ残す』情報は \"singleton\"、『毎回が記録として残る』情報（各年の税額・支出・日記など）は \"history\"。",
        "  既知の doc_type を使う場合は省略すればその既定値が入る。判断できなければ singleton。",
        "- extracted: 読み取れた項目の JSON。日付は YYYY-MM-DD。発行日/イベント日は issued_date / event_date に入れる（登録日とは別物）。",
        "- valid_until: 有効期限 YYYY-MM-DD。無期限なら \"9999-12-31\"。lifecycle とは別概念（恒久情報は singleton ＋ 9999-12-31）。",
        "- dedup_key: singleton で『最新だけ残す』情報には論理キー（例 \"保育園:電話番号\"）。history では null。",
        "- scope: 明確に共有/仕事のものでなければ private。",
        "",
        "破壊的操作ではないので register はそのまま実行してよい。複数書類なら1件ずつ register する。",
        "",
        "既知の doc_type:",
        vocab,
      ].join("\n");
      return { messages: [{ role: "user", content: { type: "text", text } }] };
    },
  );

  return server;
}
