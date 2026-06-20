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
import { SCOPES, type DocumentRow } from "../types.js";
import { audit } from "../audit.js";

export interface ToolContext {
  store: DocumentStore;
  principal: Principal;
  docTypes: DocTypeRegistry;
}

const scopeEnum = z.enum(SCOPES);

function jsonContent(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] };
}

function errorContent(error: unknown) {
  const known =
    error instanceof AuthError ||
    error instanceof ValidationError ||
    error instanceof NotFoundError;
  const message = known ? (error as Error).message : `internal error: ${(error as Error).message ?? String(error)}`;
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
    { name: "personal-knowledge-mcp", version: "0.2.0" },
    { capabilities: { tools: {} } },
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
        doc_type: z.string().nullable().optional().describe("Document type; see list_doc_types."),
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
        "List the known doc_type vocabulary so new documents reuse existing names rather than " +
        "introducing spelling variants. Includes whether each type preserves history.",
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

  return server;
}
