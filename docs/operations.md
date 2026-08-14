# 運用手順書（セットアップ & オペレーション）

このドキュメントは、Personal Knowledge MCP を実際に家庭で運用するために **あなたが行う作業**
を順番にまとめたものです。仕様は [`design.md`](design.md)、概要は [`../README.md`](../README.md) を参照。

進め方の目安：
- **STEP 1〜3 だけ**でも「同じ Windows 機の Claude Code から使える」状態になります（まずここを目標に）。
- 外部公開（スマホ／家族）やバックアップ・リマインダーは、必要になった段階で STEP 4 以降を足します。

---

## 0. 前提とする構成

**常時稼働している Windows + WSL2（Ubuntu）機で、クローンした開発ディレクトリをそのまま本番として動かす**
構成を前提にします。開発と運用が同じツリーに同居するので、後述の「開発と本番の同居ルール」を必ず守ってください。

| 区分 | 用意するもの | 必須/任意 |
|---|---|---|
| ホスト | 常時稼働の WSL2（systemd 有効）。専用サーバがあるならそちらでも可 | 必須 |
| Node.js | **システムに** Node.js 22 以上（`/usr/bin/node`）。nvm 版とは別に必要 | 必須 |
| トークン | full / work / family 用のランダム秘密文字列（後述コマンドで生成） | 必須 |
| ドメイン | Cloudflare で管理しているドメイン（外部公開する場合のみ） | 任意 |
| Google | バックアップ用の Google アカウント＋サービスアカウント鍵、保存先 Drive フォルダ | 任意 |
| Discord | 通知用 Webhook URL（リマインダーを使う場合） | 任意 |
| 家族のメール | 外部公開時に Cloudflare Access で許可するメールアドレス | 任意 |

以降の手順では、リポジトリの置き場所とサービス実行ユーザーを次のシェル変数で表します。
自分の値に読み替えて（または実際に export して）ください。**専用ユーザーは作らず、
ふだん使っているユーザーでそのまま動かします**（理由は STEP 3 の常駐化を参照）。

```bash
export APP_DIR="$PWD"     # リポジトリのルート（clone した場所）
export APP_USER="$USER"   # サービスを動かすユーザー＝ふだんのあなた
```

`deploy/systemd/*.service` は `__USER__` / `__APP_DIR__` をプレースホルダにしてあり、
設置時に上記の値へ置換します（コマンドは STEP 3）。

---

## STEP 1. ホスト準備

### WSL で systemd を有効にする

`/etc/wsl.conf` に以下があること（無ければ追記して `wsl --shutdown` → 再起動）。

```ini
[boot]
systemd=true
```

`ps -p 1 -o comm=` が `systemd` を返せば有効です。

### Node.js 22.13+ をシステムに入れる

**nvm の Node では systemd から起動できません。** systemd は `PATH` を継承しないため、
ユニットの `ExecStart` には実在する絶対パス（`/usr/bin/node`）が必要です。nvm のパスは
バージョン番号を含むので、Node を上げるたびにサービスが壊れます。

Ubuntu 標準の `nodejs` パッケージは 18 系で、これでは **ネイティブモジュール
（better-sqlite3）の ABI が合わず起動時にクラッシュします**。NodeSource から 22 系を入れてください
（`pnpm@11.8.0` が `engines.node >=22.13` を要求するため、22.13 以上が必要です）。

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
/usr/bin/node --version   # v22.13 以上であること
```

> 既存の nvm はそのまま残り、対話シェルでは従来どおり nvm 版が使われます。systemd だけが
> `/usr/bin/node` を見ます。

### 依存の導入とビルド

**⚠️ ビルドは systemd と同じ `/usr/bin/node` で行ってください。** ネイティブモジュール
（better-sqlite3）は**ビルドに使った Node の ABI に固定**されます。対話シェルでは nvm の Node が
優先されるため、そのまま `pnpm install` すると nvm 版の ABI でビルドされ、`/usr/bin/node` で動く
systemd サービスがロードに失敗する恐れがあります。両者のメジャーが揃っていれば通常は動きますが、
事故を防ぐため PATH を固定して実行します。

```bash
# corepack は NodeSource 版なら /usr/bin/corepack。shim 作成に書き込み権限が要るので、
# EACCES で失敗する場合は sudo を付ける（例: sudo corepack enable pnpm）。
corepack enable pnpm

# nvm を一時的に外し、システムの /usr/bin/node を使ってビルドする
cd "$APP_DIR"
export PATH="/usr/bin:$PATH"
hash -r
node --version                       # /usr/bin/node（v22.13+）が使われること
corepack pnpm exec node --version    # 上と一致すること

pnpm install --frozen-lockfile
pnpm run build
pnpm test    # 全テストが緑になることを確認（任意だが推奨）
```

> better-sqlite3 のネイティブビルドに `build-essential`（gcc/make 等）が要る環境があります。
> `pnpm install --frozen-lockfile` が失敗したら `sudo apt-get install -y build-essential python3` を入れてやり直し。

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
# ★ 127.0.0.1（ループバック）に限定する。0.0.0.0 にしない。
#   - cloudflared は 127.0.0.1:8848 に繋ぐので、外部公開はこれで成立する。
#   - Windows からは WSL の localhost フォワーディングで 127.0.0.1:8848 に届く。
#   - 0.0.0.0 だと LAN の他ホストから 8848 に直接到達でき、PK_TRUST_ACCESS_HEADER=true の
#     場合に Cf-Access-Authenticated-User-Email ヘッダを偽装して認証を回避される（STEP 5 参照）。
PK_HOST=127.0.0.1
PK_PORT=8848

# ★ DB は必ずリポジトリの外に置く（理由は下記）。~ は展開されないので絶対パスで書く
PK_DB_PATH=/home/<ユーザー名>/.local/share/personal-knowledge/knowledge.db

PK_TOKENS={"<full秘密>":{"name":"full","scopes":["private","work","shared"],"defaultWriteScope":"private"},"<work秘密>":{"name":"work","scopes":["work","shared"]},"<family秘密>":{"name":"family","scopes":["shared"]}}
```

`.env` にはトークンが平文で入るので、パーミッションを絞ります（`.gitignore` 済みでコミットはされません）。

```bash
chmod 600 .env
```

### ★ DB をリポジトリの外に置く理由

既定の `data/knowledge.db` はリポジトリ内で、かつ `.gitignore` されています。開発ディレクトリを
そのまま本番として動かす構成では、**`git clean -xdf` を一度打っただけで DB が消えます**（ignore された
ファイルごと削除されるため）。データをツリーの外に出しておけば、リポジトリを clean しようが
clone し直そうがデータは無傷です。バックアップ／リストア CLI も同じ `PK_DB_PATH` を見ます。

まだ DB を作っていない新規セットアップなら、この移動は不要です（`PK_DB_PATH` を設定して起動すれば
そこに新規作成されます）。**既に `data/` に DB がある場合のみ**、以下で移動します。稼働中の SQLite を
移動すると WAL/SHM が不整合になるため、必ず**サーバを停止してから**行い、**移動が失敗したら中断**します
（`|| true` で握りつぶすと、空 DB が新規作成されてデータが消えたように見えます）。

```bash
mkdir -p ~/.local/share/personal-knowledge

# サーバ（手動起動・systemd の両方）を止めてから
sudo systemctl stop personalknowledge-mcp 2>/dev/null || true

# 移動対象を先に確認し、存在する場合だけ移動。失敗したら set -e で中断
if ls data/knowledge.db* >/dev/null 2>&1; then
  ( set -e; mv -v data/knowledge.db* ~/.local/share/personal-knowledge/ )
else
  echo "data/ に DB は無い（新規セットアップ）。移動不要。"
fi
```

> ⚠️ `PK_TOKENS` を設定しないと**開発用の既定トークン**で起動します（LAN 検証専用）。本番では必ず設定してください。
> ⚠️ `PK_EMBEDDING_DIM` は DB 作成時に固定されます。後から変えると既存 DB と不整合になるので、最初に決めたら変えないこと（既定 256 のままで可）。

---

## STEP 3. 起動と疎通確認（まずここがゴール）

### 手動起動で確認

```bash
pnpm start
# 別ターミナルで
curl http://localhost:8848/health      # {"ok":true,...} が返る
```

### Windows 側の Claude Code から接続

Windows のターミナルで接続します。**トークンをコマンド引数に直接書くと、シェル履歴と
実行中のプロセス引数（`ps` で他ユーザーにも見える）に平文で残ります。** Claude Code は
`.mcp.json` の `headers` 値で `${VAR}` 展開をサポートするので、トークンは環境変数から
参照させ、設定にはリテラルの `${MCP_TOKEN}` を保存します。

```bash
# トークンは対話的に入力（履歴に残さない）。行頭スペースでも履歴抑止できる（HISTCONTROL=ignorespace）
read -r -s MCP_TOKEN         # full 秘密を貼り付けて Enter
export MCP_TOKEN

# \${...} を「その場で展開させず」リテラルとして設定に書き込む
claude mcp add --transport http personal-knowledge \
  http://localhost:8848/mcp \
  --header "Authorization: Bearer \${MCP_TOKEN}"
```

設定ファイルには `Bearer ${MCP_TOKEN}` という文字列が保存され、Claude Code が**起動時に環境から
`MCP_TOKEN` を展開**します（トークン自体は設定にもプロセス引数にも残りません）。そのため
`MCP_TOKEN` を **Claude Code が動く環境**に用意しておく必要があります（未設定だと `claude mcp list`
に missing-variable の警告が出て `${MCP_TOKEN}` が未展開のまま使われます）。

> トークンを環境変数にも置きたくない場合は、`headersHelper`（接続時に外部コマンドで
> ヘッダを生成する仕組み。例: `pass`／OS のキーチェーンから取り出す）を使えます。
> 詳細は Claude Code の MCP ドキュメント参照。

登録後、Claude Code で「`search` や `register` が使えるか」を試します。ここまでで **手元運用は完成**。

### 常駐化（systemd）

**専用ユーザーは作りません。** リポジトリがホームディレクトリ（通常 700 か 750）の下にあるため、
別ユーザーからは**そもそもディレクトリを辿れません**。通すにはホーム全体を開ける必要があり、
隔離のためにやったことで隔離が壊れます。また開発ツリーを別ユーザー所有にすると git も pnpm も
書き込めなくなります。ふだんのユーザーで動かすのが、この構成での正解です。

ユニットの `__USER__` / `__APP_DIR__` を置換して設置します。

```bash
sed -e "s|__USER__|$APP_USER|g" -e "s|__APP_DIR__|$APP_DIR|g" \
  deploy/systemd/personalknowledge-mcp.service \
  | sudo tee /etc/systemd/system/personalknowledge-mcp.service > /dev/null

sudo systemctl daemon-reload
sudo systemctl enable --now personalknowledge-mcp.service
sudo systemctl status personalknowledge-mcp.service      # active (running) を確認
sudo journalctl -u personalknowledge-mcp -f               # ログ確認（監査ログもここに出る）
```

> `personalknowledge-*` は system unit なので、ログ参照は `sudo journalctl -u ...` が確実です。
> `sudo` なしで見たい場合は、自分を `systemd-journal`（または `adm`）グループに追加してください
> （`sudo usermod -aG systemd-journal "$USER"` → 再ログイン）。以降このドキュメントの
> `journalctl` 例は、権限に応じて `sudo` を付けてください。

> `EnvironmentFile` は**あえて使っていません**。systemd の環境ファイルはシェル風のクォート解釈を
> するため、`PK_TOKENS` の JSON（値の中に `"` を含む）が壊れます。`src/index.ts` が `dotenv/config` を
> 読み込んでいるので、`WorkingDirectory` さえ合っていれば `.env` は自前で読まれます。

---

## STEP 3.5. 開発と本番の同居ルール（重要）

開発ディレクトリをそのまま本番として動かしているため、以下を守らないと本番を壊します。

**1. ビルドしたら再起動する。** サービスが読むのは `dist/` です。`src/` を直しても
`pnpm run build` しなければ反映されず、ビルドしても再起動しなければ反映されません。

```bash
pnpm run build && sudo systemctl restart personalknowledge-mcp
```

**2. `pnpm run dev` はポートと DB を分ける。** 同じ `.env` を読むので、そのままだと稼働中の
サービスと同じ 8848 を掴もうとして衝突し、同じ DB に書き込みます。開発 DB は `/tmp` に置かないこと
（`/tmp` は他ローカルユーザーから読める可能性があり、個人情報が漏れます）。ユーザー専用ディレクトリを使います。

```bash
mkdir -p ~/.local/share/personal-knowledge/dev
PK_PORT=8849 PK_DB_PATH=~/.local/share/personal-knowledge/dev/dev.db pnpm run dev
```

---

## STEP 4. 書類の取り込み方（API キー不要）

書類の OCR・項目抽出は **Claude 本体**が行います（あなたの月額 Claude プラン内。Anthropic API キーは不要）。

1. Claude（Code / デスクトップ / アプリ）に書類の画像・PDF を添付する。
2. MCP プロンプト **`ingest_document`** を実行する（または「この書類をナレッジベースに登録して」と指示）。
3. Claude が全文を読み取り、`doc_type` や `valid_until` を判断して `register` を呼ぶ。

Discord から無人で投げたい場合は、**Claude Code の Discord 連携（Channels）**を併用すると、
「Discord 添付 → ローカル Claude Code が読取り → `register`」が成立します（これも API キー不要）。

> 手入力で登録するだけなら添付も不要で、Claude にテキストで内容を伝えて `register` させても OK。

### 原本ファイル（PDF・画像）の置き場所

原本は **DB と同じデータディレクトリの `files/` 配下**に置き、そのパスを `register` の `raw_path` に渡します。

```
~/.local/share/personal-knowledge/     # PK_DB_PATH と同じ親（DB とセットで移設できる）
  knowledge.db
  files/
    private/2026-08-14_自動車保険契約内容証明書.pdf
    work/
    shared/
```

- **scope でだけフォルダを分ける**。年別・種別のサブフォルダは作らない（直接見るとき階層が深いほど探しにくいため）。
- **ファイル名は `<発行日>_<書類名>.pdf`**。発行日は書類自体の発行日（`extracted.issued_date`。登録日ではない）、書類名は書類のタイトルをそのまま使う。同じ日に同名があれば末尾に `_2` を足す。
- **`doc_type` はパスに入れない**。`doc_type` は後から改名しうる（改名＝新しい型を作り、各文書の `doc_type` を `update` し、旧型を `delete_doc_type`）ため、パスに埋めると全該当文書の `raw_path` 書き換えとファイル移動まで必要になる。種別は DB を正とし、人が見て分かる情報は書類名で足りる。
- **`files/` はバックアップ対象外**（STEP 6 のバックアップは SQLite のみ）。原本まで残したい場合は別途コピーを取る。`full_text` に本文が入っているため、検索・参照は原本を失っても機能する。
- スマホ/Web の Claude から登録する場合、原本をこのディレクトリに置く手段は現状ない。その場合は `raw_path` なし（`full_text` のみ）で登録し、原本は後から手元で配置して `update` で `raw_path` を足す。

---

## STEP 5.（任意）外部公開：スマホ・家族から使う

スマホ/Web の Claude アプリや家族から使うには、サーバをインターネットへ安全に公開します。
**Cloudflare Tunnel（ポート開放不要・自宅 IP も隠れる）＋ Access（メール認証）** を使います。

### 5-1. トンネルを作る

```bash
cloudflared tunnel login      # ブラウザが開く → 対象ドメインを選ぶ → ~/.cloudflared/cert.pem ができる
cloudflared tunnel create personal-knowledge
```

`create` の出力に **トンネルの UUID** が出ます。これが設定ファイルに書く「TUNNEL_ID」です。

同時に、**認証情報 JSON** が `~/.cloudflared/<UUID>.json` に書き出されます。これはトンネルの
秘密鍵に相当するので、リポジトリには置かないでください。後から UUID を確認したくなったら：

```bash
cloudflared tunnel list       # NAME と ID の一覧が出る
ls ~/.cloudflared/            # cert.pem と <UUID>.json が見える
```

### 5-2. DNS レコードを作る

以下example.comを自身のドメインにおきかえる。

```bash
cloudflared tunnel route dns personal-knowledge personal-knowledge.example.com
```

このコマンドが Cloudflare DNS に `personal-knowledge.example.com` → `<UUID>.cfargotunnel.com` の
CNAME（proxied）を**自動で作ります**。ダッシュボードでの手動登録は不要で、自宅 IP を指す A レコードも
作られません。ホスト名は Cloudflare で管理しているドメインの**サブドメイン**にしてください
（apex を使うと、そのドメインへの全アクセスがトンネルに向きます）。

### 5-3. 設定ファイルを書く

```bash
cp deploy/cloudflared-config.example.yml deploy/cloudflared-config.yml
$EDITOR deploy/cloudflared-config.yml
```

埋めるのは 3 か所です。`tunnel:` に 5-1 の UUID、`credentials-file:` に
`~/.cloudflared/<UUID>.json` の**絶対パス**（YAML では `~` は展開されません）、
`hostname:` に 5-2 で指定したホスト名を入れます。

```yaml
tunnel: 6ff42ae2-765d-4adf-8112-31c55c1551ef
credentials-file: /home/<ユーザー名>/.cloudflared/6ff42ae2-765d-4adf-8112-31c55c1551ef.json

ingress:
  - hostname: personal-knowledge.example.com   # ★ route dns で指定した名前と完全一致させる
    path: ^/mcp$
    service: http://127.0.0.1:8848
  - service: http_status:404
```

> **よくある失敗：** `hostname:` が `route dns` のホスト名とずれていると、トンネルは正常に張れて
> いるのにアクセスすると 404 が返ります。原因が分かりにくいので、コピペで揃えてください。
> また `credentials-file` は **実行ユーザーのホーム**配下です。`sudo` を付けて `create` すると
> `/root/.cloudflared/` に書かれてしまい、一般ユーザーで動かすサービスから読めなくなります。

```bash
cloudflared tunnel --config deploy/cloudflared-config.yml run   # 動作確認（後で systemd 化）
```

### 5-4. Access アプリケーションを作る

トンネルを張っただけでは URL は**誰でも叩ける**状態です。Cloudflare Access を前段に置いて、
許可したメールアドレスの人だけが到達できるようにします。

**Zero Trust ダッシュボード → Access controls → Applications → Add an application**

**アプリの種類は「セルフホストとプライベート」（Self-hosted and private）を選びます。** 

続いて **「パブリックホスト名を追加」** を選び、次を設定します。

| 項目 | 値 |
|---|---|
| アプリケーション名 | `Personal Knowledge MCP`（任意） |
| サブドメイン | `personal-knowledge` |
| ドメイン | 自分のドメイン（5-2 で使ったもの） |
| パス | **空のまま（指定しない）** ← 下記参照 |
| セッション期間 | 選択肢の**最大（1 か月）**。ただし再認証の頻度を実際に決めるのはこの値ではない（5-4b 参照） |

> **パスは指定できません。** `mcp` などを入れると、次で有効化する Managed OAuth と衝突して
> `domain can not have a path if oauth is configured` エラーになります。OAuth のメタデータ
> エンドポイントをホスト直下で配信する必要があるためです。
>
> **公開面はそれでも `/mcp` だけに絞られています。** パスの制限は Access ではなく
> **トンネル側の `ingress`**（`path: ^/mcp$`、5-3）が担っており、`/mcp` 以外はオリジンに
> 到達せず 404 になります。元々この 2 か所で二重に絞っていたので、Access 側を外しても
> 実効的な公開面は変わりません。

**ポリシー**を 1 つ追加します。Access は**デフォルト拒否**で、Allow ポリシーに合致しない限り誰も
通れません。

| 項目 | 値 |
|---|---|
| ポリシー名 | `family`（任意） |
| アクション | **Allow** |
| ルール | Include → **Emails** → 自分と家族のメールアドレスを列挙 |

ログイン方法は **One-time PIN** で十分です。外部の ID プロバイダを一切設定せずに、指定した
メールアドレス宛に届くワンタイム PIN だけで認証できます（家族に使わせるならこれが一番楽です）。
`Settings → Authentication` の Login methods に One-time PIN があることを確認してください。

### ★ 5-4b. Managed OAuth を有効にする

作成したアプリを開き、**Edit → Advanced settings → Managed OAuth を ON** にします。

**これは必須です。** Access は通常、未認証のリクエストに `302` を返してブラウザのログイン画面へ
飛ばします。ところが claude.ai のコネクタのような**ブラウザではないクライアント**はこのリダイレクトを
処理できず、接続に失敗します。Managed OAuth を有効にすると、Access は `302` の代わりに
`401` ＋ `WWW-Authenticate` ヘッダを返し、**Access 自身が OAuth 2.0 認可サーバとして振る舞います**。
クライアントは標準の OAuth 認可コードフローでログインし、以後はトークンでアクセスできます。
**MCP サーバ側で OAuth を実装する必要はありません**——Cloudflare がすべて肩代わりします。

#### ★ Allowed redirect URIs に claude.ai を登録する（忘れると必ず失敗します）

同じ Managed OAuth の設定にある **Allowed redirect URIs** に、以下を追加します。

```text
https://claude.ai/api/mcp/auth_callback
```

Managed OAuth は、クライアントに**動的クライアント登録（DCR）**をさせる方式です。このとき
クライアントが申告するリダイレクト URI が、この許可リストに載っていないと**登録そのものが
拒否されます**。claude.ai は Web・デスクトップ・モバイルのいずれも上記のコールバックを使います。

登録し忘れると、コネクタ追加時にこうなります（Client ID を入れろと言われますが**原因はそこでは
ありません**。Client ID 欄は空のままで正しい）。

```text
personal-knowledge/mcp のサインインサービスに登録できませんでした。
もう一度お試しいただくか、コネクタ設定で OAuth Client ID を追加してください。
```

> **Claude Code は登録なしで繋がります。** ネイティブクライアントなのでループバック
> （`127.0.0.1` / `localhost`）にリダイレクトし、これは「Allow loopback clients」
> 「Allow localhost clients」の設定で別途許可されるためです。「Claude Code では繋がるのに
> claude.ai だけ失敗する」ときは、まずこの許可リストを疑ってください。

#### トークン寿命（＝再認証の頻度を決めるのはここ）

同じ Advanced settings に 2 つの値があります。**再認証の手間を左右するのは Access アプリの
「セッション期間」ではなく、こちらです。**

| 設定 | 意味 | 本構成での方針 |
|---|---|---|
| Access token lifetime | アクセストークンの有効期間（既定 15 分） | **短いままでよい**（5〜15 分）。切れてもユーザー操作は発生しない |
| Grant session duration | **リフレッシュトークン**の有効期間 | **選択肢の最大値**を選ぶ。ここが再認証の間隔になる |

アクセストークンが切れると、クライアントが**リフレッシュトークンで裏側で自動更新**します。
Cloudflare はそのたびに Access ポリシーを再評価しますが、**ユーザーの操作は一切発生しません**。
One-time PIN を入力し直すのは、**リフレッシュトークン（グラント）が切れたときだけ**です。
つまり「使い続けている限り再認証されない」構造なので、アクセストークンを短くしても体感は悪化せず、
ポリシー変更（家族の追加・削除）は速やかに効く、というトレードオフになります。

`.env` に追記して、Access が付けるメールヘッダを scope にマッピング：

```bash
PK_TRUST_ACCESS_HEADER=true
PK_ACCESS_EMAILS={"you@example.com":{"name":"full","scopes":["private","work","shared"]},"family@example.com":{"name":"family","scopes":["shared"]}}
```

> `PK_TRUST_ACCESS_HEADER=true` は **Access の背後でのみ**にしてください（直アクセスでヘッダ偽装されないため）。トークン認証は引き続き有効です。

`.env` の変更を反映：`sudo systemctl restart personalknowledge-mcp`

### 5-4c. メールヘッダが届いているか確認する

本サーバは `Cf-Access-Authenticated-User-Email` ヘッダを読んで principal を決めます
（`src/auth/guard.ts`）。Managed OAuth 経由のリクエストも「ブラウザ認証と同じ形」でオリジンに
届く仕様ですが、**最初の接続時に必ずログで確認してください**。

```bash
journalctl -u personalknowledge-mcp -f      # 接続時に auth.denied が出ていないか
```

`401 missing bearer token` が出る場合、メールヘッダが届いていないか、`PK_ACCESS_EMAILS` の
メールアドレスが一致していません（大文字小文字は無視されます）。

### 5-4d. claude.ai にコネクタとして登録する

**claude.ai（Web版）** の設定から「カスタムコネクタ」として公開 URL
（`https://personal-knowledge.example.com/mcp`）を登録します。初回に Access の OAuth 認証
（One-time PIN）を求められ、通過すると接続されます。登録するとスマホアプリにも同期されます。

### 5-5. cloudflared を常駐化する

動作確認できたら、cloudflared も systemd サービスにします。**`cloudflared service install` は使いません**
——あれは root で動くユニットを作るため、`~/.cloudflared/<UUID>.json` を読めなくなります。リポジトリの
ユニット（MCP サーバと同じユーザーで動く）を使ってください。

> ⚠️ **ユニット名を `cloudflared.service` にしないでください。** 同じホストで別のトンネルを
> 既に動かしている場合（`cloudflared service install` で入れた dashboard 管理のトンネルなど）、
> その名前は**すでに使われており、上書きすると既存のトンネルを壊します**。
> `cloudflared tunnel list` と `systemctl cat cloudflared` で先に確認してください。
> 本プロジェクトのユニットは `personalknowledge-tunnel.service` という専用名にしてあります。

```bash
sed -e "s|__USER__|$APP_USER|g" -e "s|__APP_DIR__|$APP_DIR|g" \
  deploy/systemd/personalknowledge-tunnel.service \
  | sudo tee /etc/systemd/system/personalknowledge-tunnel.service > /dev/null

sudo systemctl daemon-reload
sudo systemctl enable --now personalknowledge-tunnel
sudo systemctl status personalknowledge-tunnel
journalctl -u personalknowledge-tunnel -f
```

> cloudflared は apt 管理（`/etc/apt/sources.list.d/cloudflared.list`）なので、更新は
> `sudo apt install --only-upgrade cloudflared` → `sudo systemctl restart personalknowledge-tunnel`。
> `cloudflared update` はパッケージ管理下では拒否されます。ユニットでも `--no-autoupdate` を
> 付けて、勝手に更新されないようにしています。

---

## STEP 6.（任意）バックアップ：暗号化して Google Drive へ

SQLite を暗号化して日次で Google Drive に退避します（原本ファイルは対象外＝`full_text` で復旧可能）。

1. Google Cloud でサービスアカウントを作成し、JSON 鍵をサーバへ配置。
2. 退避先の **Drive フォルダ**を作り、そのフォルダをサービスアカウントのメールに「編集者」で共有。フォルダ ID を控える。
3. `.env` に追記：

   ```bash
   PK_BACKUP_PASSPHRASE=<長くて強いパスフレーズ>     # 復元に必須。別途厳重保管
   PK_BACKUP_FOLDER_ID=<DriveフォルダID>
   GOOGLE_APPLICATION_CREDENTIALS=/home/<ユーザー名>/.local/share/personal-knowledge/sa.json
   ```

4. 手動実行で確認 → タイマー有効化：

   ```bash
   pnpm run backup     # "uploaded encrypted snapshot, file id ..." が出れば成功
   sed -e "s|__USER__|$APP_USER|g" -e "s|__APP_DIR__|$APP_DIR|g" \
     deploy/systemd/personalknowledge-backup.service \
     | sudo tee /etc/systemd/system/personalknowledge-backup.service > /dev/null
   sudo cp deploy/systemd/personalknowledge-backup.timer /etc/systemd/system/   # timer は置換不要
   sudo systemctl daemon-reload && sudo systemctl enable --now personalknowledge-backup.timer
   systemctl list-timers personalknowledge-backup\*      # 次回実行予定を確認
   ```

### リストア（復元）手順

```bash
sudo systemctl stop personalknowledge-mcp          # ★必ず先にサーバ停止（稼働中の上書きは破損の元）
pnpm run restore                      # 最新バックアップを取得→復号→DBへ書き戻し（-wal/-shm は自動掃除）
sudo systemctl start personalknowledge-mcp
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
   sudo systemctl stop personalknowledge-mcp
   pnpm run db:encrypt        # data/knowledge.db をその場で暗号化（PK_DB_PATH で別パス指定可）
   sudo systemctl start personalknowledge-mcp
   ```

   新規 DB（まだ作っていない）なら移行は不要で、`PK_DB_PASSPHRASE` を設定して起動すれば
   最初から暗号化された DB が作られます。

3. 確認：暗号化後の DB は鍵なしでは開けません。

   ```bash
   # PK_DB_PATH を上書きしている場合はそのパスを使う（既定は data/knowledge.db）
   sqlite3 "${PK_DB_PATH:-data/knowledge.db}" ".tables"   # "file is not a database" 等で開けなければ暗号化済み
   ```

> - バックアップ CLI（STEP 6）は同じ `PK_DB_PASSPHRASE` を読んで暗号化 DB をスナップショットします。
>   設定済みなら追加操作は不要です。
> - 平文に戻したいときは `pnpm run db:decrypt`（サーバ停止中）。
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
   pnpm run reminders        # 該当があれば Discord に投稿、無ければ何もしない
   sed -e "s|__USER__|$APP_USER|g" -e "s|__APP_DIR__|$APP_DIR|g" \
     deploy/systemd/personalknowledge-reminders.service \
     | sudo tee /etc/systemd/system/personalknowledge-reminders.service > /dev/null
   sudo cp deploy/systemd/personalknowledge-reminders.timer /etc/systemd/system/   # timer は置換不要
   sudo systemctl daemon-reload && sudo systemctl enable --now personalknowledge-reminders.timer
   ```

---

## 日常運用・メンテナンス

- **状態/ログ**：`systemctl status personalknowledge-mcp` / `journalctl -u personalknowledge-mcp -f`（監査ログ `[audit] ...` もここ）。
- **更新（コード更新時）**：

  ```bash
  cd "$APP_DIR" && git pull
  pnpm install --frozen-lockfile && pnpm run build
  sudo systemctl restart personalknowledge-mcp
  ```

- **トークンの追加・失効**：`.env` の `PK_TOKENS` を編集 → `sudo systemctl restart personalknowledge-mcp`。漏れたトークンは値を差し替えれば即無効。
- **データの所在**：`~/.local/share/personal-knowledge/`（SQLite 本体）。リポジトリの外に置くので、
  ツリーを `git clean` しても消えません。バックアップ対象は SQLite のみ。
- **破壊的操作の安全装置**：`update`/`delete` は `confirm:true` を付けるまで実行されず要約のみ返る（誤操作防止）。
- **古い情報**：`valid_until`（期限）で自動的に通常検索から外れる。履歴を見たいときは検索で `include_expired` を指定。

---

## 困ったとき

| 症状 | 確認 |
|---|---|
| Windows から繋がらない | `curl http://localhost:8848/health`、`PK_HOST=127.0.0.1`（WSL の localhost フォワーディングで Windows から届く）、サービスが active か、トークン一致 |
| 起動直後に落ちる（listening は出る） | `PK_HOST` に Windows 側の LAN IP（192.168.x.x）を書いていないか。**そのアドレスは WSL 内に存在せず** `EADDRNOTAVAIL` になる。`127.0.0.1` にする |
| systemd 経由だけ起動に失敗する | `/usr/bin/node --version` が v22 か。18 系だと better-sqlite3 の **ABI 不一致でクラッシュ**する（nvm の node は systemd から見えない） |
| 401 が返る | `Authorization: Bearer <token>` の値が `PK_TOKENS` のキーと一致しているか |
| スマホから繋がらない | Cloudflare Tunnel 稼働、Access ポリシーにメール登録、`PK_TRUST_ACCESS_HEADER=true`、`PK_ACCESS_EMAILS` のメール一致 |
| claude.ai のコネクタ登録が失敗する／ログイン画面に飛べない | Access アプリの **Managed OAuth が OFF**。OFF だと Access が `302` を返し、ブラウザでないクライアントは処理できない（STEP 5-4b） |
| `サインインサービスに登録できませんでした`（`ofid_...`）と出る | Managed OAuth の **Allowed redirect URIs** に `https://claude.ai/api/mcp/auth_callback` が無い。DCR が拒否されている。Client ID の入力は不要（STEP 5-4b） |
| Access アプリ保存時に `domain can not have a path if oauth is configured` | アプリのホスト名に**パスを指定している**。Managed OAuth とは併用できないので、パスは空にする（`/mcp` への限定はトンネルの `ingress` が担う） |
| 公開 URL で 404 が返る／`アカウントは認証されましたが、指定された URL に MCP サーバーが見つかりません` | `ingress` の `hostname:` が **`example.com` のまま**になっていないか（プレースホルダの置換漏れ）。マッチしないと全リクエストが `http_status:404` に落ちる。Access 認証はエッジで完結するため「認証は通るのにサーバが見つからない」という症状になる。サーバの監査ログに `mcp.request` が**一切出ない**のが目印 |
| バックアップ失敗 | サービスアカウントに Drive フォルダを共有したか、`PK_BACKUP_*` と鍵パス、ネットワーク |
| 起動時に落ちる | `PK_TOKENS` が空文字でないか、`PK_PORT` が 1〜65535 か（不正値は起動時エラー） |
| Windows 再起動後に繋がらない | WSL が自動起動しているか（タスクスケジューラ登録）。`wsl.exe -d <distro> -e systemctl status personalknowledge-mcp` |

---

## あなたが行う作業のチェックリスト

- [ ] STEP 1: WSL の systemd 有効化 → **NodeSource で Node 22 をシステム導入**（`/usr/bin/node`）→ `pnpm install --frozen-lockfile` → `pnpm run build`
- [ ] STEP 2: `.env` 作成（`chmod 600`）、`PK_TOKENS` を生成・設定、`PK_HOST=127.0.0.1`、**`PK_DB_PATH` をリポジトリ外の絶対パスに**
- [ ] STEP 3: `pnpm start` で疎通 → Claude Code から接続 → systemd 常駐化 → WSL の自動起動をタスクスケジューラに登録
- [ ] STEP 3.5: 開発と本番の同居ルールを把握（ビルド後は restart／`dev` はポートと DB を分ける）
- [ ] STEP 4: `ingest_document` で書類取り込みを試す
- [ ] STEP 5（任意）: Cloudflare Tunnel + Access → claude.ai でコネクタ登録
- [ ] STEP 6（任意）: サービスアカウント＋Drive フォルダ → `pnpm run backup` → タイマー
- [ ] STEP 7（任意）: Discord Webhook → `pnpm run reminders` → タイマー
