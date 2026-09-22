# 既存の看板連携を Vibe Kanban Fork に移植する

## 目的と前提

この Fork の Tauri アプリを基盤とし、`tauri-mcp-app-template` で実装済みの「カードを中心にした Claude Code Mod 連携」と「同じ状態への MCP 操作」を統合する。Vibe Kanban には Tauri アプリ、Claude/Codex 実行器、MCP サーバーのコードがある。ただし現行の `ProjectKanban` は終了案内を表示し、issue CRUD はリモートクライアントへ委譲するため、ローカル看板の復旧が先行する。

移植元: [実装計画](https://github.com/UtakataKyosui/tauri-mcp-app-template/blob/b2f65963752c86761c32aa71b27f089d7dca2c18/docs/IMPLEMENTATION-PLAN.md)、[データモデル計画](https://github.com/UtakataKyosui/tauri-mcp-app-template/blob/b2f65963752c86761c32aa71b27f089d7dca2c18/docs/DATA-MODEL-PLAN.md)、[Mod](https://github.com/UtakataKyosui/tauri-mcp-app-template/tree/b2f65963752c86761c32aa71b27f089d7dca2c18/example-mcp-mod-plugin)、[現行 Rust 実装](https://github.com/UtakataKyosui/tauri-mcp-app-template/blob/b2f65963752c86761c32aa71b27f089d7dca2c18/src-tauri/src/board.rs)。以下の「未実装」は移植元でも計画段階であり、完成機能として扱わない。

## 差分と移植方針

| 項目 | 移植元の状態 | Fork での方針 |
| --- | --- | --- |
| カード契約: `objective`、`requirements`、`phase`、`assignment`、`summary`、`progress`、`focus`、`policies` | Rust の保存・HTTP・MCP 基本操作を実装済み | 復旧するローカル issue/card を正本にし、Vibe Kanban の remote issue/task とは adapter で対応付ける。不足する属性のみ追加 |
| Claude Code Mod: `prompt.context`/`prompt.submit`、`agent.spawn`、SubAgent の `implement`/`review`/`refute` | Mod とテストを実装済み | Mod を配布可能な形で移し、Vibe Kanban の現在の task/attempt と連携。既存 Claude executor との重複起動を避ける |
| phase 別 Skill/SubAgent 制御 | Mod の `agent.offer`、`prompt.attachment`、`tool.call`、`skill.prompt` に実装済み | task の phase/policy を Mod が読める API を追加し、表示・実行両経路を検証 |
| Codex 等の外部 MCP クライアントからの看板操作 | loopback Streamable HTTP MCP にカード基本操作を実装済み | 既存 `crates/mcp` のツールと到達方法を比較し、不足するカード操作・assignment・policy 操作を追加。別の MCP 状態を持たない |
| Mod のローカル接続と停止時の outbox | Unix socket HTTP、`board.revision` 通知、Mod outbox を実装済み | 既存サーバーの操作へアダプターを設ける。再送の冪等性と Mod の復旧を確認 |
| ターン・ツール・Skill・SubAgent のカード単位記録 | Mod の収集と Rust の `TurnRecord`/`Correlation` 保存を実装済み | task/attempt/session ID に結び付けて保存・表示。既存ログや usage と重複計上しない |
| session binding、Codex 実行監督、OTLP 受信、単価表・コスト集計、集計 GUI | 移植元でも計画段階 | 既存の Vibe Kanban の実行監督・usage 表示を先に調査し、本当に不足する部分だけ後続 Issue に切り出す |

## 実装順

1. **適合調査**: Vibe Kanban の旧 task、remote issue、attempt/session、MCP ツール、Claude/Codex executor、usage、Tauri の起動経路を確認し、移植元の Card/Board/TurnRecord との対応表を作る。ローカル正本に採用するモデルを決める。
2. **ローカル看板の復旧**: 現行の終了案内と remote client 依存を解消し、Tauri でネットワークなしにカードを作成・表示・編集できる状態を作る。
3. **共通のタスク契約**: カードの目的・要件・担当 runtime/model/effort/role・phase・summary・進捗・policy を復旧したローカル正本に統合する。HTTP、MCP、UI が同じ保存サービスを使う。
4. **Mod 接続**: 移植元 Mod の hook、tool、SubAgent、outbox を Fork に入れる。Mod のカード ID をローカル正本の ID に対応させる。ポリシー更新時のキャッシュ無効化と停止・再起動時の復旧を検証する。
5. **MCP 操作**: 既存 `crates/mcp` を拡張し、外部 Codex 等からカードの取得、進捗記録、状態変更、focus/assignment/policy 操作を提供する。Mod と MCP から同じカードを更新する統合テストを追加する。
6. **帰属と計測**: session/attempt とカードの明示的 binding を導入する。複数の `doing` カードがある場合に先頭へ暗黙帰属させない。Mod のターン・トークン・ツール・Skill・SubAgent 記録を保存し、既存 usage と照合する。
7. **UI と仕上げ**: Tauri 看板で追加属性・policy・focus・進捗・計測を編集・閲覧できるようにする。macOS で Tauri 版を起動し、Claude Code Mod と外部 MCP クライアントの操作を一つのカードに反映させる。

## 完了条件

- 復旧したローカル issue/card が唯一の状態源で、Mod・MCP・Tauri UI の更新が互いに見える。remote issue/task は同期・表示用の adapter として扱う。
- カードの assignment と phase policy が Claude Code Mod のプロンプト、SubAgent、Skill に反映される。
- 別々の二つのセッションを別 task に明示的に結び付け、進捗と計測が混ざらない。
- 停止中の Mod 書き込みは復旧後に一度だけ適用される。再送で進捗が重複しない。
- 既存の Vibe Kanban の task 作成、Claude/Codex 実行、MCP 操作、Tauri 起動を回帰確認する。

## 現在の Fork 実装状況

- `UtakataKyosui/vibe-kanban` にローカル `project_statuses` / `issues` 保存層、`/api/local` CRUD、Tauriローカル看板画面を追加。
- カード契約の主要属性（objective、requirements、phase、assignment、summary、progress、focus、policies）を保存・検証可能にした。
- 外部MCPからローカルカードを一覧・作成・更新する3ツールを追加。
- `cargo check -p db --lib`、`cargo check -p server --lib`、`cargo check -p mcp --lib`、`cargo test -p db --lib`を確認済み。Fork環境のpnpm未導入のためWeb型チェックは未確認。
- Claude Code Modのsocket/outbox実装とsession計測は未移植。競合安全性（#8）も後続作業。

この Issue は全体の追跡用。適合調査後、実装順 2〜6 を小さな Issue に分割し、それぞれに具体的な API/DB/UI 変更と検証方法を記す。

## 実装タスク

1. #2 適合調査と統合点の確定（先行）
2. #7 ローカル看板の復旧（#2 の後）
3. #3 カード契約と phase policy の統合（#7 の後）
4. #4 Claude Code Mod の接続（#3 の後）
5. #5 外部 MCP のローカルカード操作（#3 の後、#4 と並行可能）
6. #6 セッション帰属、計測、Tauri UI（#3・#4 の後）
