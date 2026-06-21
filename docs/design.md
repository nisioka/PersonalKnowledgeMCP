# 家庭内ナレッジベース・システム設計書

## 0. 目的
自分と家庭内の状況を蓄積知識として残し、AI（主にClaude）から参照・登録できるようにすることで、我が家に合った提案・改善を可能にする。脳内メモリの解放と、散在する家庭内情報の一元化・検索可能化を目指す。

### 想定する活用例
- 家庭内ドキュメントの検索可能化（自治体プリント、学校の手紙、家電保証書、確定申告メモ等）
- ライフログの自動整理（日記、月末支出トレンド分析）
- 固定費・サブスク見直しシミュレーション
- 保証期限・納期などの能動的リマインド（構造抽出の発展形）

---

## 1. 全体アーキテクチャ
3層構成を採用する。

```
[収集層 Ingestion]
  └─ Claude が書類（画像/PDF）/テキストを読み取り → MCP register ツールで登録
     （MCP プロンプト ingest_document が抽出手順を指示。OCR・抽出とも Claude が担当）
        │
        ▼
[知識ストア層 Knowledge Store]
  └─ SQLite + sqlite-vec（単一DB、scopeカラムで論理分割）
     + ファイル実体はローカルディレクトリ
        │
        ▼
[参照・推論層 Retrieval / Reasoning]
  └─ MCP search / reason ツール（RAG）→ Claude
```

### 設計原則
- **単一DB・単一MCPサーバ**：物理分割せず、scopeカラムとトークン認可で分離する
- **スキーマレス寄りの構造抽出**：生データ＋抽出済みメタ(JSON)をペアで保持し、抽出ルールは後から育てる
- **権限はサーバ側で強制**：クライアントが指定したscopeを信用しない

---

## 2. 稼働環境
| 項目 | 決定 | 理由 |
|---|---|---|
| 稼働マシン | Ubuntu Server（常時起動） | MCPサーバは常駐プロセス。メインWindows機は再起動/スリープが多く常駐に不向き。24時間到達可能であることが外部アクセスの価値の源泉 |
| メインWindows機 | 非依存（クライアントとしてのみ利用） | メイン用途を圧迫しない |

### リソース見積もり
- 書類の OCR・構造抽出は Claude 側で行うため、サーバには OCR エンジンを常駐させない
- MCPサーバ本体・SQLite・ベクトル検索はごく軽量。ミドルスペックはもちろんロースペックでも実用範囲

---

## 3. 言語選定

実装は **TypeScript 単一言語**。

| コンポーネント | 言語 | 理由 |
|---|---|---|
| MCPサーバ本体・各CLI（バックアップ／リマインダー） | TypeScript / Node.js | 本業主力で開発・保守が最速。静的型でスキーマ駆動に向き「後から育てる」設計と相性良。`@modelcontextprotocol/sdk` が充実 |

書類の OCR・構造抽出は専用の処理系を持たず **Claude 本体に担当させる**ため、別言語（Python 等）の
常駐サービスは不要。

---

## 4. 知識ストア設計

### ストア選定
- **SQLite + sqlite-vec**：ローカル完結、全文検索＋意味（ベクトル）検索を両立、軽量
- ファイル実体（原本画像/PDF）はローカルディレクトリに保存し、DBにはパスを持つ

### スキーマ（documents テーブル）
```sql
documents
  id            -- 主キー
  source_type   -- 'discord' | 'mcp' | ...（投入経路）
  raw_path      -- 原本ファイルのパス（テキストのみの場合はNULL）
  full_text     -- 全文（OCR結果 or 入力テキスト）
  doc_type      -- '保証書' | '自治体通知' | '学校手紙' | ...（種別）
  extracted     -- JSON（抽出済みメタ。型自由：{amount, ...}）
  scope         -- 'private' | 'work' | 'shared'
  valid_until   -- 有効期限（DATE）。無期限は番兵値 '9999-12-31'
  deleted       -- 論理削除フラグ（BOOLEAN）。手動アーカイブ用
  created_at
  embedding     -- ベクトル（sqlite-vec）
```

`valid_until` と `deleted` は検索のたびにWHERE句で必ず使うため、`extracted` JSON内ではなく**documentsテーブルの独立カラムに昇格**させ、インデックスを張る（`json_extract` での比較より高速）。それ以外の可変な抽出項目は `extracted` JSON のまま。

### 構造抽出を「後から育てる」設計
- 保存時は必ず **生データ（raw_path / full_text）＋ 抽出済みメタ（extracted JSON）** をペアで持つ
- `extracted` はJSONカラム（SQLite JSON1拡張）。新しい属性を足してもスキーマ変更不要
- 抽出は Claude 本体が担当する。抽出指示は MCP プロンプト `ingest_document`（doc_type 語彙・`valid_until` 推定・`dedup_key` の付け方の指針）に集約し、Claude がそれに沿って項目を埋め `register` を呼ぶ
- 「保証期限も抽出したい」と思ったら、このプロンプトに1行足すだけ。既存データを壊さない

### データライフサイクル管理（古い知識の扱い）
古い情報が残り続けると、検索ノイズ（期限切れ情報の誤ヒット）、AIの判断汚染（解約済みサブスク等を現状と誤認）、コンテキスト圧迫が起きる。一方、過去情報には履歴分析の価値があるものも多く（去年の固定資産税額など）、単純削除は不適。

**方針：ステータス管理ではなく日付フィルタで解決する。**
- `valid_until`（有効期限の日付）を構造抽出時に推定して付与する。イベント案内→開催日、保証書→保証終了日。無期限の情報（住所など）は番兵値 `'9999-12-31'` を入れる（NULLにしない＝フィルタ条件を `valid_until >= today` 一本に統一できる）
- 検索時のデフォルトフィルタは以下の2条件のみ：
  ```sql
  WHERE valid_until >= :today
    AND deleted = false
  ```
- これで期限切れは自動的に通常検索・提案から外れる。**状態遷移cronは不要**（日付という事実だけで派生状態を持たないため、二重管理の事故も起きない）
- 履歴照会（「去年いくらだった?」）のときだけ `valid_until >= today` を外して全期間を対象にするオプションを用意
- `deleted`（論理削除フラグ）は手動アーカイブ用。明確に不要なものだけ自分で `true` にして検索対象外へ。物理削除は本当に消したいものに限定
- `valid_until`（情報自体の性質）と `deleted`（人間の操作）は直交する2軸なので別々に持つ

### 能動的提案への発展
`extracted` / `valid_until` を日次cronで走査し、保証切れ・納期接近などをDiscordへ通知（後付け容易）。

---

## 5. スコープ分割と認可

### 基本方針
- 全レコードに `scope`（private / work / shared）を持つ
- **scope はデータのラベル、アクセス可否はトークンが決める**（二段構え）
- `shared` は private/work の両方から見える共用知識（例：自宅住所、連絡先テンプレ）
- 検索時は常に「対象scope ＋ shared」を含める設計とし、共用を自然に効かせる

### 接続経路と認可マトリクス
| 接続元 | 経路 | トークン | 読める scope | 書ける scope |
|---|---|---|---|---|
| メイン機 Claude Code | LAN直結 `http://server-ip:port/mcp` | full | private / work / shared | 全部 |
| 仕事用クライアント | LAN or Tunnel | work-token | work / shared | work / shared |
| 家族スマホ Claudeアプリ | Cloudflare Tunnel | family-token | shared | shared |

- LAN内アクセスは認証ゆるめ（IP制限のみ）、Tunnel経由は厳格にOAuth、と出し分け
- サーバは `0.0.0.0` でリッスンしつつ、Tunnelには認証付きパスのみ通す

### スコープ強制の実装（最重要）
各MCPツール（search / register / update）の入口で、必ず以下の順序を踏む。**共通ミドルウェア（権限ガード関数）に集約**し、ツールが増えても権限漏れを防ぐ。

1. リクエストのトークンを検証
2. トークンから許可scope集合を導出（例：work-token → `{work, shared}`）
3. クライアントが要求したscopeを許可集合と突き合わせ、はみ出すものは破棄
4. SQLクエリに `scope IN (許可集合)` を**サーバ側で強制注入**
5. 書き込みも同様に、許可外scopeへの書き込みは拒否

クライアントが指定したscopeは信用しない。新規ツールはこのガードを通すだけで安全になる。

---

## 6. 接続経路の詳細

### 経路は2系統、MCPサーバは1つ
同一のStreamable HTTP MCPサーバに対し、用途で入口を分ける。

| 接続元 | 経路 | トランスポート | 遅延 |
|---|---|---|---|
| メイン機 Claude Code | LAN直結（`http://server-ip:port`） | Streamable HTTP | ほぼゼロ（1ms未満〜数ms） |
| スマホ/Web の Claudeアプリ | Anthropicクラウド → Cloudflare Tunnel | Streamable HTTP | 数百ms〜1s |

### 重要な前提
- メイン機 Claude Code → Ubuntuサーバは**別マシン間のHTTP接続（分類上はリモートMCP）**だが、通信はLAN内で完結しインターネットを経由しない → 遅延ほぼゼロ
- claude.ai / スマホアプリ経由は Anthropicクラウドがブローカーとなるため、同じ家からでもインターネットを往復する（ただしClaudeの生成時間が支配的で体感差は小さい）

### スマホアプリ対応の前提
- Claudeスマホアプリは2025年7月よりリモートMCPに対応。設定はclaude.aiのWeb版で行い、モバイルに自動同期される（スマホ単体では追加不可）
- カスタムコネクタはAnthropicクラウドから接続するため、MCPサーバはパブリックインターネットから到達可能である必要がある（VPN/ファイアウォール内のサーバは不可）→ Cloudflare Tunnelで公開する
- **他社アプリ非対応の確認済み事項**：Geminiの個人向けスマホアプリはカスタムMCP非対応（Enterprise/CLIのみ）。ChatGPTはディープリサーチモード限定。実質Claudeアプリに寄せるのが合理的
- 将来の他社対応の保険として、**標準のStreamable HTTPトランスポート＋OAuth 2.1**で素直に実装しておく（Gemini Enterprise等への移行時もサーバ側を流用可能）

---

## 7. 認証基盤

### 採用：Cloudflare Tunnel + Cloudflare Access
- 自宅サーバのMCPサーバを Cloudflare Tunnel で限定公開（ポート開放不要、自宅IPも隠れる）
- トークン管理は Cloudflare Access に寄せる（自前OAuthサーバの重い実装＝Dynamic Client Registration等を回避）
- MCPサーバは Access が付与するヘッダ（認証済みユーザーのメアド等）を見て scope にマッピングするだけ
- 人数が少なく（自分＋家族）、メアドや経路でざっくり分けられれば十分なため、工数対効果でAccessが勝る

### データ保護
- データ実体（SQLite、ファイル）は自宅サーバ内に留まり、外に出るのはMCPツールの応答のみ
- 機微情報（アレルギー情報、保険証等）を扱う前提のため、データは自宅外に出さない設計を堅持

### セキュリティ注意
カスタムコネクタはAnthropic未検証サービスへの接続を許可し、Claudeがアクション実行できる。書き込み系ツールの権限設計とOAuthスコープは慎重に行う。

---

## 8. 実装ロードマップ
各段階で動作確認しながら積み上げる。

### Phase 1：土台（LAN内で動く最小構成）
1. スキーマ定義（documents テーブル ＋ scope ＋ valid_until / deleted ＋ sqlite-vec）
2. 権限ガード関数（共通ミドルウェア）＋ 検索デフォルトフィルタ（valid_until >= today AND deleted = false）
3. MCPサーバ骨組み（search / register の2ツール、Streamable HTTP、scope強制）
4. メイン機の Claude Code から LAN直結で叩けることを確認

### Phase 2：取り込み ＋ 訂正
5. **Claude 主導の取り込み**：書類を Claude（Code / デスクトップ / アプリ、または Claude Code の
   Discord 連携「Channels」）に添付 → MCP プロンプト `ingest_document` → Claude が OCR・構造抽出 →
   `register`。OCR は Claude のマルチモーダルで賄うため外部 OCR・API キーは不要
6. 抽出指示は MCP プロンプト `ingest_document` に集約（doc_type 語彙・`valid_until` 推定・`dedup_key` の指針）
7. update / delete（soft・hard）/ restore ツール（手動上書き・訂正・復元）＋ 重複の緩い名寄せ（dedup_key）
8. SQLite の Google Drive バックアップ（暗号化・日次cron）

### Phase 3：外部公開
10. Cloudflare Tunnel + Access で外部/スマホ口を開ける
11. claude.ai Web版でカスタムコネクタ登録 → スマホ同期確認
12. 経路別トークン（full / work / family）の scope マッピング

### Phase 4：発展（運用しつつ追加）
- 監査ログ（権限ガードに相乗り）、破壊的操作の実行前確認フロー
- 能動的提案（保証切れ・納期リマインドの日次cron → Discord通知）
- ライフログ自動整理、固定費シミュレーション等のツール追加
- 構造抽出の項目を運用に合わせて拡充

---

## 9. 運用上の考慮事項
実運用に入ってから問題化しやすい論点。優先度の高いもの（重複・更新／バックアップ）は Phase をまたぐ前に方針を確定させる。

### 9.1 入力時の重複・更新の扱い
現設計では register は全て新規レコードとして蓄積される。同一書類の二重投入や、情報の更新（去年→今年の案内）をどう捌くかを決める必要がある。
- 情報の性質が2種ある：**最新だけ欲しいもの**（保育園の電話番号、現行料金プラン）と、**履歴を残したいもの**（各年の固定資産税額、過去の支出）
- 最小実装：register時に `doc_type` ＋ キー項目で緩く名寄せし、更新と判断したら古いレコードを `deleted = true` か `valid_until` 短縮で引っ込める。履歴を残すべき doc_type は名寄せ対象外とする
- 名寄せ判定は構造抽出の精度に依存するため、初期は**手動で上書き・訂正できる update ツール**を必ず持つ（自動名寄せは後から強化）

### 9.2 バックアップとリストア
機微情報を預ける以上、バックアップは必須級。Phase 1〜2 のうちに組み込む。
- **対象：SQLite のみ**（ファイル実体＝原本画像/PDF は対象外）
- **バックアップ先：Google Drive**（既存の Google API 利用パターンを流用可能）
- 日次で SQLite を Google Drive へアップロード。機微情報のため**アップロード前に暗号化**する
- **割り切りの明示**：ファイル実体を対象外とするため、リストア時に `raw_path` の参照先（原本画像）は復旧できない。ただし OCR 済みで `full_text` に本文が入っていれば検索・参照は機能するため、実用上は許容範囲とする。原本が真に重要な書類は別途手元保管で補う

### 9.3 監査ログ
家族・仕事・自分が同一基盤を触るため、操作履歴を残す。
- どのトークン（full / work / family）が、いつ、何を read / write / delete したかを記録
- 権限ガード（共通ミドルウェア）に1行ログを相乗りさせるだけで実装でき、低コスト
- 「誰が消したか」「いつ書き換わったか」を追跡可能にし、共有基盤の安心感を担保

### 9.4 書き込みの確認フロー（AI経由の事故防止）
Claude経由で register / update / delete できるため、AIの誤解による意図しない書き込み・上書き・削除を防ぐ。
- **読み取りは自由、破壊的操作（delete・上書き更新）は実行前に要約を返して確認を求める**という非対称設計
- AIが暴走的に既存データを書き換える事故を一段防ぐ

### 9.5 doc_type の語彙管理
種別が運用で増えると表記ゆれ（「学校手紙」「学校のお便り」「プリント」）が生じ、検索・能動提案のルールが書きにくくなる。
- `doc_type` は完全な自由文字列にせず、**緩い既定リスト＋新規追加時に既存候補を提示**する方式にする
- 表記を収束させ、doc_type 単位のルール（名寄せ対象か、既定の valid_until 推定ルール等）を書きやすくする

### 9.6 「いつの情報か」と「いつ登録したか」の区別
`created_at` は登録日時であり、情報自体の発生日（書類の発行日、イベント日）とは別物。「今年の情報か」を正しく判定するには情報側の日付が要る。
- 情報の発生日（発行日・イベント日）は `extracted` JSON に持たせる（例：`issued_date`, `event_date`）
- `created_at`（登録日時）と混同しないよう、能動提案や履歴照会のロジックでは情報側の日付を参照する

### 9.7 当面は作り込まない（過剰回避）
以下は実運用で不満が出てから対処する。最初から作り込むと持て余す。
- 全文検索とベクトル検索の使い分けチューニング
- 多言語（日英混在）の検索精度対策

---

## 10. 技術スタックまとめ
| レイヤ | 技術 |
|---|---|
| 稼働環境 | Ubuntu Server（常時起動） |
| 知識ストア | SQLite + sqlite-vec |
| ファイル実体 | ローカルディレクトリ |
| バックアップ | Google Drive（SQLiteのみ・暗号化・日次） |
| MCPサーバ・CLI | TypeScript（@modelcontextprotocol/sdk、Streamable HTTP） |
| 書類の OCR・構造抽出 | Claude 本体（MCP プロンプト `ingest_document`、API キー不要） |
| 外部公開 | Cloudflare Tunnel |
| 認証・認可 | Cloudflare Access（scopeマッピング） |
| リマインダー通知 | Discord webhook |
| 参照クライアント | Claude（Code CLI / Web / スマホアプリ） |

---

## 11. 主要な設計判断の記録（なぜそうしたか）
| 判断 | 採用 | 不採用とした選択肢と理由 |
|---|---|---|
| データ分割方式 | 単一DB ＋ scopeカラム | 物理分割（private.db/work.db）→ shared情報の二重管理・横断検索が困難 |
| 漏洩防止 | トークン認可でサーバ側強制 | scopeフィルタのみ → クライアントがフィルタを外せば漏れる |
| 言語 | TypeScript 単一 | ハイブリッド（TS＋Python）→ OCR/抽出を Claude 主導にしたため Python は不要。単一言語で保守が軽い |
| 書類の取り込み・抽出 | Claude 本体に実行させる（`ingest_document` プロンプト→`register`） | 自前 Discord bot＋PaddleOCR＋Anthropic API → API が月額プラン別の従量課金でコストが読みにくい。Claude 主導なら追加課金なし・OCRも内蔵・保守対象も減る |
| 稼働環境 | Ubuntu Server | Windowsメイン機 → 再起動/スリープで常駐に不向き |
| 認証基盤 | Cloudflare Access | 自前OAuth 2.1 → DCR等の実装が重い。人数少なくAccessで十分 |
| OCR | Claude 本体（添付を直接読取り） | PaddleOCR/tesseract（別プロセス・常駐・保守増）、Vision API（従量課金）。Claude が画像/PDF を直接読めるため専用 OCR は不要 |
| スマホ参照 | Claudeアプリに寄せる | Gemini個人アプリ非対応、ChatGPT限定的。標準実装で将来の移行余地は残す |
| 古い知識の扱い | valid_until 日付フィルタ ＋ deleted フラグ | status遷移cron → 日付比較で代替可能で冗長。状態の二重管理事故も招く。単純削除 → 履歴分析価値を失う |
| NotebookLM連携 | 連携しない（調査ツールとして別途併用） | 公式APIはEnterprise限定、非公式APIはCookie依存で脆く、機微情報基盤の依存先に不適。疎結合連携も不要と判断 |
| バックアップ対象 | SQLiteのみ（Google Drive・暗号化・日次） | ファイル実体も含める → 容量大。原本はfull_textで本文が残るため割り切り可。原本重要分は手元保管で補完 |
