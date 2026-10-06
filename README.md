# Personal Knowledge MCP

自分のための知識ベースを自分のマシンに置き、MCP 経由で Claude から検索・登録できる
ようにするサーバーです。保証書・お知らせ・通知・連絡先・ライフログのような「後で
参照したいが、どこかのサービスに預けたくはない」情報を対象にしています。

- **書類はそのまま渡せる。** 画像・PDF・テキストを Claude に添付して MCP プロンプト
  `ingest_document` を実行すると、Claude 自身が読み取って構造化し登録します。OCR も
  抽出も Claude がやるので、別途 API キーも外部サービスも要りません
- **期限を持った知識を扱える。** 保証期限や提出期限を `valid_until` として持ち、
  既定の検索は期限切れを返しません。期限が近づくと Discord へ能動的に通知します
- **誰が何を見られるかはサーバーが決める。** アクセストークンごとに `private` /
  `work` / `shared` のスコープを固定し、クライアント側からは選べません
- **置き場所はあなたのマシン。** SQLite ファイル1つが実体です。任意で SQLCipher に
  よる保存時暗号化を掛けられます。マシンの外に出るのは Google Drive バックアップを
  有効にしたときだけで、そのとき送られるのは暗号化済みのバックアップです

<details>
<summary><b>English summary</b>（要約のみ。本文は日本語です / summary only, the rest of this README is in Japanese）</summary>

A self-hosted MCP server that turns a private SQLite database into a knowledge
base Claude can search and write to over Streamable HTTP.

- **Document intake without an API key.** Attach an image/PDF/text file in
  Claude and run the `ingest_document` MCP prompt: Claude reads the document,
  structures it, and calls `register`. No OCR service, no `ANTHROPIC_API_KEY`.
- **Expiry-aware knowledge.** Every record carries a `valid_until` date; the
  default search hides expired entries, and a daily job posts upcoming
  expiries to a Discord webhook.
- **Server-side scope enforcement.** Each bearer token is pinned to a set of
  scopes (`private` / `work` / `shared`); clients cannot choose their own.
- **Your data lives on your own machine.** One SQLite file, with optional
  SQLCipher at-rest encryption. Nothing leaves the machine unless you turn on
  the Google Drive backup, which uploads an encrypted copy.

Tools: `register`, `search`, `update`, `delete`, `restore`, `list_doc_types`,
`upsert_doc_type`, `delete_doc_type`, plus the `ingest_document` prompt.
Install with `npm i -g personal-knowledge-mcp`, run `pk-mcp`, and point an MCP
client at `http://127.0.0.1:8848/mcp`. See the sections below for details; the
operations manual (`docs/operations.md`) is Japanese only.

</details>

システム全体の設計は [`docs/design.md`](docs/design.md) を参照してください。ロード
マップ（設計 §8）の4フェーズを実装済みです（書類取り込みは設計当初の自前 Discord bot
＋PaddleOCR ではなく、追加コストの要らない「Claude 主導」方式に変更）。

**実際に運用するための手順書は [`docs/operations.md`](docs/operations.md)**（セットアップ→
外部公開→バックアップ→リマインダーを実コマンド付きで順に解説）。

## デモ

<!-- TODO: 実際に Claude から register / search を叩いている様子の GIF をここに置く。
     画面録画が要るため未収録。 -->

_未収録です。_ 実際に動かしている様子の GIF は、画面録画が必要なためまだありません。

## インストール

Node.js ≥ 20 が必要です。ネイティブモジュール（SQLCipher 入り SQLite）を含むため、
初回インストールではビルド済みバイナリの取得が走ります。

```bash
# 常駐させる場合
npm install -g personal-knowledge-mcp
pk-mcp

# 試すだけなら
npx personal-knowledge-mcp
```

起動すると `http://127.0.0.1:8848/mcp` で Streamable HTTP を待ち受けます。DB は
`PK_DB_PATH`（既定 `data/knowledge.db`）に自動で作られます。

`PK_TOKENS` を設定しないうちは組み込みの開発用トークン `full-dev-token` /
`work-dev-token` / `family-dev-token` で動きます。**これらはパッケージに同梱された
公開の値なので、ループバックの外では認証になりません。** `PK_HOST` をループバック
以外にしたまま起動しようとすると、サーバーは待ち受けずに終了します。LAN や公開ホスト
に出すなら `PK_TOKENS` に自分の秘密を設定してください。実運用の手順は
[`docs/operations.md`](docs/operations.md) にあります。

## MCP クライアントの設定

本サーバーは stdio ではなく **Streamable HTTP** です。先に `pk-mcp` を起動しておき、
クライアントからその URL に繋ぎます。

### Claude Code

```bash
claude mcp add --transport http personal-knowledge \
  http://127.0.0.1:8848/mcp \
  --header "Authorization: Bearer full-dev-token"
```

プロジェクトに `.mcp.json` を置く場合:

```json
{
  "mcpServers": {
    "personal-knowledge": {
      "type": "http",
      "url": "http://127.0.0.1:8848/mcp",
      "headers": {
        "Authorization": "Bearer full-dev-token"
      }
    }
  }
}
```

### Claude デスクトップ / claude.ai / モバイルアプリ

「カスタムコネクタ」として登録します。コネクタの URL は **Claude のクラウドから
到達できる必要がある**ため、`127.0.0.1` は指定できません。自宅サーバーを
Cloudflare Tunnel + Access の背後に置いて公開ホスト名を与える手順が
[`docs/operations.md`](docs/operations.md) の §5〜§6 にあります。

なお `claude_desktop_config.json` について、公式ドキュメントが例示しているのは
`command` / `args` で起動する stdio サーバーだけです。HTTP サーバーを同ファイルから
繋げるかは確認できていないため、デスクトップからは Claude Code 経由か、上記の
カスタムコネクタを使ってください。

## 環境変数

`.env` か環境変数で渡します。すべて任意で、既定値のまま起動できます。完全な一覧は
[`.env.example`](.env.example) を参照してください。

| 変数 | 用途 | 既定 |
|---|---|---|
| `PK_HOST` | 待ち受けアドレス。LAN の他ホストから直接叩かせるとき以外は変えない。ループバック以外にするには `PK_TOKENS` が要る | `127.0.0.1` |
| `PK_PORT` | 待ち受けポート | `8848` |
| `PK_DB_PATH` | SQLite ファイルの場所。リポジトリ外の絶対パスを推奨 | `data/knowledge.db` |
| `PK_EMBEDDING_DIM` | 埋め込みベクトルの次元。DB 作成時に固定され、変更には作り直しが要る | `256` |
| `PK_TOKENS` | Bearer トークン → principal の JSON。principal は `name` / `scopes` / `defaultWriteScope` を持つ。未設定なら開発用トークンで、ループバック限定 | 開発用 |
| `PK_DB_PASSPHRASE` | SQLCipher の合言葉。設定すると DB ファイル全体を暗号化する。**失うと復元不能** | なし（平文） |
| `PK_TRUST_ACCESS_HEADER` | `Cf-Access-Authenticated-User-Email` を信頼する。**Cloudflare Access の背後でのみ** | `false` |
| `PK_ACCESS_EMAILS` | 認証済みメール → principal の JSON。`PK_TRUST_ACCESS_HEADER=true` のときだけ効く | なし |
| `PK_BACKUP_PASSPHRASE` | バックアップの暗号化パスフレーズ。バックアップ／リストアに必須 | なし |
| `PK_BACKUP_FOLDER_ID` | アップロード先の Google Drive フォルダ ID | なし |
| `GOOGLE_APPLICATION_CREDENTIALS` | Google サービスアカウント JSON のパス | なし |
| `PK_REMINDER_DAYS` | 何日先までの期限をリマインドするか | `14` |
| `PK_REMINDER_WEBHOOK` | リマインダーの通知先 Discord webhook | なし（通知しない） |

`PK_TOKENS` の形は次のとおりです。`shared` はどの principal にも自動で追加されます。
`defaultWriteScope` は `register` / `update` がスコープを省略したときの書き込み先で、
書かなければ `shared` 以外の最初のスコープになります。`scopes` に無い値を書くと起動時
に落ちます。

```json
{
  "<full-secret>":   { "name": "full",   "scopes": ["private", "work", "shared"], "defaultWriteScope": "private" },
  "<work-secret>":   { "name": "work",   "scopes": ["work"], "defaultWriteScope": "work" },
  "<family-secret>": { "name": "family", "scopes": ["shared"] }
}
```

## 実装状況

| フェーズ | 範囲 | 状態 |
|---|---|---|
| 1 | スキーマ、権限ガード、MCP サーバ（`register`/`search`）、LAN 到達可能 | ✅ |
| 2 | Claude 主導の書類取り込み（`ingest_document` プロンプト）、`update`/`delete`/`restore` + 名寄せ、暗号化 Google Drive バックアップ | ✅ |
| 3 | Cloudflare Tunnel + Access（メール→scope のヘッダマッピング）、経路別トークン | ✅ |
| 4 | 監査ログ、破壊的操作の確認フロー、能動的な期限リマインダー、doc_type 語彙管理 | ✅ |

## アーキテクチャ

```text
収集 (Ingestion)                  知識ストア (Store)              参照・推論 (Retrieval)
─────────                         ───────────────                 ─────────────────────
Claude が書類を読取り ─┐                                          Claude (Code / Web / アプリ)
→ register ツール ─────┼─►  DocumentStore  ─► SQLite + FTS5            │ Streamable HTTP
                       │     (src/store)       + sqlite-vec             ▼
                       │      ▲  scope を強制した SQL           Express POST /mcp (src/index.ts)
                       │      │                                   │ 認証 (token | CF Access)
権限ガード (src/auth) ─┴──────┘                                   ▼
                                                                 MCP ツール (src/mcp): register,
リマインダー cron ─► Discord webhook (src/reminders)             search, update, delete, restore,
バックアップ cron ─► 暗号化 → Google Drive (src/backup)          list_doc_types, upcoming, list_pending,
                                                                 review_dates, ＋prompt: ingest_document
```

コードで強制している設計原則：**単一 DB** を `scope` で論理分割する／**アクセス可否は
トークンでサーバ側が決定**する（クライアントが scope を自由に選べない）／**生テキストと
抽出済み JSON をペアで保持**する／ライフサイクルは状態遷移 cron ではなく **日付フィルタ**
（`valid_until`）で扱う。

## 開発環境のセットアップ

ソースから動かす場合です。Node.js ≥ 22.13 と pnpm が必要です（pnpm は `corepack enable pnpm` で入ります。`pnpm@11.8.0` が Node ≥ 22.13 を要求します）。

```bash
pnpm install
pnpm run build
pnpm test          # テスト一式
cp .env.example .env   # 編集する
```

MCP サーバの起動：

```bash
pnpm run dev            # 開発用（DEV トークン・ループバック）
pnpm run build && pnpm start
```

| コンポーネント | コマンド | 必要なもの |
|---|---|---|
| MCP サーバ | `pnpm start` | ループバックなら不要。LAN に出すなら `PK_TOKENS` |
| バックアップ | `pnpm run backup` | `PK_BACKUP_PASSPHRASE`、`PK_BACKUP_FOLDER_ID`、Google 認証情報 |
| リストア | `pnpm run restore [path]` | 同上 |
| リマインダー | `pnpm run reminders` | `PK_REMINDER_WEBHOOK`（任意） |

設定はすべて環境変数で行います——[`.env.example`](.env.example) を参照してください。

## MCP ツール

| ツール | 用途 | 備考 |
|---|---|---|
| `register` | 知識の登録 | `lifecycle=singleton` かつ `dedup_key` で旧版を supersede（`history` は対象外）。`doc_type` は null か既知語彙のみ（§9.5 v2） |
| `search` | 検索 | `keyword`（既定、trigram FTS — 日英の部分一致・3文字以上）、`vector`、`hybrid`／履歴照会は `include_expired`。結果には本文の全文（`full_text`）と1行の抜粋（`snippet`）が入る。広く一覧するときは `snippet_only: true` で全文を省ける |
| `update` | フィールド上書き | **破壊的**：`confirm: true` がなければプレビューのみ（§9.4）。`lifecycle` も変更可。プレビューにも適用後の応答にも本文の全文が入るので、`confirm` 無しで呼べば書き換える前の全文が取れる |
| `delete` | アーカイブ／削除 | `mode: soft`（既定・可逆）/ `hard`／`confirm: true` まではプレビュー。プレビューには消す文書の全文が入る |
| `restore` | アーカイブ解除 | soft delete を取り消す |
| `list_doc_types` | 語彙一覧 | doc_type 語彙は空スタート。表記ゆれを抑える（§9.5 v2） |
| `upsert_doc_type` | 語彙の作成・編集 | doc_type を追加／更新。full トークン限定 |
| `delete_doc_type` | 語彙の削除 | 使用中は拒否（`force` で強制）。full トークン限定 |
| `upcoming` | 期間内の予定・期限 | `from`〜`to`（既定は今日から10日間）の日付を日付順に返す。返すのは日付・種別・件名・承認状態・`doc_id`・`scope` だけ。却下済みと、置き換え・削除された文書の日付は出ない |
| `list_pending` | 未承認の日付の一覧 | 文書ごとにまとめ、文書のタイトルと行の id を添える。`doc_id` で1文書に絞れる（登録・更新の直後に候補を取る用途） |
| `review_dates` | 日付の承認・却下 | `approve_all` で文書の未承認分を一括承認、`reject_ids` で個別に却下。片方だけでも呼べる。書き込み権限は他の書き込み系ツールと同じ |

加えて MCP プロンプト **`ingest_document`** を提供します（添付書類を Claude 自身に読み取らせ
→ 構造化 → `register` させる定型指示。後述「書類の取り込み」参照）。

### ライフサイクルと名寄せ

- `valid_until`（日付）が期限を決める。番兵値 `9999-12-31` は「無期限」。既定検索は
  `deleted = 0 AND valid_until >= today` のみを返す。
- `deleted` は手動アーカイブ用フラグで、期限とは直交する別軸。
- `dedup_key` により「最新だけ欲しい」情報（電話番号、現行プラン等）の更新で旧版を
  supersede できる。一方、履歴系 doc_type（各年の税額など）は supersede しない。

### 文書内の日付と承認

文書が言及する日付（行事・締切・満了）は、文書本体とは別の `doc_dates` テーブルに
1件1行で持ちます（設計 §4）。

- `register` / `update` のたびに、`extracted.dates`（`[{date, kind, title}]`）と
  `valid_until`（`9999-12-31` 以外。種別は `expiry`）から同期する。
- 入った日付は `pending`（未承認）。人が `review_dates` で `approved` / `rejected` にする。
- 承認状態はこのテーブル側にあるので、文書を再抽出（`update`）しても消えない。日付と
  件名が同じ項目は承認状態を引き継ぎ、件名が変わった項目は別の項目として未承認に戻る。
- `upcoming` は未承認の日付も返す（`review_status` で見分けられる）。却下した日付だけが
  出なくなる。

### 埋め込み — プレースホルダ

決定的・オフラインの `HashingEmbedder` が API キーなしでベクトルパイプラインを動かし
ます。語彙的な重なりは捉えますが意味的な類似性は捉えないため、キーワード検索が当面の
主力です。実モデルへ差し替えるには `Embedder` インターフェース（`src/embedding.ts`）を
実装してください。

## 書類の取り込み（Claude 主導・API キー不要）

構造抽出は「推論」なので、**別課金の Anthropic API ではなく、あなたが既に契約している
Claude（Code / デスクトップ / アプリ）自身**にやらせます。Claude はマルチモーダルなので
OCR も内蔵で行え、PaddleOCR も外部サービスも `ANTHROPIC_API_KEY` も不要です（Claude の
月額プラン内で完結）。

1. Claude に書類（画像/PDF/テキスト）を添付する。
2. MCP プロンプト **`ingest_document`** を実行する（doc_type 語彙・期限推定・dedup_key の
   付け方・書類内の日付の拾い方を指示済み）。
3. Claude が全文を読み取り、構造化して `register` を呼ぶ。書類内の日付は
   `extracted.dates` に入り、未承認の候補として登録される（`list_pending` →
   `review_dates` で確認する）。

Discord から無人で投げたい場合も、[Claude Code の Discord 連携（Channels）](https://azukiazusa.dev/blog/how-discord-integration-works/)
を使えば同じ流れになります：Discord 添付 → Channels が `download_attachment` でローカル保存
→ ローカルの Claude Code が読み取り → 本 MCP の `register` を呼ぶ。これも Claude Code の
サブスク認証で動くため **API キー不要**です。

> 設計当初は自前 Discord bot ＋ PaddleOCR ＋ Anthropic API による完全無人取り込みも想定して
> いましたが、API 従量課金を避けるため上記の Claude 主導方式に一本化し、当該コードは削除
> しました（必要なら Git 履歴から復元可能）。

## 外部公開（Cloudflare）

LAN サーバを Cloudflare Tunnel + Access の背後に置きます（ポート開放不要・自宅 IP も隠れる）
——[`deploy/cloudflared-config.example.yml`](deploy/cloudflared-config.example.yml) を参照。
Access が `Cf-Access-Authenticated-User-Email` ヘッダを付与するので、
`PK_TRUST_ACCESS_HEADER=true` と `PK_ACCESS_EMAILS` で認証済みメールを scope にマッピング
します。公開 URL は claude.ai（Web）でカスタムコネクタとして登録すると、モバイルアプリへ
同期されます。

**トランスポートに関する注記：** 本サーバは Streamable HTTP を *ステートレス* モードで動かし、
`GET /mcp` には `405` を返します。これは仕様準拠です——MCP の Streamable HTTP 仕様は、GET に対し
「`text/event-stream` を返す」**か**「サーバ→クライアントのストリームを提供しないなら `405` を返す」
のどちらかを求めており、準拠クライアントは POST にフォールバックします。Anthropic のリモート
コネクタは Streamable HTTP を使用（レガシーの HTTP+SSE は非推奨）するため、別系統の SSE
トランスポートは不要です。

## バックアップとリマインダー

- **バックアップ**（§9.2）：対象は SQLite のみ。WAL セーフなオンラインスナップショットを取得し、
  Google Drive へアップロードする *前に* AES-256-GCM（scrypt 由来の鍵）で暗号化します。原本
  ファイルは設計上バックアップ対象外です——`full_text` があればリストア後も検索・参照は機能します。
- **リマインダー**（§4）：日次スキャンで `PK_REMINDER_DAYS` 以内に期限を迎える項目を Discord
  webhook へ投稿します。

どちらも system cron で実行する想定の単発 CLI です。`systemd` のサービス＋タイマーユニットは
[`deploy/systemd/`](deploy/systemd/) にあります。

**リストアの注意：** `pnpm run restore` の前に MCP サーバ（`personalknowledge-mcp.service`）を停止してください
——稼働中の SQLite ファイルを上書きすると破損します。リストア CLI は古い `-wal`/`-shm`
サイドカー（旧 DB のもの）を削除し、この警告を表示します。

## セキュリティ上の注意

- サーバは **クライアント指定の scope を一切信用しません**。トークンの許可集合と突き合わせ、
  許可外への書き込みは拒否します。
- `shared` の知識は、それを許可するすべてのトークンから参照できます。
- 本文の全文を返すのは、そのトークンが読める scope の文書だけです。抜粋も全文も同じ scope の判定を通ります。
- `update` と `delete` には明示的な `confirm: true` が必要です（無しならプレビューを返すだけで変更しません）。`restore`（soft delete の解除）は復元方向のため確認不要です（§9.4）。
- 認証済みリクエストはすべて監査ログに記録されます（`src/audit.ts`）。ログ出力は
  `src/redact.ts` を単一チョークポイントとして**マスキング**され、マイナンバー（12桁／4-4-4 区切り）・
  パスワード等の秘匿キー・Bearer トークンは平文で stderr／journald に出ません（エラースタックも対象）。
- CF Access のメールヘッダ（`Cf-Access-Authenticated-User-Email`）は、**サーバが Cloudflare Access の
  背後にあり上流が当該ヘッダを strip/set する構成**でのみ `PK_TRUST_ACCESS_HEADER=true` として信頼して
  ください。直接到達できる（LAN を含む）構成で有効化すると、ヘッダ偽装によるなりすましを許します。
- データ（SQLite・ファイル）は自宅サーバ内に留まり、外に出るのはツールの応答のみです。
- **保存時暗号化（任意）**：`PK_DB_PASSPHRASE` を設定すると SQLite ファイル全体（FTS5 インデックス・
  WAL を含む）を SQLCipher で暗号化します。復号はメモリ上で行われるため検索や利便性は変わりません。
  既存の平文 DB は一度だけ `pnpm run db:encrypt`（サーバ停止中）で移行します。バックアップ CLI も
  同じ `PK_DB_PASSPHRASE` で暗号化 DB を読みます。**この合言葉を失うと DB もバックアップも復元
  できません**ので、マイナンバー等を入れる場合は確実に控えてください。なお自分のマイナンバーを
  自分のために保存するだけなら番号法の収集・保管制限（他人の個人番号が対象）には該当しませんが、
  家族の番号は「他人の個人番号」に当たる点に注意してください。

## プロジェクト構成

```text
src/
  config.ts            トークン/メール → principal レジストリ、ランタイム設定
  types.ts             ドメイン型
  audit.ts             1行の監査ログ
  embedding.ts         Embedder インターフェース + Phase 1 のハッシュ実装（暫定）
  auth/guard.ts        権限ガード + リクエストの principal 解決
  db/index.ts          SQLite + FTS5（trigram）+ sqlite-vec スキーマ、版管理
  doctype/registry.ts  doc_type 語彙 + 履歴ルール
  store/documents.ts   scope 強制の register/search/update/delete/restore + 日付の一覧・承認 + リマインダー
  store/doc-dates.ts   doc_dates の同期（extracted.dates / valid_until → 行、承認状態の引き継ぎ）
  mcp/server.ts        MCP ツール（register/search/update/delete/restore、語彙、日付）
  index.ts             Express + Streamable HTTP エントリポイント
  backup/              AES-256-GCM 暗号、Drive バックアップ/リストア、CLI
  reminders/           期限スキャン → Discord webhook、CLI
deploy/                Cloudflare Tunnel 設定 + systemd ユニット/タイマー
server.json            MCP レジストリ登録用マニフェスト
test/                  guard・store・config・backup・reminder・HTTP e2e テスト
docs/design.md         システム全体の設計
```
