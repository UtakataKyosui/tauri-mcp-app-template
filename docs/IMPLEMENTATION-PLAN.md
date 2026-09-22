# 実装計画: Claude Code / Codex 協働のための GUI 看板

Tauri 製の GUI 看板を、Claude Code は Mod (`example-mcp-mod-plugin/`) 経由、
Codex などは MCP 経由で操作する。看板のカードがタスクの唯一の記録で
あり、誰がどのモデルを何 effort で担当するかを決める。

## 全体の形

```
Claude Code ── kanban Mod ── Unix socket / HTTP ──┐
                                                  ├── Tauri 看板 (Rust)
Codex / 他の MCP クライアント ── Streamable HTTP /mcp ┘    ├─ 状態の所有者
                                                       ├─ OTLP 受信（後続 Phase）
                                                       └─ 単価表と集計（後続 Phase）
```

Claude Code は既存 Mod のフック・ツールから看板へ接続する。Codex などの MCP
クライアントは Tauri 内の MCP サーバーへ接続する。両入口は同じ Rust の状態を
使い、Mod のキャッシュ以外に独立した看板状態を作らない。MCP の URL は
`http://127.0.0.1:8765/mcp`、Mod の Unix socket は
`$HOME/.local/share/sample-tauri-app/board.sock` とする。

Tauri の公式 HTTP plugin はクライアント、localhost plugin は画面資産の配信向け。
MCP サーバーには Rust の `rmcp` と Axum を Tauri プロセス内で起動する。


状態の所有者は Rust プロセス 1 本にする。Mod は読み書きするだけで、キャッシュ
以外の状態を持たない。

## 現状

### 済み: Mod 側

`example-mcp-mod-plugin/` に実装済み。`claude plugin validate` / `tsc` /
`claude plugin test`（15 件）が通る。**ただし看板アプリが無いため、socket 越しの
経路は end-to-end で一度も動いていない。**

| 機能 | 実装 |
|---|---|
| カードの CRUD | `mcp__kanban__board` / `card` / `progress` / `move` / `dispatch` |
| モデル振り分け | カードの `assignment` に従う。Mod は選ばない |
| SubAgent の定義 | `$.agent.register` で `kanban:implement` / `review` / `refute` |
| プロンプト介入 | `prompt.context`（不変ルール）/ `prompt.submit`（カードの要約） |
| 計測 | ターン数・トークン・ツール・Skill・SubAgent をカードに帰属させて送る |
| OTel 突き合わせ | `classic.UserPromptSubmit` の `prompt_id` を `/correlations` へ |
| Phase 制限 | `agent.offer` と `prompt.attachment`(`skill_listing`) と `skill.prompt` |
| 停止時の緩衝 | `$.store` の outbox に積み、次に届いた時点で投入順に流す |

### 残り: 看板アプリ側

## Phase 1: HTTP 契約 (#1)

`setup()` で axum を Unix socket に立てる。既定パスは
`$HOME/.local/share/sample-tauri-app/board.sock`。

| メソッド | パス | 本体 |
|---|---|---|
| GET | `/board` | → `{ cards, focus?, policies? }` |
| GET | `/cards/:id` | → `Card` |
| POST | `/cards` | `Card`（`updatedAt` と `entries` を除く） |
| PATCH | `/cards/:id` | `Partial<Card>` |
| DELETE | `/cards/:id` | — |
| POST | `/cards/:id/progress` | `{ entry, summary? }` |
| POST | `/cards/:id/runs` | `{ runtime, command, model, effort, prompt }` |
| POST | `/cards/:id/telemetry` | `TurnRecord` |
| POST | `/telemetry` | `TurnRecord`（カード未帰属） |
| POST | `/correlations` | `Correlation` |

型の定義元は `src-tauri/src/board.rs`。`serde` と Specta から TypeScript を
生成し、GUI と Mod が参照する。詳細は `DATA-MODEL-PLAN.md`。

カードやポリシーを編集したら、socket と同じディレクトリの `board.revision`
を touch する。Mod が engine のファイル監視でこれを受け、キャッシュを捨てる。

## Phase 2: Codex の実行監督 (#2)

Codex 自身の看板操作は MCP を使う。Mod の `dispatch` から Codex を自動起動する
機能は、この実行監督ができるまで利用可能としない。

`POST /cards/:id/runs` を受けたら、看板が Codex を起動して完了まで面倒を見る。
Mod が持たないのは、`$.process.run` が最長 10 分で reject されるため。

- 起動: `codex --model <model> ...`（`command` と `model` は本体が指定する）
- 完了: 看板が自分で `progress` を追記し、`status` を進める
- 失敗: `status` を `blocked` にし、失敗の内容を `progress` に残す

## Phase 3: OTLP 受信と集計 (#3)

`OTEL_EXPORTER_OTLP_PROTOCOL=http/json` の 4318 で OTLP を受ける。有効化は
`.claude/settings.json` の `env` に書く（`$.env.set` では間に合わない。
`CLAUDE_CODE_ENABLE_TELEMETRY` は起動時に読まれる）。

**コストの主データは Mod の `TurnRecord` である。** ネイティブ OTel の
`claude_code.cost.usage` は metric で、metric には `prompt.id` が付かず
`session.id` しか無い。1 セッションで複数カードを進めるとカード単位に分けられない。

| 用途 | データ |
|---|---|
| カード単位のコスト | `TurnRecord` のトークン × 看板が持つ単価表 |
| カード単位のターン数・所要時間 | `TurnRecord` |
| プロンプト単位の詳細 | OTel の event（`prompt.id` で `/correlations` 経由で寄せる） |
| セッション単位の総計 | OTel の metric（`session.id` で寄せる） |

単価表は看板が持つ。値上げや新モデルの追加は看板を直せばよく、過去の
レコードも再計算できる。

## Phase 4: GUI (#4)

- カード一覧とレーン（`status` / `phase`）
- カードの編集（目的・要件・`assignment`・`phase`）
- Phase ごとのポリシー編集（許可する Skill / SubAgent）
- 計測の可視化（カード別のコスト・ターン数・使用ツール・使用 Skill）
- 編集のたびに `board.revision` を touch

## 実測で確認した事実

Claude Code 2.1.278、2026-09-22 に実セッションで観測した。

観測には `claude-mod-probe` スキルを使う（`~/.claude/skills/claude-mod-probe/`）。

| 事実 | 確認方法 |
|---|---|
| Skill 一覧は `prompt.attachment` の `type: "skill_listing"` | 使い捨ての観測プラグインで全 attachment の type を列挙 |
| SubAgent 一覧は `agent_listing_delta` | 同上 |
| `prompt.section` に Skill 一覧は無い | 全セクション名を列挙（`memory`, `env_info_simple` など 24 件） |
| `classic.UserPromptSubmit` は `session_id` と `prompt_id` を持つ | 実値の UUID を観測 |
| `classic.SessionStart` の `watchPaths` は実際に効く | 監視パスを touch して `classic.FileChanged` の発火を確認 |
| MCP ツールの引数は `e` 直下 | `claude plugin test` |
| `agent.offer` の fail-open が効く | `claude plugin test` |

## 設計の決定と理由

| 決定 | 理由 |
|---|---|
| transport は Unix socket + HTTP | `tauri-plugin-store` のファイル直接編集は store のメモリキャッシュに上書きされ、全文書き込みで壊れる |
| Codex の監督は看板が持つ | `$.process.run` は最長 10 分 |
| モデル選択は看板が持つ | Mod にロジックを置くと GUI から見えない |
| SubAgent の定義は Mod に寄せる | 定義元を 1 箇所にする。`~/.claude/agents/role-*.md` の削除は #6 |
| USD は看板が計算する | 単価表を 1 箇所にし、過去分を再計算できるようにする |
| `prompt.context` は不変のルールだけ | 会話の最初のメッセージに乗るため、書き換えるとプロンプトキャッシュが全損する |
| 看板が読めないときは絞らない | 遮断側に倒すと、看板の不在だけで全 SubAgent が消え、原因に気づけない |

## 既知の制約

- `focus` が未設定のとき、最初に見つけた `doing` のカードを掴む。Claude と
  Codex が並走して `doing` が複数あると、どのセッションも同じカードを指す (#5)
- `skill.prompt` は `agentId` を持たない。SubAgent が使った Skill のうち、
  Skill ツールを経由しないもの（スラッシュ・プリロード）は main に寄る
- 実際に適用された effort は観測しない。`turn.step` を通す必要があり、計測の
  ために応答ストリームを壊すリスクを取ることになる
