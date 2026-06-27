# 運用手順書（セットアップ & オペレーション）

このドキュメントは、Personal Knowledge MCP を実際に家庭で運用するために **あなたが行う作業**
を順番にまとめたものです。仕様は [`design.md`](design.md)、概要は [`../README.md`](../README.md) を参照。

進め方の目安：
- **STEP 1〜3 だけ**でも「メイン機の Claude Code から LAN 経由で使える」状態になります（まずここを目標に）。
- 外部公開（スマホ／家族）やバックアップ・リマインダーは、必要になった段階で STEP 4 以降を足します。

---

## 0. 事前に用意・決めておくもの

| 区分 | 用意するもの | 必須/任意 |
|---|---|---|
| サーバ | 常時起動の Ubuntu Server（または常時起動の Linux/Mac）。Node.js 22 以上 | 必須 |
| トークン | full / work / family 用のランダム秘密文字列（後述コマンドで生成） | 必須 |
| ドメイン | Cloudflare で管理しているドメイン（外部公開する場合のみ） | 任意 |
| Google | バックアップ用の Google アカウント＋サービスアカウント鍵、保存先 Drive フォルダ | 任意 |
| Discord | 通知用 Webhook URL（リマインダーを使う場合） | 任意 |
| 家族のメール | 外部公開時に Cloudflare Access で許可するメールアドレス | 任意 |

---

## STEP 1. サーバ準備

```bash
# Node.js 22 系（無ければ導入。例: nvm / nodesource など環境に合わせて）
node -v   # v22.x 以上であること

# 設置場所（systemd ユニットの既定は /opt/personal-knowledge-mcp）
sudo mkdir -p /opt/personal-knowledge-mcp
sudo chown "$USER" /opt/personal-knowledge-mcp
git clone <このリポジトリのURL> /opt/personal-knowledge-mcp
cd /opt/personal-knowledge-mcp

npm ci
npm run build
npm test    # 全テストが緑になることを確認（任意だが推奨）
```

> better-sqlite3 のネイティブビルドに `build-essential`（gcc/make 等）が要る環境があります。
> `npm ci` が失敗したら `sudo apt-get install -y build-essential python3` を入れてやり直し。

---

## STEP 2. 設定ファイル（.env）を作る

```bash
cp .env.example .env

# トークンを3つ生成（出力をメモ）
echo "full:   $(openssl rand -hex 32)"
echo "work:   $(openssl rand -hex 32)"
echo "family: $(openssl rand -hex 32)"
```

`.env` を編集（最小構成）。`PK_TOKENS` は **1行の JSON**で書きます。上で生成した値を `<...>` に入れてください。

```bash
# LAN から接続するため 0.0.0.0 で待ち受け（未設定だと 127.0.0.1 のみ＝同一マシン限定）
PK_HOST=0.0.0.0
PK_PORT=8848
PK_DB_PATH=data/knowledge.db

PK_TOKENS={"<full秘密>":{"name":"full","scopes":["private","work","shared"],"defaultWriteScope":"private"},"<work秘密>":{"name":"work","scopes":["work","shared"]},"<family秘密>":{"name":"family","scopes":["shared"]}}
```

> ⚠️ `PK_TOKENS` を設定しないと**開発用の既定トークン**で起動します（LAN 検証専用）。本番では必ず設定してください。
> ⚠️ `PK_EMBEDDING_DIM` は DB 作成時に固定されます。後から変えると既存 DB と不整合になるので、最初に決めたら変えないこと（既定 256 のままで可）。

---

## STEP 3. 起動と疎通確認（まずここがゴール）

### 手動起動で確認
```bash
npm start
# 別ターミナルで
curl http://localhost:8848/health      # {"ok":true,...} が返る
```

### メイン機の Claude Code から接続
メイン機（Windows等）で、`SERVER-IP` をサーバの LAN IP に置き換えて：
```bash
claude mcp add --transport http personal-knowledge \
  http://SERVER-IP:8848/mcp \
  --header "Authorization: Bearer <full秘密>"
```
Claude Code で「`search` や `register` が使えるか」を試す。ここまでで **LAN 内運用は完成**。

### 常駐化（systemd）
```bash
# 専用ユーザー（任意だが推奨）
sudo useradd --system --home /opt/personal-knowledge-mcp pk
sudo chown -R pk /opt/personal-knowledge-mcp

# ユニットを設置（リポジトリの deploy/systemd/ を使用）
sudo cp deploy/systemd/pk-mcp.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now pk-mcp.service
sudo systemctl status pk-mcp.service      # active (running) を確認
journalctl -u pk-mcp -f                    # ログ確認（監査ログもここに出る）
```
> ユニットは設置先 `/opt/personal-knowledge-mcp`・ユーザー `pk`・`EnvironmentFile=.../.env` を前提にしています。場所やユーザーを変える場合は `.service` を編集してください。

---

## STEP 4. 書類の取り込み方（API キー不要）

書類の OCR・項目抽出は **Claude 本体**が行います（あなたの月額 Claude プラン内。Anthropic API キーは不要）。

1. Claude（Code / デスクトップ / アプリ）に書類の画像・PDF を添付する。
2. MCP プロンプト **`ingest_document`** を実行する（または「この書類をナレッジベースに登録して」と指示）。
3. Claude が全文を読み取り、`doc_type` や `valid_until` を判断して `register` を呼ぶ。

Discord から無人で投げたい場合は、**Claude Code の Discord 連携（Channels）**を併用すると、
「Discord 添付 → ローカル Claude Code が読取り → `register`」が成立します（これも API キー不要）。

> 手入力で登録するだけなら添付も不要で、Claude にテキストで内容を伝えて `register` させても OK。

---

## STEP 5.（任意）外部公開：スマホ・家族から使う

スマホ/Web の Claude アプリや家族から使うには、サーバをインターネットへ安全に公開します。
**Cloudflare Tunnel（ポート開放不要・自宅 IP も隠れる）＋ Access（メール認証）** を使います。

```bash
# cloudflared 導入 → ログイン → トンネル作成
cloudflared tunnel login
cloudflared tunnel create personal-knowledge
cloudflared tunnel route dns personal-knowledge knowledge.example.com   # 自分のドメインに

# 設定ファイルを用意（リポジトリの例を編集：TUNNEL_ID と hostname を自分の値に）
cp deploy/cloudflared-config.example.yml deploy/cloudflared-config.yml
$EDITOR deploy/cloudflared-config.yml
cloudflared tunnel --config deploy/cloudflared-config.yml run   # 動作確認（後で systemd 化）
```

Cloudflare ダッシュボードで **Access アプリケーション**を作成：
- 対象：`knowledge.example.com`（パスを `/mcp` に限定推奨）
- ポリシー：許可するメール（自分・家族）を登録

`.env` に追記して、Access が付けるメールヘッダを scope にマッピング：
```bash
PK_TRUST_ACCESS_HEADER=true
PK_ACCESS_EMAILS={"you@example.com":{"name":"full","scopes":["private","work","shared"]},"family@example.com":{"name":"family","scopes":["shared"]}}
```
> `PK_TRUST_ACCESS_HEADER=true` は **Access の背後でのみ**にしてください（LAN 直アクセスでヘッダ偽装されないため）。LAN は引き続きトークンで認証されます。

最後に **claude.ai（Web版）**で「カスタムコネクタ」として公開 URL（`https://knowledge.example.com/mcp`）を登録 → スマホアプリに同期されます。

設定変更を反映：`sudo systemctl restart pk-mcp` と `cloudflared` を常駐化（サービス化）。

---

## STEP 6.（任意）バックアップ：暗号化して Google Drive へ

SQLite を暗号化して日次で Google Drive に退避します（原本ファイルは対象外＝`full_text` で復旧可能）。

1. Google Cloud でサービスアカウントを作成し、JSON 鍵をサーバへ配置。
2. 退避先の **Drive フォルダ**を作り、そのフォルダをサービスアカウントのメールに「編集者」で共有。フォルダ ID を控える。
3. `.env` に追記：
   ```bash
   PK_BACKUP_PASSPHRASE=<長くて強いパスフレーズ>     # 復元に必須。別途厳重保管
   PK_BACKUP_FOLDER_ID=<DriveフォルダID>
   GOOGLE_APPLICATION_CREDENTIALS=/opt/personal-knowledge-mcp/secrets/sa.json
   ```
4. 手動実行で確認 → タイマー有効化：
   ```bash
   npm run backup     # "uploaded encrypted snapshot, file id ..." が出れば成功
   sudo cp deploy/systemd/pk-backup.service deploy/systemd/pk-backup.timer /etc/systemd/system/
   sudo systemctl daemon-reload && sudo systemctl enable --now pk-backup.timer
   systemctl list-timers pk-backup\*      # 次回実行予定を確認
   ```

### リストア（復元）手順
```bash
sudo systemctl stop pk-mcp          # ★必ず先にサーバ停止（稼働中の上書きは破損の元）
npm run restore                      # 最新バックアップを取得→復号→DBへ書き戻し（-wal/-shm は自動掃除）
sudo systemctl start pk-mcp
```
> `PK_BACKUP_PASSPHRASE` を失うと復号できません。パスフレーズはパスワードマネージャ等で別管理を。

---

## STEP 6.5（任意・推奨）保存時暗号化：DB ファイルを暗号化する

マイナンバーやパスワードなど機微な情報を入れるなら、SQLite ファイル自体を暗号化します。
SQLCipher で DB 全体（FTS5 インデックス・WAL を含む）を暗号化し、復号はメモリ上で行うため
**検索や使い勝手は一切変わりません**。

1. `.env` に合言葉を追記：
   ```bash
   PK_DB_PASSPHRASE=<長くて強いパスフレーズ>   # 失うと DB もバックアップも復元不能。厳重保管
   ```
2. **既存の平文 DB がある場合**は一度だけ移行（サーバ停止中に実行）：
   ```bash
   sudo systemctl stop pk-mcp
   npm run db:encrypt        # data/knowledge.db をその場で暗号化（PK_DB_PATH で別パス指定可）
   sudo systemctl start pk-mcp
   ```
   新規 DB（まだ作っていない）なら移行は不要で、`PK_DB_PASSPHRASE` を設定して起動すれば
   最初から暗号化された DB が作られます。
3. 確認：暗号化後の DB は鍵なしでは開けません。
   ```bash
   sqlite3 data/knowledge.db ".tables"   # "file is not a database" 等で開けなければ暗号化済み
   ```

> - バックアップ CLI（STEP 6）は同じ `PK_DB_PASSPHRASE` を読んで暗号化 DB をスナップショットします。
>   設定済みなら追加操作は不要です。
> - 平文に戻したいときは `npm run db:decrypt`（サーバ停止中）。
> - **注意**：自分のマイナンバーを自分のために保存するだけなら番号法の収集・保管制限（規制対象は
>   *他人*の個人番号）には当たりませんが、家族の番号は「他人の個人番号」に該当します。

---

## STEP 7.（任意）期限リマインダー：Discord 通知

保証切れ・提出期限などが近い項目を、毎朝 Discord に通知します。

1. Discord でチャンネルの **Webhook URL** を作成。
2. `.env` に追記：
   ```bash
   PK_REMINDER_WEBHOOK=https://discord.com/api/webhooks/xxxx/yyyy
   PK_REMINDER_DAYS=14      # 何日先まで対象にするか（既定14）
   ```
3. 手動実行 → タイマー有効化：
   ```bash
   npm run reminders        # 該当があれば Discord に投稿、無ければ何もしない
   sudo cp deploy/systemd/pk-reminders.service deploy/systemd/pk-reminders.timer /etc/systemd/system/
   sudo systemctl daemon-reload && sudo systemctl enable --now pk-reminders.timer
   ```

---

## 日常運用・メンテナンス

- **状態/ログ**：`systemctl status pk-mcp` / `journalctl -u pk-mcp -f`（監査ログ `[audit] ...` もここ）。
- **更新（コード更新時）**：
  ```bash
  cd /opt/personal-knowledge-mcp && git pull
  npm ci && npm run build
  sudo systemctl restart pk-mcp
  ```
- **トークンの追加・失効**：`.env` の `PK_TOKENS` を編集 → `sudo systemctl restart pk-mcp`。漏れたトークンは値を差し替えれば即無効。
- **データの所在**：`data/`（SQLite 本体と原本ファイル）。`data/` は Git 管理外。バックアップ対象は SQLite のみ。
- **破壊的操作の安全装置**：`update`/`delete` は `confirm:true` を付けるまで実行されず要約のみ返る（誤操作防止）。
- **古い情報**：`valid_until`（期限）で自動的に通常検索から外れる。履歴を見たいときは検索で `include_expired` を指定。

---

## 困ったとき

| 症状 | 確認 |
|---|---|
| Claude Code から繋がらない | `curl http://SERVER-IP:8848/health`、`PK_HOST=0.0.0.0`、ファイアウォール/ポート、トークン一致 |
| 401 が返る | `Authorization: Bearer <token>` の値が `PK_TOKENS` のキーと一致しているか |
| スマホから繋がらない | Cloudflare Tunnel 稼働、Access ポリシーにメール登録、`PK_TRUST_ACCESS_HEADER=true`、`PK_ACCESS_EMAILS` のメール一致 |
| バックアップ失敗 | サービスアカウントに Drive フォルダを共有したか、`PK_BACKUP_*` と鍵パス、ネットワーク |
| 起動時に落ちる | `PK_TOKENS` が空文字でないか、`PK_PORT` が 1〜65535 か（不正値は起動時エラー） |

---

## あなたが行う作業のチェックリスト

- [ ] STEP 1: サーバに clone → `npm ci` → `npm run build`
- [ ] STEP 2: `.env` 作成、`PK_TOKENS` を生成・設定、`PK_HOST=0.0.0.0`
- [ ] STEP 3: `npm start` で疎通 → Claude Code から接続 → systemd 常駐化
- [ ] STEP 4: `ingest_document` で書類取り込みを試す
- [ ] STEP 5（任意）: Cloudflare Tunnel + Access → claude.ai でコネクタ登録
- [ ] STEP 6（任意）: サービスアカウント＋Drive フォルダ → `npm run backup` → タイマー
- [ ] STEP 7（任意）: Discord Webhook → `npm run reminders` → タイマー
