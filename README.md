# Personal Knowledge MCP

A household knowledge base exposed to Claude over MCP. Store family/household
information (warranties, school letters, municipal notices, contacts, life log,
…), let Claude search and register it, ingest documents via Discord with OCR, and
get proactive reminders before things expire — so suggestions are grounded in
your actual household context.

The full system design is in [`docs/design.md`](docs/design.md). All four roadmap
phases (design §8) are implemented; the components that touch external services
(Discord, Cloudflare, Google Drive, Anthropic) need credentials to run, but the
code, tests, config, and deployment units are all here.

## What's implemented

| Phase | Scope | Status |
|---|---|---|
| 1 | Schema, permission guard, MCP server (`register`/`search`), LAN-reachable | ✅ |
| 2 | Discord ingestion, PaddleOCR + Anthropic extraction, externalized prompts, `update`/`delete`/`restore` + dedup, encrypted Google Drive backup | ✅ |
| 3 | Cloudflare Tunnel + Access (email→scope header mapping), per-route tokens | ✅ |
| 4 | Audit logging, destructive-op confirmation flow, proactive expiry reminders, doc_type vocabulary | ✅ |

## Architecture

```
Ingestion                         Knowledge Store                 Retrieval / Reasoning
─────────                         ───────────────                 ─────────────────────
Discord bot ─ OCR+extract ─┐                                      Claude (Code / Web / app)
(src/ingest, python/)      ├─►  DocumentStore  ─► SQLite + FTS5         │ Streamable HTTP
MCP register tool ─────────┘    (src/store)       + sqlite-vec          ▼
                                   ▲  scope-enforced SQL          Express POST /mcp (src/index.ts)
                                   │                                 │ authenticate (token | CF Access)
Permission guard (src/auth) ───────┘                                ▼
                                                                  MCP tools (src/mcp): register,
Reminders cron ─► Discord webhook (src/reminders)                 search, update, delete, restore,
Backup cron ─► encrypted → Google Drive (src/backup)              list_doc_types
```

Design principles enforced in code: a **single DB** split logically by `scope`;
**authorization decided server-side by the token** (clients never pick their own
scope); **raw text + extracted JSON kept together**; lifecycle handled by a
**date filter** (`valid_until`) rather than status cron.

## Setup

Requires Node.js ≥ 22 (and Python 3.10+ for OCR).

```bash
npm install
npm run build
npm test          # 52 tests
cp .env.example .env   # then edit
```

Run the MCP server:

```bash
npm run dev            # dev (DEV tokens, loopback)
npm run build && npm start
```

| Component | Command | Needs |
|---|---|---|
| MCP server | `npm start` | — (DEV tokens for LAN) |
| Discord bot | `npm run discord` | `DISCORD_TOKEN` |
| OCR/extract service | `uvicorn ingest_service:app` (in `python/`) | PaddleOCR; `ANTHROPIC_API_KEY` for extraction |
| Backup | `npm run backup` | `PK_BACKUP_PASSPHRASE`, `PK_BACKUP_FOLDER_ID`, Google creds |
| Restore | `npm run restore [path]` | same |
| Reminders | `npm run reminders` | `PK_REMINDER_WEBHOOK` (optional) |

All configuration is via environment variables — see [`.env.example`](.env.example).

## MCP tools

| Tool | Purpose | Notes |
|---|---|---|
| `register` | Store knowledge | `dedup_key` supersedes prior versions (skipped for history doc_types) |
| `search` | Search | `keyword` (default, trigram FTS — JP/EN substring, ≥3 chars), `vector`, `hybrid`; `include_expired` for history |
| `update` | Overwrite fields | **Destructive**: returns a preview unless `confirm: true` (§9.4) |
| `delete` | Archive or remove | `mode: soft` (default, reversible) / `hard`; preview unless `confirm: true` |
| `restore` | Un-archive | reverses a soft delete |
| `list_doc_types` | Vocabulary | keeps doc_type spelling convergent (§9.5) |

### Connecting from Claude Code (LAN)

```bash
claude mcp add --transport http personal-knowledge \
  http://SERVER-IP:8848/mcp \
  --header "Authorization: Bearer full-dev-token"
```

### Lifecycle & dedup

- `valid_until` (date) drives expiry; the sentinel `9999-12-31` means "no expiry".
  Default search returns only `deleted = 0 AND valid_until >= today`.
- `deleted` is a manual archive flag, orthogonal to expiry.
- `dedup_key` lets an update of a "latest-only" fact (a phone number, current
  plan) supersede the previous version, while history doc_types (each year's tax
  amount) are never superseded.

### Embeddings — placeholder

A deterministic, offline `HashingEmbedder` runs the vector pipeline with no API
key; it captures lexical overlap, not real semantics, so keyword search is the
reliable default. Implement the `Embedder` interface (`src/embedding.ts`) to plug
in a real model.

## Document ingestion (Discord + OCR)

1. Start the Python service (`python/ingest_service.py`) — PaddleOCR for
   image/PDF → text, Anthropic for text → structured metadata using the
   per-`doc_type` prompts in [`prompts/`](prompts/).
2. Start the Discord bot (`npm run discord`) and drop an image/PDF (or text) into
   a watched channel. The bot OCRs, extracts, saves the original under
   `PK_FILES_DIR`, and registers the document into the same store the MCP server
   reads. It replies with the id / doc_type / expiry.

If `PK_INGEST_URL` is unset the bot still stores raw text (no OCR).

**Privacy:** the bot processes only DMs plus channel ids listed in
`PK_DISCORD_CHANNEL_IDS` (comma-separated). With none set it is **DM-only** — it
never ingests arbitrary server channels.

## External exposure (Cloudflare)

Put the LAN server behind a Cloudflare Tunnel + Access (no open ports, home IP
hidden) — see [`deploy/cloudflared-config.example.yml`](deploy/cloudflared-config.example.yml).
Access injects `Cf-Access-Authenticated-User-Email`; set
`PK_TRUST_ACCESS_HEADER=true` and `PK_ACCESS_EMAILS` to map authenticated emails
to scopes. Register the public URL as a custom connector on claude.ai (Web), and
it syncs to the mobile app.

**Transport note:** the server runs Streamable HTTP in *stateless* mode and
returns `405` on `GET /mcp`. This is spec-compliant — the MCP Streamable HTTP
spec says a server MUST either return `text/event-stream` on GET **or** `405`
when it doesn't offer a server→client stream, and compliant clients fall back to
POST. Anthropic's remote connectors use Streamable HTTP (legacy HTTP+SSE is
deprecated), so no separate SSE transport is needed.

## Backup & reminders

- **Backup** (§9.2): SQLite only, WAL-safe online snapshot, AES-256-GCM encrypted
  (scrypt-derived key) *before* upload to Google Drive. Original files are not
  backed up by design — `full_text` keeps documents searchable after a restore.
- **Reminders** (§4): a daily scan posts items expiring within
  `PK_REMINDER_DAYS` to a Discord webhook.

Both are one-shot CLIs meant for system cron — `systemd` service+timer units are
in [`deploy/systemd/`](deploy/systemd/).

**Restore caveat:** stop the MCP server (`pk-mcp.service`) before `npm run
restore` — overwriting a live SQLite file corrupts it. The restore CLI removes
stale `-wal`/`-shm` sidecars (which belong to the old DB) and prints this warning.

## Security notes

- The server **never trusts a client-supplied scope**; it's intersected with the
  token's allowed set, and out-of-scope writes are rejected.
- `shared` knowledge is visible to every token that permits it.
- Destructive operations require explicit `confirm: true` (§9.4).
- Every authenticated request is audit-logged (`src/audit.ts`).
- The CF Access email header is honored only when `PK_TRUST_ACCESS_HEADER=true`,
  so it can't be spoofed on the LAN.
- Data (SQLite, files) stays on the home server; only tool responses leave it.

## Project layout

```
src/
  config.ts            token/email → principal registry, runtime config
  types.ts             domain types
  audit.ts             one-line audit logging
  embedding.ts         Embedder interface + Phase-1 hashing placeholder
  auth/guard.ts        permission guard + request principal resolution
  db/index.ts          SQLite + FTS5 (trigram) + sqlite-vec schema
  doctype/registry.ts  doc_type vocabulary + history rules
  store/documents.ts   scope-enforced register/search/update/delete/restore + reminders
  mcp/server.ts        MCP tools (register/search/update/delete/restore/list_doc_types)
  index.ts            Express + Streamable HTTP entrypoint
  ingest/              Discord bot + OCR/extraction HTTP client
  backup/              AES-256-GCM crypto, Drive backup/restore, CLI
  reminders/           expiry scan → Discord, CLI
python/                FastAPI OCR (PaddleOCR) + extraction (Anthropic) service
prompts/               externalized per-doc_type extraction prompts
deploy/                Cloudflare Tunnel config + systemd units/timers
test/                  guard, store, config, backup, reminder, and HTTP e2e tests
docs/design.md         full system design
```
