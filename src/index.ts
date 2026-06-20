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
import { loadConfig } from "./config.js";
import { openDatabase, type DB } from "./db/index.js";
import type { AppConfig } from "./config.js";
import type { Express } from "express";
import { HashingEmbedder } from "./embedding.js";
import { DocumentStore } from "./store/documents.js";
import { DocTypeRegistry } from "./doctype/registry.js";
import { AuthError, resolvePrincipal } from "./auth/guard.js";
import { buildServer } from "./mcp/server.js";
import { audit } from "./audit.js";
import { SERVER_NAME, VERSION } from "./version.js";

function jsonRpcError(res: Response, status: number, message: string): void {
  res.status(status).json({
    jsonrpc: "2.0",
    error: { code: status === 401 || status === 403 ? -32001 : -32000, message },
    id: null,
  });
}

export function createApp(config: AppConfig = loadConfig()): { app: Express; db: DB; config: AppConfig } {
  const db = openDatabase(config.dbPath, { embeddingDim: config.embedding.dimension });
  const docTypes = new DocTypeRegistry();
  const store = new DocumentStore(db, new HashingEmbedder(config.embedding.dimension), docTypes);

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
      process.stderr.write(`[error] ${(error as Error).stack ?? String(error)}\n`);
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

function main(): void {
  const config = loadConfig();
  const { app } = createApp(config);

  if (config.usingDevTokens) {
    process.stderr.write(
      "[warn] PK_TOKENS not set — using built-in DEV tokens " +
        "(full-dev-token / work-dev-token / family-dev-token). Do NOT expose this beyond LAN.\n",
    );
  }

  app.listen(config.port, config.host, () => {
    process.stderr.write(
      `[info] personal-knowledge-mcp listening on http://${config.host}:${config.port}/mcp ` +
        `(db: ${config.dbPath}, embeddingDim: ${config.embedding.dimension})\n`,
    );
  });
}

// Run only when executed directly (not when imported by tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
