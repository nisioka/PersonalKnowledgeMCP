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
  accessEmails: new Map(),
  trustAccessHeader: false,
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
  it("lists all knowledge tools", async () => {
    const client = await connect("full-token");
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "delete",
      "delete_doc_type",
      "list_doc_types",
      "list_pending",
      "register",
      "restore",
      "review_dates",
      "search",
      "upcoming",
      "update",
      "upsert_doc_type",
    ]);
    await client.close();
  });

  it("registers then finds a document", async () => {
    const client = await connect("full-token");
    // doc_type vocabulary is strict (§9.5): create it before using it.
    await client.callTool({ name: "upsert_doc_type", arguments: { name: "連絡先" } });
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

  it("requires confirmation before a destructive delete", async () => {
    const client = await connect("full-token");
    const reg = await client.callTool({
      name: "register",
      arguments: { full_text: "confirmflowdoc to be deleted", scope: "shared" },
    });
    const id = JSON.parse(textOf(reg)).id as number;

    // First call: no confirm -> preview, no mutation.
    const preview = await client.callTool({ name: "delete", arguments: { id } });
    const previewPayload = JSON.parse(textOf(preview));
    expect(previewPayload.requires_confirmation).toBe(true);
    expect(JSON.parse(textOf(await client.callTool({ name: "search", arguments: { query: "confirmflowdoc" } }))).count).toBe(1);

    // Second call: confirm -> archived.
    const done = await client.callTool({ name: "delete", arguments: { id, confirm: true } });
    expect(JSON.parse(textOf(done)).mode).toBe("soft");
    expect(JSON.parse(textOf(await client.callTool({ name: "search", arguments: { query: "confirmflowdoc" } }))).count).toBe(0);
    await client.close();
  });

  it("grows the vocabulary via upsert_doc_type (roundtrip)", async () => {
    // Note: the e2e DB is shared across tests, so this asserts the upsert→list
    // roundtrip rather than global emptiness (empty-start is covered in store.test).
    const client = await connect("full-token");
    const up = await client.callTool({
      name: "upsert_doc_type",
      arguments: { name: "製品保証", description: "家電・製品の保証", default_lifecycle: "singleton" },
    });
    expect(JSON.parse(textOf(up)).doc_type.name).toBe("製品保証");

    const after = JSON.parse(textOf(await client.callTool({ name: "list_doc_types", arguments: {} })));
    expect(after.doc_types.some((d: { name: string }) => d.name === "製品保証")).toBe(true);
    await client.close();
  });

  it("register rejects an unknown doc_type (strict vocabulary)", async () => {
    const client = await connect("full-token");
    const reg = await client.callTool({
      name: "register",
      arguments: { full_text: "x", doc_type: "存在しない型", scope: "shared" },
    });
    expect(reg.isError).toBe(true);
    expect(textOf(reg)).toMatch(/unknown doc_type/);
    await client.close();
  });

  it("delete_doc_type refuses while in use, then succeeds with force", async () => {
    const client = await connect("full-token");
    await client.callTool({ name: "upsert_doc_type", arguments: { name: "一時型" } });
    await client.callTool({
      name: "register",
      arguments: { full_text: "使用中ドキュメント inuse", doc_type: "一時型", scope: "shared" },
    });
    const refused = JSON.parse(textOf(await client.callTool({ name: "delete_doc_type", arguments: { name: "一時型" } })));
    expect(refused.removed).toBe(false);
    expect(refused.in_use).toBe(1);

    const forced = JSON.parse(
      textOf(await client.callTool({ name: "delete_doc_type", arguments: { name: "一時型", force: true } })),
    );
    expect(forced.removed).toBe(true);
    await client.close();
  });

  it("restricts vocabulary mutation to a full-access token", async () => {
    const client = await connect("family-token");
    const res = await client.callTool({ name: "upsert_doc_type", arguments: { name: "家族が作る型" } });
    expect(res.isError).toBe(true);
    await client.close();
  });

  it("reviews a document's dates: list_pending → review_dates → upcoming", async () => {
    const client = await connect("full-token");
    /** Call a tool and parse its JSON text result. */
    const call = async (name: string, args: Record<string, unknown>) =>
      JSON.parse(textOf(await client.callTool({ name, arguments: args })));

    const reg = await call("register", {
      full_text: "遠足のお知らせ 持ち物はお弁当と水筒です datesflow",
      scope: "shared",
      extracted: {
        title: "遠足のお知らせ",
        dates: [
          { date: "2031-05-10", kind: "event", title: "遠足" },
          { date: "2031-05-02", kind: "deadline", title: "参加申込の締切" },
          { date: "2031-05-06", kind: "event", title: "読み取り違いの予定" },
        ],
      },
    });
    const docId = reg.id as number;

    // Right after register, the caller gets this document's candidates with row ids.
    const pending = await call("list_pending", { doc_id: docId });
    expect(pending.documents).toHaveLength(1);
    expect(pending.documents[0].title).toBe("遠足のお知らせ");
    const items = pending.documents[0].items as { id: number; date: string; title: string }[];
    expect(items.map((i) => i.title)).toEqual(["参加申込の締切", "読み取り違いの予定", "遠足"]);

    // Reject one row on its own, then approve the rest.
    const wrong = items[1]!.id;
    const rejected = await call("review_dates", { doc_id: docId, reject_ids: [wrong] });
    expect(rejected).toMatchObject({ ok: true, rejected: [wrong], approved: [], pending: 2 });
    const approved = await call("review_dates", { doc_id: docId, approve_all: true });
    expect(approved).toMatchObject({ ok: true, rejected: [], pending: 0 });
    expect(approved.approved).toHaveLength(2);
    expect((await call("list_pending", { doc_id: docId })).documents).toEqual([]);

    // The digest carries the bare fields only — no extracted metadata, no text.
    const upcoming = await call("upcoming", { from: "2031-05-01", to: "2031-05-31", scopes: ["shared"] });
    const mine = (upcoming.items as { doc_id: number }[]).filter((i) => i.doc_id === docId);
    expect(mine).toEqual([
      { date: "2031-05-02", kind: "deadline", title: "参加申込の締切", review_status: "approved", doc_id: docId, scope: "shared" },
      { date: "2031-05-10", kind: "event", title: "遠足", review_status: "approved", doc_id: docId, scope: "shared" },
    ]);
    await client.close();
  });

  it("register rejects malformed extracted.dates with a fixable message", async () => {
    const client = await connect("full-token");
    const reg = await client.callTool({
      name: "register",
      arguments: { full_text: "x", scope: "shared", extracted: { dates: [{ date: "5月10日", kind: "event", title: "遠足" }] } },
    });
    expect(reg.isError).toBe(true);
    expect(textOf(reg)).toMatch(/extracted\.dates\[0\]\.date/);
    await client.close();
  });

  it("review_dates follows write permission: family cannot review a private document", async () => {
    const admin = await connect("full-token");
    const reg = JSON.parse(
      textOf(
        await admin.callTool({
          name: "register",
          arguments: {
            full_text: "プライベートな予定 privatedates",
            scope: "private",
            extracted: { dates: [{ date: "2031-07-01", kind: "event", title: "個人の予定" }] },
          },
        }),
      ),
    );
    await admin.close();

    const familyClient = await connect("family-token");
    const res = await familyClient.callTool({ name: "review_dates", arguments: { doc_id: reg.id, approve_all: true } });
    expect(res.isError).toBe(true);
    const upcoming = JSON.parse(
      textOf(await familyClient.callTool({ name: "upcoming", arguments: { from: "2031-07-01", to: "2031-07-01" } })),
    );
    expect(upcoming.items).toEqual([]);
    await familyClient.close();
  });

  it("exposes the ingest_document prompt (guidance, empty vocabulary)", async () => {
    const client = await connect("full-token");
    const { prompts } = await client.listPrompts();
    expect(prompts.map((p) => p.name)).toContain("ingest_document");

    const got = await client.getPrompt({ name: "ingest_document" });
    const text = got.messages.map((m) => (m.content as { type: string; text: string }).text).join("\n");
    expect(text).toContain("register");
    expect(text).toContain("lifecycle");
    // Dates are always extracted into the common key, with notification-safe titles.
    expect(text).toContain("extracted.dates");
    expect(text).toContain("金額は件名に入れない");
    await client.close();
  });
});
