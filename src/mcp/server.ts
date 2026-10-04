/**
 * MCP server wiring: register / search / update / delete / restore, the doc_type
 * vocabulary tools, and the date tools (upcoming / list_pending / review_dates).
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
const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

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

/** Wrap a payload as a tool result carrying pretty-printed JSON text. */
function jsonContent(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] };
}

/** Turn a thrown error into a tool error result without leaking internals. */
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

/**
 * Summary of a document for confirmation previews and mutation results. Carries
 * the full text, so an `update` preview is also how a caller reads the text it
 * is about to rewrite.
 */
function summarize(doc: DocumentRow) {
  const snippet = doc.full_text.replace(/\s+/g, " ").trim().slice(0, 160);
  return {
    id: doc.id,
    doc_type: doc.doc_type,
    scope: doc.scope,
    valid_until: doc.valid_until,
    deleted: doc.deleted,
    snippet: snippet.length < doc.full_text.length ? snippet + "…" : snippet,
    full_text: doc.full_text,
  };
}

/** Build an MCP server whose tools act as `ctx.principal` (one per request). */
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
        extracted: z
          .record(z.unknown())
          .optional()
          .describe(
            "Extracted metadata as a JSON object. extracted.dates = [{date:'YYYY-MM-DD', kind:'event'|'deadline'|'expiry', title}] " +
              "lists the dates the document mentions; each becomes a pending entry for upcoming / list_pending.",
          ),
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
        "within scopes your token can read are returned. Use include_expired for history lookups. " +
        "Each result carries the document's full_text as well as a one-line snippet. When listing " +
        "broadly (a high limit, or only to find ids), pass snippet_only=true to leave full_text out " +
        "and keep the response small.",
      inputSchema: {
        query: z.string().min(1).describe("Free-text query (>= 3 chars for keyword matching)."),
        mode: z.enum(["keyword", "vector", "hybrid"]).optional().describe("Search mode. Default 'keyword'."),
        scopes: z.array(scopeEnum).optional().describe("Restrict to these scopes (intersected with your token)."),
        doc_type: z.string().optional().describe("Restrict to a single doc_type."),
        include_expired: z.boolean().optional().describe("Include expired documents for history lookups."),
        limit: z.number().int().min(1).max(100).optional().describe("Max results. Default 10."),
        snippet_only: z
          .boolean()
          .optional()
          .describe("Omit full_text from the results and return only the snippet. Default false."),
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
        "returns a preview of the current record and makes NO change. Re-issue with confirm=true to apply. " +
        "The preview and the applied result both carry the document's full_text, so calling update " +
        "without confirm is how to read the whole text before rewriting it.",
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

  server.registerTool(
    "upcoming",
    {
      title: "Upcoming dates",
      description:
        "List the dates (events, deadlines, expiries) that stored documents mention within a period, oldest " +
        "first. Returns only date, kind, title, review_status, doc_id and scope — not the documents. " +
        "review_status 'pending' means nobody has confirmed the date yet. Rejected dates and dates of " +
        "deleted or superseded documents are left out.",
      inputSchema: {
        from: ymd.optional().describe("First day 'YYYY-MM-DD' (inclusive). Default: today."),
        to: ymd.optional().describe("Last day 'YYYY-MM-DD' (inclusive). Default: 10 days after from."),
        scopes: z.array(scopeEnum).optional().describe("Restrict to these scopes (intersected with your token)."),
      },
    },
    async (args) => {
      try {
        const { from, to, items } = ctx.store.upcoming(ctx.principal, args);
        return jsonContent({ ok: true, from, to, count: items.length, items });
      } catch (error) {
        return errorContent(error);
      }
    },
  );

  server.registerTool(
    "list_pending",
    {
      title: "List dates awaiting review",
      description:
        "List dates that nobody has approved or rejected yet, grouped by document with the document's title. " +
        "Each item carries the id to pass to review_dates.reject_ids. limit caps the number of documents; " +
        "a listed document always comes with all of its pending dates. Pass doc_id to get one document's " +
        "pending dates (e.g. right after register/update).",
      inputSchema: {
        scopes: z.array(scopeEnum).optional().describe("Restrict to these scopes (intersected with your token)."),
        limit: z.number().int().min(1).max(100).optional().describe("Max documents. Default 20."),
        doc_id: z.number().int().optional().describe("Only this document."),
      },
    },
    async (args) => {
      try {
        const { documents, total_documents } = ctx.store.listPendingDates(ctx.principal, args);
        return jsonContent({ ok: true, count: documents.length, total_documents, documents });
      } catch (error) {
        return errorContent(error);
      }
    },
  );

  server.registerTool(
    "review_dates",
    {
      title: "Approve or reject a document's dates",
      description:
        "Record the review of one document's dates. reject_ids rejects those dates; approve_all=true approves " +
        "every date of the document that is still pending (after the rejections). Either can be used alone: " +
        "reject dates one call at a time, then approve the rest. Requires write permission on the document's scope.",
      inputSchema: {
        doc_id: z.number().int().describe("Document whose dates are reviewed."),
        approve_all: z.boolean().optional().describe("Approve all of the document's still-pending dates."),
        reject_ids: z.array(z.number().int()).optional().describe("Ids (from list_pending) of dates to reject."),
      },
    },
    async (args) => {
      try {
        const { doc_id, ...input } = args;
        const result = ctx.store.reviewDates(ctx.principal, doc_id, input);
        audit("dates.review", ctx.principal.name, {
          doc_id,
          approved: result.approved.length,
          rejected: result.rejected.length,
        });
        return jsonContent({ ok: true, ...result });
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
        "- extracted: 読み取れた項目の JSON。日付は YYYY-MM-DD。発行日は issued_date に入れる（登録日とは別物）。",
        "- extracted.title: 書類名（例 \"運動会のお知らせ\"）。確認待ちの一覧や通知に載るので、番号類・金額は入れない。",
        "- extracted.dates: 必ず出す。書類に書かれた予定・期限を 1 件 1 要素で並べた配列 [{date, kind, title}]。1 件も無ければ空配列 []。",
        "  - date: YYYY-MM-DD。年が書かれていなければ発行日や文脈から補う。期間のある予定は開始日。",
        "  - kind: \"event\"（行事・予定）／\"deadline\"（締切・提出・支払期日）／\"expiry\"（満了・有効期限）。",
        "  - title: 通知にそのまま載る件名（例 \"運動会\"、\"参加申込の締切\"）。これだけ読んで何の日か分かるように書く。",
        "    電話番号・契約番号・口座番号などの番号類と、金額は件名に入れない。",
        "  - valid_until に入れた満了日は自動で expiry として登録されるので、同じ満了を dates に重ねて書かない。",
        "  - 登録した日付は「確認待ち」で入る。承認・却下は人が決めるので、頼まれるまで review_dates を呼ばない。",
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
