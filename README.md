# Personal Knowledge MCP

A household knowledge base exposed to Claude over MCP. Store family/household
information (warranties, school letters, municipal notices, contacts, life log,
…) and let Claude search and register it, so suggestions can be grounded in your
actual household context.

The full system design is in [`docs/design.md`](docs/design.md). This repository
currently implements **Phase 1: the LAN-only minimal foundation**.

## Status — Phase 1 (implemented)

Per the roadmap in design §8, Phase 1 covers:

1. **Schema** — `documents` table with `scope`, `valid_until`, `deleted`, an FTS5
   keyword index, and a `sqlite-vec` vector table.
2. **Permission guard** — a single choke point (`src/auth/guard.ts`) that derives
   allowed scopes from the caller's token and forces `scope IN (...)` into every
   query. The default search lifecycle filter is `deleted = 0 AND valid_until >= today`.
3. **MCP server** — a Streamable HTTP server exposing two tools, `register` and
   `search`, with server-side scope enforcement.
4. **LAN reachable** — verified end to end by an MCP client over HTTP (see tests).

Not yet built (later phases): Discord ingestion + OCR (Phase 2), `update` tool &
deduplication (Phase 2), Google Drive backup (Phase 2), Cloudflare Tunnel/Access
exposure (Phase 3), proactive reminders (Phase 4). A real embedding model also
replaces the Phase-1 placeholder (see below).

## Architecture (Phase 1)

```
Claude (Code CLI / Web / app)
        │  Streamable HTTP + Bearer token
        ▼
  Express  POST /mcp           src/index.ts      ← authenticate, per-request MCP server
        │
  MCP tools: register, search  src/mcp/server.ts
        │
  Permission guard             src/auth/guard.ts ← token → allowed scopes (never trusts client)
        │
  DocumentStore                src/store/        ← scope-enforced SQL, FTS + vector + hybrid
        │
  SQLite + FTS5 + sqlite-vec   src/db/           ← documents, documents_fts, documents_vec
```

### Search

- `keyword` (default) — FTS5 with the **trigram** tokenizer, so substring search
  works for Japanese and English alike (queries must be ≥ 3 characters to match).
- `vector` — KNN over `sqlite-vec`.
- `hybrid` — Reciprocal Rank Fusion of the two.

### Embeddings — placeholder

Phase 1 ships a deterministic, offline `HashingEmbedder` so the vector pipeline
runs with no API key. It captures lexical overlap but **not real semantics**;
keyword search is the reliable default. Swap in a real embedder by implementing
the `Embedder` interface (`src/embedding.ts`) and wiring it in `createApp`.

## Setup

Requires Node.js ≥ 22.

```bash
npm install
npm run build      # compile to dist/
npm test           # run the vitest suite
```

Run the server:

```bash
# Dev (built-in DEV tokens, loopback only)
npm run dev

# Production-ish
npm run build && npm start
```

Configuration is via environment variables (see [`.env.example`](.env.example)):

| Var | Default | Meaning |
|---|---|---|
| `PK_HOST` | `127.0.0.1` | Bind address. Set `0.0.0.0` for LAN access. |
| `PK_PORT` | `8848` | Listen port. |
| `PK_DB_PATH` | `data/knowledge.db` | SQLite store path (created if missing). |
| `PK_EMBEDDING_DIM` | `256` | Vector dimension (fixed at DB creation). |
| `PK_TOKENS` | *(dev tokens)* | JSON token → principal registry. |

When `PK_TOKENS` is unset, built-in **DEV** tokens are used for LAN bring-up:
`full-dev-token`, `work-dev-token`, `family-dev-token`. Replace these before
exposing the server beyond your local network.

`PK_TOKENS` example (`shared` is added to every principal automatically):

```json
{
  "<full-secret>":   { "name": "full",   "scopes": ["private", "work", "shared"], "defaultWriteScope": "private" },
  "<work-secret>":   { "name": "work",   "scopes": ["work", "shared"] },
  "<family-secret>": { "name": "family", "scopes": ["shared"] }
}
```

## Connecting from Claude Code

Add it as a remote MCP server (adjust host/port/token):

```bash
claude mcp add --transport http personal-knowledge \
  http://SERVER-IP:8848/mcp \
  --header "Authorization: Bearer full-dev-token"
```

Then ask Claude to `register` knowledge or `search` it. A quick health check:

```bash
curl http://SERVER-IP:8848/health
```

## Tools

### `register`
Stores a document. Raw text is always kept alongside extracted metadata.

| Field | Required | Notes |
|---|---|---|
| `full_text` | ✓ | The text to store. |
| `scope` | | Authorized against your token; defaults to the token's default write scope. |
| `doc_type` | | e.g. `保証書`, `学校手紙`. |
| `valid_until` | | `YYYY-MM-DD`; omit for no expiry (`9999-12-31`). |
| `extracted` | | Arbitrary JSON metadata object. |
| `raw_path` | | Path to an original file, if any. |
| `source_type` | | Ingestion path; defaults to `mcp`. |

### `search`
Searches stored knowledge. Returns only non-deleted, non-expired documents in
scopes your token can read, unless overridden.

| Field | Required | Notes |
|---|---|---|
| `query` | ✓ | Free text (≥ 3 chars for keyword matching). |
| `mode` | | `keyword` (default), `vector`, `hybrid`. |
| `scopes` | | Restrict scopes (intersected with your token). |
| `doc_type` | | Restrict to one type. |
| `include_expired` | | Include expired docs for history lookups. |
| `limit` | | Max results (default 10). |

## Security notes

- The server **never trusts a client-supplied scope**; it is always intersected
  with the token's allowed set, and writes outside that set are rejected.
- `shared` knowledge is visible to every token that permits it.
- Authenticated requests are audit-logged (`src/audit.ts`).
- The default bind is loopback; LAN/Tunnel exposure is opt-in (design §6–§7).

## Project layout

```
src/
  config.ts         token → principal registry, runtime config
  types.ts          domain types
  audit.ts          one-line audit logging
  embedding.ts      Embedder interface + Phase-1 hashing placeholder
  auth/guard.ts     permission guard (the authorization choke point)
  db/index.ts       SQLite + FTS5 + sqlite-vec schema/open
  store/documents.ts scope-enforced register/search/get
  mcp/server.ts     register & search MCP tools
  index.ts          Express + Streamable HTTP entrypoint
test/               guard, store, config, and HTTP end-to-end tests
docs/design.md      full system design
```
