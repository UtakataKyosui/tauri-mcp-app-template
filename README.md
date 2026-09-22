# Tauri + React + Typescript

## Kanban integration

The Tauri process owns the board state in `$HOME/.local/share/sample-tauri-app/board.json`.
When the app starts, it exposes two local interfaces to that state:

- Claude Code uses `example-mcp-mod-plugin` over `$HOME/.local/share/sample-tauri-app/board.sock` (HTTP over Unix socket).
- Codex and other MCP clients use Streamable HTTP at `http://127.0.0.1:8765/mcp`. Configure this URL in the client's MCP server settings, then use the `board`, `card`, `create_card`, `update_card`, `move_card`, `progress`, and `set_focus` tools.

The MCP listener binds only to `127.0.0.1` and validates HTTP origins. The application must be running for either interface to respond. Rust defines the shared board types in `src-tauri/src/board.rs`; `cargo test export_bindings` in `src-tauri` regenerates `src/generated/board.ts` and the Mod's `hooks/board/generated.ts`.

The current server supports card CRUD, progress, correlations, and Mod turn records. Codex automatic dispatch (`POST /cards/:id/runs`), OTLP collection, pricing, and the board GUI are later phases in `docs/IMPLEMENTATION-PLAN.md`. Until automatic dispatch is implemented, Codex works on cards through the MCP tools directly.

This template should help get you started developing with Tauri, React and Typescript in Vite.

## Recommended IDE Setup

- [VS Code](https://code.visualstudio.com/) + [Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode) + [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer)

## Use-Packages Docs-Site Memo

### フロントエンド

| 分野 | 名前 | 選定理由 | URL | 
| --- | --- | --- | --- |
| ルーティング | TanStack Router | 扱いやすいルーティングライブラリ | https://tanstack.com/router/latest/docs/overview | 
| ビルドツール | Rsbuild | Viteよりビルドが早い | https://rsbuild.rs/ | 
| コード整形ツール | Biome | Linter + Formatterが統合されている | https://biomejs.dev/ | 
| CSSライブラリ | Tailwind CSS | ユーティリティクラスでのCSS宣言 | https://tailwindcss.com/ | 
| UIコンポーネント | shadcn/ui | Tailwind CSS + Base UIで構築されるUIコンポーネント集 | https://ui.shadcn.com/ | 

### ネイティブのロジック

| 分野 | 名前 | 選定理由 | URL | 
| --- | --- | --- | --- |
| ネイティブアプリのフレームワーク | Tauri | フロントエンドの技術で画面を作って、Rustでロジックを開発する | https://v2.tauri.app/ | 
| 
| Rustの型をエクスポートするクレート | specta | | https://specta.dev/docs/specta | 
| TauriのコマンドをTypeScriptに公開する | tauri-specta | | https://specta.dev/docs/tauri-specta | 