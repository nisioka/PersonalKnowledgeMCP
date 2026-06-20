/**
 * MCP server wiring: the `register` and `search` tools (design Phase 1).
 *
 * A server is built per request with the authenticated principal captured in
 * closure, so scope enforcement (via the store + guard) always uses the real
 * caller identity rather than anything the client claims.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Principal } from "../config.js";
import { AuthError } from "../auth/guard.js";
import { DocumentStore, ValidationError } from "../store/documents.js";
import { SCOPES } from "../types.js";

export interface ToolContext {
  store: DocumentStore;
  principal: Principal;
}

const scopeEnum = z.enum(SCOPES);

function jsonContent(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] };
}

function errorContent(error: unknown) {
  const message =
    error instanceof AuthError || error instanceof ValidationError
      ? error.message
      : `internal error: ${(error as Error).message ?? String(error)}`;
  return { isError: true as const, content: [{ type: "text" as const, text: message }] };
}

export function buildServer(ctx: ToolContext): McpServer {
  const server = new McpServer(
    { name: "personal-knowledge-mcp", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.registerTool(
    "register",
    {
      title: "Register knowledge",
      description:
        "Store a piece of household knowledge (text, optionally with an original file path). " +
        "Raw text is always kept alongside extracted metadata. The scope you request is " +
        "authorized against your token; unauthorized scopes are rejected.",
      inputSchema: {
        full_text: z.string().min(1).describe("The full text to store (OCR result or input text)."),
        source_type: z.string().optional().describe("Ingestion path, e.g. 'mcp' | 'discord'. Default 'mcp'."),
        raw_path: z.string().nullable().optional().describe("Path to the original file, if any."),
        doc_type: z.string().nullable().optional().describe("Document type, e.g. '保証書' | '学校手紙'."),
        extracted: z.record(z.unknown()).optional().describe("Extracted metadata as a JSON object."),
        scope: scopeEnum.optional().describe("Target scope. Defaults to your token's default write scope."),
        valid_until: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional()
          .describe("Expiry date 'YYYY-MM-DD'. Omit for no expiry (9999-12-31)."),
      },
    },
    async (args) => {
      try {
        const doc = await ctx.store.register(ctx.principal, args);
        return jsonContent({ ok: true, id: doc.id, scope: doc.scope, valid_until: doc.valid_until });
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
        query: z.string().min(1).describe("Free-text query."),
        mode: z
          .enum(["keyword", "vector", "hybrid"])
          .optional()
          .describe("Search mode. Default 'keyword'."),
        scopes: z.array(scopeEnum).optional().describe("Restrict to these scopes (intersected with your token)."),
        doc_type: z.string().optional().describe("Restrict to a single doc_type."),
        include_expired: z
          .boolean()
          .optional()
          .describe("Include expired documents (valid_until < today) for history lookups."),
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

  return server;
}
