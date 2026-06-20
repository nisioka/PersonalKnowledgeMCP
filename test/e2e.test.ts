import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createApp } from "../src/index.js";
import type { AppConfig, Principal } from "../src/config.js";
import type { DB } from "../src/db/index.js";

const full: Principal = { name: "full", scopes: ["private", "work", "shared"], defaultWriteScope: "private" };
const family: Principal = { name: "family", scopes: ["shared"], defaultWriteScope: "shared" };

const config: AppConfig = {
  host: "127.0.0.1",
  port: 0,
  dbPath: ":memory:",
  tokens: new Map([
    ["full-token", full],
    ["family-token", family],
  ]),
  usingDevTokens: false,
  embedding: { dimension: 256 },
};

let server: Server;
let db: DB;
let baseUrl: string;

async function connect(token: string): Promise<Client> {
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  return client;
}

function textOf(result: { content?: unknown }): string {
  const content = result.content as { type: string; text: string }[] | undefined;
  return content?.map((c) => c.text).join("\n") ?? "";
}

beforeAll(async () => {
  const built = createApp(config);
  db = built.db;
  await new Promise<void>((resolve) => {
    server = built.app.listen(0, "127.0.0.1", () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  db.close();
});

describe("MCP server over HTTP", () => {
  it("lists the register and search tools", async () => {
    const client = await connect("full-token");
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["register", "search"]);
    await client.close();
  });

  it("registers then finds a document", async () => {
    const client = await connect("full-token");
    const reg = await client.callTool({
      name: "register",
      arguments: { full_text: "保育園の電話番号は03-1234-5678", doc_type: "連絡先", scope: "shared" },
    });
    expect(JSON.parse(textOf(reg)).ok).toBe(true);

    const search = await client.callTool({ name: "search", arguments: { query: "電話番号" } });
    const payload = JSON.parse(textOf(search));
    expect(payload.count).toBeGreaterThanOrEqual(1);
    expect(payload.results[0].snippet).toContain("電話番号");
    await client.close();
  });

  it("rejects unauthenticated requests", async () => {
    const client = new Client({ name: "noauth", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`));
    await expect(client.connect(transport)).rejects.toBeTruthy();
  });

  it("enforces write scope: family cannot write private", async () => {
    const client = await connect("family-token");
    const reg = await client.callTool({
      name: "register",
      arguments: { full_text: "secret", scope: "private" },
    });
    expect(reg.isError).toBe(true);
    expect(textOf(reg)).toMatch(/not permitted to write scope/);
    await client.close();
  });

  it("enforces read scope: family cannot see private docs", async () => {
    const adminClient = await connect("full-token");
    await adminClient.callTool({
      name: "register",
      arguments: { full_text: "プライベートな秘密メモ secretmemo", scope: "private" },
    });
    await adminClient.close();

    const familyClient = await connect("family-token");
    const search = await familyClient.callTool({ name: "search", arguments: { query: "secretmemo" } });
    const payload = JSON.parse(textOf(search));
    expect(payload.count).toBe(0);
    await familyClient.close();
  });
});
