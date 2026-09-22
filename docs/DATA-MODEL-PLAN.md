# 看板のデータモデルと実装計画

対象: `IMPLEMENTATION-PLAN.md`。本書は全体の設計案。共有型生成、Mod 用 HTTP、MCP の基本操作は先行実装済みで、残項目は段階的に進める。

## 1. 型の所有者

Rust を共有契約の唯一の定義元とする。元計画 Phase 1 の「hooks/board/types.ts が定義元」はこの方針へ置き換える。

```text
src-tauri/src/board/contracts/*.rs
  ├─ serde: HTTP JSON の読み書き
  ├─ specta::Type: TypeScript 型の生成
  │    ├─ src/generated/board.ts（GUI）
  │    └─ example-mcp-mod-plugin/hooks/board/generated.ts（配布する Mod）
  └─ application service: HTTP / MCP / Tauri command の共通処理
```

生成元・生成処理は一つとし、型だけの同一内容を二つの配布先へ書く。Mod が親ディレクトリや Tauri の実行時 API に依存しない形にする。既存の `src/bindings.ts` は Tauri command 用として維持する。

既存依存は Specta 2.0.0-rc.20、specta-typescript 0.0.7、tauri-specta 2.0.0-rc.20。まず Cargo.lock の解決版に合わせて実装し、型移行のためだけに更新しない。最新ドキュメントは API が異なるため、そのまま転記しない。

## 2. 共通の表現

| 型 | Rust の表現 | JSON / TypeScript と制約 |
|---|---|---|
| Runtime | enum Claude, Codex | `"claude" \| "codex"` |
| Status | enum Backlog, Ready, Doing, Review, Done, Blocked | 現行の小文字リテラルを維持 |
| Effort | untagged enum: Named(String), Budget(u32) | `string \| number`。整数 budget は正数。モデル別の可否は実行時に検証 |
| 各種 ID | 最初は String | 空文字不可。既存 ID を UUID へ強制変換しない |
| カードの日時 | String | UTC RFC 3339。既存 `updatedAt` / `ProgressEntry.at` と互換 |
| 観測日時・時間・カウント | 検証付き f64、または exporter で明示対応した整数 newtype | JSON number。非負・有限、整数項目は安全整数範囲内。u64 を無条件に TS number へ変換しない |

構造体は `Serialize, Deserialize, specta::Type` を derive し、`serde(rename_all = "camelCase")` を指定する。列挙型も wire 名を明示する。

任意フィールドは通常のレスポンスでは欠落させ、`field?: T` に生成する。Rust の `Option<T>` と serde の省略属性だけで意図どおりになるかは、採用版で JSON と生成型の双方を検証する。Specta は実行時の入力検証を代替しない。

## 3. カードと看板

以下のフィールドは現行 Mod と互換にする。`?` は任意フィールド。

| 型 | フィールド |
|---|---|
| Assignment | runtime: Runtime, model: String, effort: Effort, role?: String |
| ProgressEntry | at: String, by: String, note: String |
| AccessRule | allow?: Vec<String>, deny?: Vec<String> |
| Policy | skills?: AccessRule, agents?: AccessRule |
| Card | id: String, title: String, objective: String, requirements: Vec<String>, status: Status, phase?: String, assignment: Assignment, summary: String, entries: Vec<ProgressEntry>, updatedAt: String |
| Board | cards: Vec<Card>, focus?: String, policies?: BTreeMap<String, Policy> |

`status` は進捗、`phase` はポリシーの参照キー。phase 省略時は status を使う。deny 優先、allow 省略は制限なし、allow の空配列は全拒否という既存の意味を維持する。

Card に実行履歴や全 telemetry を埋め込まない。カード一覧取得のサイズと更新範囲を抑える。entries と updatedAt の更新は Rust のサービスを経由する。

## 4. 読み取り型と書き込み型を分ける

`Partial<Card>` は廃止予定とし、更新できるフィールドを Rust の専用リクエスト型に列挙する。

| 型 | 定義・意味 |
|---|---|
| CreateCardRequest | Card から entries / updatedAt を除いたフィールド。id は現行契約どおり入力必須 |
| PatchCardRequest | title / objective / requirements / status / phase / assignment / summary のみ更新可能。id / entries / updatedAt は受け付けない |
| AppendProgressRequest | entry: ProgressEntry, summary?: String |
| PatchBoardRequest（追加） | focus と policies を編集する。GUI の編集経路を用意する |
| ApiError | code: ApiErrorCode, message: String。コード例: invalidInput, notFound, conflict, internal |

PATCH の通常フィールドは省略なら維持、値ありなら置換、null は拒否。phase / focus / policies は省略なら維持、null なら解除、値ありなら置換。assignment と policies は入れ子全体の置換とし、暗黙の深い merge はしない。

Rust では省略・null・値を区別する専用フィールド表現と Deserialize を用意する。単純な `Option<Option<T>>` の derive に依存しない。Specta 側にも同じ JSON 契約を表現させ、三状態の fixture で確認する。

HTTP は作成 201、更新・progress は更新後の Card を 200、削除は 204、run 受付は 202 とする案。入力不正は 400、対象なしは 404、重複 ID や実行競合は 409。GUI も同じサービスと入力型を使用する。

## 5. 実行要求と実行履歴

| 型 | フィールド |
|---|---|
| CreateRunRequest | runtime: Runtime, command: String, model: String, effort: Effort, prompt: String（既存 JSON を維持） |
| RunStatus | queued / running / succeeded / failed / cancelled / interrupted |
| Run | id: String, cardId: String, request: CreateRunRequest, status: RunStatus, createdAt: String, startedAt?: String, finishedAt?: String, exitCode?: i32, error?: String |

最初の run executor は codex のみ対応し、claude の HTTP run 要求は入力エラーにする。Claude の SubAgent 起動は現行 Mod が担当する。

受付時に要求の runtime / model / effort と現在の assignment が一致するか確認し、不一致は conflict とする。Run に受付時の値を保存し、後からカードを編集しても実行履歴を変えない。command は実行ファイルとして引数配列で起動し、shell コマンド文字列として評価しない。作業ディレクトリはサーバーが管理するプロジェクト設定から決め、起動時の偶然の cwd に依存しない。

一つのカードの同時実行は初期実装では一件まで。プロセス成功は作業の受入完了とは分け、成功時は review、失敗時は blocked に進める案とする。ユーザーが実行中に status を変更した場合は、完了イベントで無条件に上書きしない。

## 6. 計測と帰属

既存 `TurnRecord`, `Correlation`, `SkillUse`, `AgentSpawnRecord`, `AgentState` の全フィールドを Rust へ移す。インラインの tokens と tools の要素は `TokenUsage` / `ToolUse` として名前を付ける。agent の status / type / reason は外部値なので閉じた enum にしない。SkillUse.via は tool / expansion / blocked の enum にする。

| 追加する型 | 用途 |
|---|---|
| StoredTurn | id、受信時刻、TurnRecord、必要に応じた runId / runtime。観測値と保存メタデータを分離 |
| SessionBinding | runtime, sessionId, cardId, runId?。並行セッションの帰属を明示 |
| ModelPrice | runtime, model, effectiveFrom、100万 token あたりの input / output / cacheRead / cacheCreation 単価 |
| CardMetrics | cardId, turnCount, durationMs, tokens、推定 USD、価格未解決件数、ツール・Skill 使用回数 |

現行 TurnRecord に runtime がないため、Mod 受信経路は claude として保存する。Codex 計測を導入する段階で供給元を明示する。effort は要求値として保持し、実際に適用された値と見なさない。

金額は永続化では十進文字列を用い、集計側で精度と丸めを規定する。単価不明をゼロ円として扱わない。単価の期間と観測日時から適用価格を選ぶ。価格修正時の再計算結果と、当初の計算結果を区別できる価格識別子を保持する。

OTel event は sessionId + promptId で Correlation に結び付ける。session の metric をカードへ按分しない。先に event が届いた場合は未解決として保存し、correlation 到着後に関連付ける。Mod と OTel のコストを加算しない。

SessionBinding を導入する際は Mod 側の focus 選択も同時に変更する。選択順は明示的な session binding → 明示 focus → doing が一件だけの場合の補完。doing が複数なら未帰属とし、先頭を勝手に選ばない。グローバル focus だけを残す段階では既知の並行実行問題は未解決。

## 7. 再送・永続化

Mod の outbox は応答を受け取れなかった書き込みを再送する。progress と run の POST はそのままでは二重追記・二重起動になる。

PendingOp は Mod 内部型として TS に残し、operationId を追加する。enqueue 前に発行し、再送でも同じ `Idempotency-Key` を送る。サーバーはキー・要求内容・応答を永続化し、同一要求には同一結果を返し、同じキーで内容が違えば conflict にする。既存 outbox は読込時に ID を付け、送信前に保存する。

永続状態は schemaVersion を持ち、cards / policies / bindings / runs / turns / correlations / 操作重複排除を Rust が所有する。保存方式は Phase 1 の実装開始時に確定する。少なくとも「状態変更と重複排除記録を一緒に確定」「run 受付を起動前に保存」「再起動時に running を interrupted として回復」を満たす方式を選ぶ。

card 削除時は focus / binding を解除する。実行中の削除は conflict にする。過去 run / telemetry は元の cardId を残して保持する。保存成功後に board.revision を更新する。通知失敗は状態保存失敗と混同せず、通知の再試行を行う。

## 8. 実装順序と完了条件

1. **共有型と生成経路**: Rust の contracts に現行型・専用リクエストを定義。既存 export_bindings の仕組みを踏まえ、アプリを起動しない生成入口を設ける。HTTP だけで使う型も明示登録する。生成は単一処理で GUI / Mod 向けファイルを更新する。
2. **Mod の型移行**: hooks/board/types.ts は生成型の type re-export と PendingOp のみにする。HTTP の本体組み立てにも生成リクエスト型を適用する。既存の JSON fixture が Rust で読めること、生成型で既存 Mod が型チェックできることを確認。
3. **状態サービスと保存**: CRUD / progress / policies / focus / validation / 保存 / revision 通知を実装。省略・null・不正更新・重複 ID・再起動後の読込を検証。
4. **Unix socket HTTP**: 既存エンドポイントと PATCH /board をサービスに接続。Mod の本物の HTTP 経路で読み書き・再送・キャッシュ無効化を確認。run 実装前は成功扱いのスタブにしない。
5. **実行監督**: Run と冪等な受付、プロセス監督、終了処理、再起動回復を実装。テスト用プロセスで成功・失敗・同じ要求の再送を確認。
6. **セッション帰属と計測**: SessionBinding を Mod と同時導入。TurnRecord 保存、OTLP、価格・集計の順に実装。二つのセッションが別カードへ帰属することを検証。
7. **GUI**: 生成型と共通サービスを使い、カード・assignment・policy 編集、実行履歴、集計表示を実装。

最初の実装単位は 1〜2。HTTP / executor / GUI を始める前に、Rust からの生成だけで現在の Mod が型チェックできる状態を作る。

CI では一時ディレクトリへ再生成してチェックイン済み生成物と比較する。Rust の serde fixture、GUI と Mod の型チェック、既存 Mod テストを必要な範囲で実行する。生成差分がなければ最新と判定する。

## 参照

- 元計画: `IMPLEMENTATION-PLAN.md`
- 現行契約: `hooks/board/types.ts`
- 現行送信処理: `hooks/register.ts`
- 既存の生成入口: `../src-tauri/src/lib.rs` の `tests::export_bindings`
- Specta 公式: https://github.com/specta-rs/specta
- Specta の版による serde / export API 変更: https://github.com/specta-rs/specta/releases
