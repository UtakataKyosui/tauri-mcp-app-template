# kanban Mod

Tauri 製の看板と Claude Code を繋ぐ function hooks プラグイン。看板のカードが
タスクの目的・要件・到達点・担当(claude / codex、モデル、effort)を持ち、Mod は
それを読み書きするだけで、モデルの選択を自分で行わない。

## 看板アプリが公開する HTTP 契約

Tauri 側は `setup()` で Unix socket に HTTP を立てる。Mod は `$.http.fetch` の
`socketPath` で叩くため、TCP ポートは開けない。既定のパスは
`$HOME/.local/share/sample-tauri-app/board.sock`（`$CLAUDE_KANBAN_SOCK` か
プラグイン設定 `socketPath` で上書き可能）。

| メソッド | パス | 本体 | 返す |
|---|---|---|---|
| GET | `/board` | — | `{ cards: Card[], focus?: string }` |
| GET | `/cards/:id` | — | `Card` |
| POST | `/cards` | `Card`（`updatedAt` と `entries` を除く） | — |
| PATCH | `/cards/:id` | `Partial<Card>` | — |
| DELETE | `/cards/:id` | — | — |
| POST | `/cards/:id/progress` | `{ entry: ProgressEntry, summary?: string }` | — |
| POST | `/cards/:id/runs` | `{ runtime, command, model, effort, prompt }` | — |
| POST | `/cards/:id/telemetry` | `TurnRecord` | — |
| POST | `/telemetry` | `TurnRecord`（カード未帰属） | — |
| POST | `/correlations` | `Correlation` | — |

`Card` の形は `hooks/board/types.ts` にある。

`/cards/:id/runs` は Codex の実行依頼である。`$.process.run` は最長 10 分で
reject されるため、Codex の起動と完了の監視は看板アプリ側が持つ。完了したら
アプリが自分で `progress` を追記し、`status` を進める。

## Mod が提供するもの

**ツール**（モデルが呼ぶ）

- `mcp__kanban__board` — 全カードを状態つきで返す
- `mcp__kanban__card` — カード1枚
- `mcp__kanban__progress` — 進捗を追記し、到達点を置き換える
- `mcp__kanban__move` — 状態を変える
- `mcp__kanban__dispatch` — カードの指名どおりに実行者へ投げる

**SubAgent**（`hooks/board/plan.ts` の `ROLES` が定義元）

`kanban:implement` / `kanban:review` / `kanban:refute`。カードの
`assignment.role` がどれを使うかを指す。

**プロンプト介入**

- `prompt.context` — **不変の運用ルールだけ**を会話の先頭に置く
- `prompt.submit` — 送信されたプロンプトの先頭に、フォーカス中のカードの要約を付ける
- `agent.spawn` — モデル未指定の SubAgent に、カードが指名したモデルを当てる

## 看板アプリが落ちている場合

書き込みは `$.store` の `board.outbox` に積まれ、次に届いた時点で投入順に流れる。
未送信が残っている間は、その件数が会話の context ブロックに出る。

読み取りは 1.5 秒で諦め、フォーカスは「なし」として扱う。`$.http.fetch` は
timeout も signal も取らないため、ソケットファイルだけが残って listener が
居ないとき呼び出しは返らない。フックの予算は `$` の待ちを打ち切らないので、
期限は `$.clock.sleep` との race で自前に切っている。

## Phase による Skill / SubAgent の制限

カードの `phase`（省略時は `status`）をキーに、看板の `policies` が
その Phase で使ってよい Skill / SubAgent を持つ。`deny` が優先し、`allow`
があればそこに無いものを拒否する。Phase にポリシーが無ければ全て許可する。

```json
{
  "policies": {
    "review": {
      "skills": { "deny": ["deploy"] },
      "agents": { "allow": ["kanban:review", "kanban:refute"] }
    }
  }
}
```

### 何がどこで止まるか

| 対象 | 機構 | 一覧から消えるか | 呼んでも効かないか | 中身が入らないか |
|---|---|---|---|---|
| SubAgent | `agent.offer` → `{ isOffered: false }` | ○ | ○ | — |
| Skill の一覧 | `prompt.attachment` の `skill_listing` をフィルタ | ○ | — | — |
| Skill（ツール経由） | `tool.call { tool: "Skill" }` → `{ deny }` | — | ○ | ○ |
| Skill（スラッシュ・プリロード） | `skill.prompt` → 拒否文に差し替え | — | ○ | ○ |

Skill は3層で塞ぐ。一覧から消すだけでは、名前を知っているモデルや
スラッシュコマンドの経路が残る。ツールの deny だけでは、スラッシュや
プリロードの経路で中身がコンテキストへ入る。

### 看板が読めないときは絞らない

ポリシーが引けないときは何も絞らない。遮断側に倒すと、看板の不在だけで
全 SubAgent が消え、原因に気づけなくなる。

### ポリシー変更の反映

フォーカスとポリシーは 10 秒キャッシュする。看板がカードやポリシーを編集したら
**socket と同じディレクトリの `board.revision` を touch する**。Mod は
`classic.SessionStart` の `watchPaths` でこのファイルを engine の監視に載せ、
`classic.FileChanged` を受けてキャッシュを捨てる。ポーリングは行わない。

`move` と `dispatch` も自分でキャッシュを捨てる。

### Skill 一覧の出どころ

Skill 一覧は `prompt.section` ではなく `prompt.attachment` の
`type: "skill_listing"` として届く（実セッションで観測して確認した）。
SubAgent 一覧は `agent_listing_delta` だが、こちらは `agent.offer` が既に
絞るため触らない。

一覧はプロセスごとに保持されるので、ポリシーが変わったら
`$.ui.invalidate("prompt.attachment")` で引き直させる。

## 計測と OpenTelemetry

コスト・ターン数・使用ツール・使用 Skill・SubAgent の動きを、カードに帰属させた
状態で看板へ送る。送信はターン境界でまとめて行う。`tool.call` ごとにソケットへ
往復すると、全ツール呼び出しにレイテンシが乗るため。

### USD の算出

Mod は USD を計算しない。トークン数（input / output / cache_read /
cache_creation）と `model` を送り、**単価表は看板が持つ**。値上げや新モデルの
追加は看板を直せばよく、過去のレコードも再計算できる。

### なぜ Mod 自身が測るのか

Claude Code のネイティブ OTel だけでは、**タスク単位のコストが出せない**。

| signal | 持つ属性 | カードへ寄せられるか |
|---|---|---|
| metric (`claude_code.cost.usage`, `claude_code.token.usage`) | `session.id`, `model`, `agent.name`, `skill.name`, `mcp_tool.name` | セッション単位まで。`prompt.id` が付かない |
| event (`claude_code.user_prompt`, `claude_code.tool_result`, `claude_code.assistant_response`) | `session.id`, `prompt.id` | プロンプト単位まで寄せられる |

1 セッションで複数のカードを進める前提だと、metric の `session.id` ではカードを
分けられない。そこで Mod は `turn.complete` の `usage`（input / output /
cache_read / cache_creation と model）と `durationMs` を自分で記録する。この
フックが発火する時点で Mod はフォーカスカードを知っているため、帰属が保証される。

`session.measure` の累積 USD の差分を使う案は採らなかった。SubAgent が並走すると
帰属が崩れるうえ、差分の起点をどこに置くかで意味の違う数字が出るため。

### ネイティブ OTel との突き合わせ

`classic.UserPromptSubmit` から `session_id` と `prompt_id` を拾い、
`POST /correlations` でカードとの対応を保存する。`prompt_id` は OTel のイベント
属性 `prompt.id` と同じ値なので、看板側が OTLP で受けたイベントをカードへ寄せ
られる。metric 側は `session.id` でしか寄らない。

ネイティブ OTel の有効化は Mod からはできない。`CLAUDE_CODE_ENABLE_TELEMETRY`
は起動時に読まれ、プラグインのロードより前に OTel が初期化される。`.claude/
settings.json` の `env` に書く。

```json
{
  "env": {
    "CLAUDE_CODE_ENABLE_TELEMETRY": "1",
    "OTEL_LOGS_EXPORTER": "otlp",
    "OTEL_METRICS_EXPORTER": "otlp",
    "OTEL_EXPORTER_OTLP_PROTOCOL": "http/json",
    "OTEL_EXPORTER_OTLP_ENDPOINT": "http://127.0.0.1:4318"
  }
}
```

OTLP の受信とエンコードは看板アプリ側が持つ。Mod は `POST /telemetry` に素の
JSON を投げるだけにして、停止時の outbox 経路をそのまま使う。

### プロンプトキャッシュとの関係

`prompt.context` のブロックは会話の**最初のユーザーメッセージ**に乗る。書き換えると
以降の全リクエストの接頭辞が変わり、プロンプトキャッシュが全損する。だからここには
不変のルールだけを置き、`$.ui.invalidate("prompt.context")` は一度も呼ばない。

毎ターン変わるカードの状態は `prompt.submit` が運ぶ。こちらは新しいメッセージの
末尾に足されるだけなので、既にキャッシュされた接頭辞を傷つけない。1 プロンプトに
つき 5 行ほど増えるが、状態が常に最新であることと引き換えになる。

### 帰属のタイミング

計測レコードの帰属先は、**プロンプトの入口で確定させたカード**である。
`turn.complete` で引き直さないのは、そこでは `next.signal` が既に abort して
おり、読み取りが即座に失敗して未帰属レコードになるため。エラーは出ず、
`cardId` が空のレコードが静かに溜まる。

USD の差分の起点も、前のターン終了時点で読んだ値に固定する。`session.measure`
はコストが増えるたびに発火するので、そちらで起点を更新すると差分がほぼ 0 になる。

### SubAgent と Skill の観測

| 項目 | 取得元 | 帰属 |
|---|---|---|
| SubAgent の型名・モデル・background | `agent.spawn`（`tool_use_id` で識別） | 親ループ |
| SubAgent の状態 | `turn.complete` で `$.agent.list()` を1回引き、そのターンで見た id だけ残す | 自ループ |
| SubAgent の最終回答 | `turn.complete` の `e.answer`（先頭 1000 字 + `answerLength`） | 自ループ |
| Skill 名（ツール経由） | `tool.call { tool: "Skill" }` の `e.skill` | 呼んだループ |
| Skill 名（スラッシュ・プリロード） | `skill.prompt` の `e.skill` | main に寄る |

`agent.spawn` の時点ではまだ `agentId` が無いため、spawn の記録は `tool_use_id`
で持つ。実際に動いた結果は `agentStates` と、その SubAgent 自身の `TurnRecord`
が持つ。`AgentInfo` の `spawnedBy` があるので、この Mod が spawn したのか
モデルが自分で呼んだのかは看板側で区別できる。

Skill は `skill.prompt` が Skill ツール経由・スラッシュ・プリロードの全部で
発火するため、ツール経由で既に数えた分は飛ばす。各レコードに `via`
(`tool` / `expansion`) を残してあるので、判定が外れて二重に入っても看板側で
判別できる。

### effort を観測しない理由

実際に適用された effort は `turn.step` が持つが、読むには**全モデル
リクエストのストリームを自分のジェネレータに通す**必要がある。doc が
「a chunk once yielded stays, so a hook that fails mid-stream is left where it
stood」と警告している経路で、計測のためにストリームを壊すリスクを取ることに
なる。`TurnRecord` の `effort` はカードの指名を写したもの。指名と実際がズレる
経路が観測できるようになったら、そのとき検討する。

### 集計から外すもの

`mcp__kanban__*` は使用ツールの集計に入れない。progress を書くたびに使用回数が
増えてしまうため。SubAgent のターンも `turn.complete` に来るので、`agentId` ごと
にバッファを分けて二重計上を避けている。

ただし `skill.prompt` の入力は `{ skill, text }` だけで `agentId` を持たない。
**SubAgent が使った Skill も main のターンレコードに寄る。**

## 既知の制約

`focus` が未設定のとき、Mod は最初に見つけた `doing` のカードを掴む。Claude と
Codex が並走して `doing` が複数ある状況では、どのセッションも同じカードを指す。
セッションごとに別のカードを掴ませる必要が出たら、`$.store` にセッション単位の
focus を持たせる。

フォーカスは 10 秒キャッシュする。計測フックからも引かれるため、毎回ソケットを
往復させると計測がセッションを遅くする。`move` と `dispatch` はキャッシュを捨てる。

計測のバッファはモジュールの環境に置く。ホットリロードとクラッシュで失われるが、
ターン境界と `session.end` で流すため、落ちるのは進行中のターン1つ分に留まる。

## 開発

```bash
claude plugin validate .
claude plugin test .
claude --plugin-dir .
```

型定義は `/plugin-types types` で再生成する。`types/kanban-tools.d.ts` だけは
手書きで、この Mod のツールの引数を `McpToolInputs` へ宣言マージしている。
MCP ツールの引数は `e.input` ではなく `e` 直下に来る。
