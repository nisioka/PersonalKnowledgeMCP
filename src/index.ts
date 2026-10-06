#!/usr/bin/env node
/**
 * HTTP entrypoint. Exposes the MCP server over Streamable HTTP at POST /mcp.
 *
 * Auth happens here: the bearer token is resolved to a principal, then a fresh
 * MCP server is built per request (stateless) with that principal captured in
 * closure. This keeps scope enforcement tied to the real caller (design §5).
 */
import express, { type Request, type Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import "dotenv/config";
import { isLoopbackHost, loadConfig } from "./config.js";
import { openDatabase, type DB } from "./db/index.js";
import type { AppConfig } from "./config.js";
import type { Express } from "express";
import { createEmbedder } from "./embedding.js";
import { DocumentStore } from "./store/documents.js";
import { DocTypeRegistry } from "./doctype/registry.js";
import { AuthError, resolvePrincipal } from "./auth/guard.js";
import { buildServer } from "./mcp/server.js";
import { audit } from "./audit.js";
import { redactString } from "./redact.js";
import { SERVER_NAME, VERSION } from "./version.js";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

/**
 * Write a JSON-RPC 2.0 error envelope. Auth failures (401/403) use -32001 so a
 * client can tell "your token is wrong" from a server-side fault (-32000); `id`
 * is null because the request may have failed before it could be parsed.
 */
function jsonRpcError(res: Response, status: number, message: string): void {
  res.status(status).json({
    jsonrpc: "2.0",
    error: { code: status === 401 || status === 403 ? -32001 : -32000, message },
    id: null,
  });
}

/**
 * Build the Express app and everything it owns (DB, embedder, store). It does
 * NOT bind a port: tests call this directly and listen on their own loopback
 * socket, and the dev-token bind guard lives at the real bind site in `main`.
 */
export function createApp(config: AppConfig = loadConfig()): { app: Express; db: DB; config: AppConfig } {
  const embedder = createEmbedder(config);
  const db = openDatabase(config.dbPath, {
    embeddingDim: embedder.dimension,
    key: config.dbKey,
  });
  const docTypes = new DocTypeRegistry(db);
  const store = new DocumentStore(db, embedder, docTypes);

  const app = express();
  app.use(express.json({ limit: "10mb" }));

  app.get("/health", (_req, res) => {
    res.json({ ok: true, name: SERVER_NAME, version: VERSION });
  });

  app.post("/mcp", async (req: Request, res: Response) => {
    let principalName = "anonymous";
    try {
      const principal = resolvePrincipal(
        {
          authorization: req.header("authorization"),
          accessEmail: req.header("cf-access-authenticated-user-email"),
        },
        config,
      );
      principalName = principal.name;

      const method = (req.body as { method?: string } | undefined)?.method;
      if (method) audit("mcp.request", principalName, { method });

      // Stateless: one server + transport per request, closing on completion.
      const server = buildServer({ store, principal, docTypes });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on("close", () => {
        transport.close();
        server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      if (error instanceof AuthError) {
        audit("auth.denied", principalName, { status: error.status, reason: error.message });
        if (!res.headersSent) jsonRpcError(res, error.status, error.message);
        return;
      }
      // Null-safe: a thrown non-Error (null/undefined/primitive) must not cause a
      // secondary crash. Redact: a stack/message can echo request-body content.
      const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
      process.stderr.write(`[error] ${redactString(detail)}\n`);
      if (!res.headersSent) jsonRpcError(res, 500, "internal error");
    }
  });

  // Streamable HTTP GET/DELETE are only meaningful with sessions (stateful).
  const methodNotAllowed = (_req: Request, res: Response) =>
    jsonRpcError(res, 405, "method not allowed (stateless server)");
  app.get("/mcp", methodNotAllowed);
  app.delete("/mcp", methodNotAllowed);

  return { app, db, config };
}

/**
 * CLI entrypoint: load config, refuse an unsafe bind, then listen.
 *
 * The refusal is not a style choice. DEV_TOKENS are hard-coded and shipped in
 * the published npm package, so anyone who can reach a non-loopback port also
 * knows `full-dev-token` and gets a `full`-scoped principal (CWE-798). A
 * warning on stderr does not stop that, so we exit instead of listening. The
 * way out is PK_TOKENS, not a flag: there is no safe way to expose the
 * built-in tokens.
 */
function main(): void {
  const config = loadConfig();

  if (config.usingDevTokens && !isLoopbackHost(config.host)) {
    process.stderr.write(
      `[fatal] refusing to listen on ${config.host} with the built-in DEV tokens. ` +
        "They ship inside this package, so a non-loopback bind is unauthenticated in practice. " +
        "Set PK_TOKENS to your own secrets, or keep PK_HOST on loopback (127.0.0.1).\n",
    );
    process.exit(1);
  }

  // After the guard: opening the DB creates the file, and a refused start
  // should leave nothing behind.
  const { app } = createApp(config);

  if (config.usingDevTokens) {
    process.stderr.write(
      "[warn] PK_TOKENS not set — using built-in DEV tokens " +
        "(full-dev-token / work-dev-token / family-dev-token). Loopback only; " +
        "set PK_TOKENS before binding anywhere else.\n",
    );
  }

  app.listen(config.port, config.host, () => {
    process.stderr.write(
      `[info] personal-knowledge-mcp listening on http://${config.host}:${config.port}/mcp ` +
        `(db: ${config.dbPath}, embeddingDim: ${config.embedding.dimension})\n`,
    );
  });
}

/**
 * True when this file is the process entrypoint (as opposed to being imported
 * by tests). `process.argv[1]` cannot be compared to `import.meta.url` as a raw
 * string: npm installs `bin` entries as a symlink in `node_modules/.bin`, so
 * `npx pk-mcp` passes the symlink path while `import.meta.url` is the real
 * file — the naive comparison is false and the server silently never starts.
 * Resolving the symlink and encoding through `pathToFileURL` also handles paths
 * with spaces or non-ASCII characters, which `file://${...}` leaves unescaped.
 */
function isMain(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false; // `node -e`, REPL
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false; // entry was deleted or is not a real path
  }
}

if (isMain()) {
  main();
}
