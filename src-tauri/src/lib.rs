mod board;
mod board_server;
mod theme;

use tauri::Manager;
use tauri_specta::{collect_commands, Builder};
use theme::ThemeState;

// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
fn specta_builder() -> Builder<tauri::Wry> {
    Builder::<tauri::Wry>::new().commands(collect_commands![theme::set_theme, theme::get_theme,])
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // bindings.ts の生成は `cargo test` (tests::export_bindings) が担う。
    // ここで生成すると同一ファイルへの書き込みが二重になる。
    let builder = specta_builder();

    tauri::Builder::default()
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(builder.invoke_handler())
        .setup(move |app| {
            let home = std::env::var_os("HOME")
                .map(std::path::PathBuf::from)
                .unwrap_or(app.path().app_data_dir()?);
            let data_dir = home.join(".local/share/sample-tauri-app");
            let store = board::BoardStore::open(data_dir.join("board.json"))?;
            let address = "127.0.0.1:8765".parse().expect("valid MCP address");
            tauri::async_runtime::block_on(board_server::start(
                store,
                data_dir.join("board.sock"),
                address,
            ))?;
            let setting = theme::load_theme(app.handle());
            app.manage(ThemeState::new(setting));

            // ウィンドウを tauri.conf.json ではなくここで生成する。
            // 設定の読み込み後に作ることで、最初の描画からテーマが確定する。
            tauri::WebviewWindowBuilder::new(app, "main", tauri::WebviewUrl::default())
                .title("sample-tauri-app")
                .inner_size(800.0, 600.0)
                .theme(setting.to_window_theme())
                .initialization_script(theme::initialization_script(setting))
                .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;
    use specta::{Language, NamedType, TypeMap};
    use specta_typescript::Typescript;

    /// アプリを起動せずに bindings を生成する。`cargo test` が生成の入口になる。
    #[test]
    fn export_bindings() {
        let mut types = TypeMap::default();
        macro_rules! register {
            ($type:ty) => {{
                let definition = <$type as NamedType>::definition_named_data_type(&mut types);
                types.insert(<$type as NamedType>::sid(), definition);
            }};
        }
        register!(board::Board);
        register!(board::CreateCard);
        register!(board::PatchCard);
        register!(board::PatchBoard);
        register!(board::AddProgress);
        register!(board::Correlation);
        register!(board::TurnRecord);
        let generated = Typescript::default()
            .export(types)
            .expect("board types export");
        let generated = format!("{}\n", generated.trim_end());
        std::fs::create_dir_all("../src/generated").expect("create generated directory");
        std::fs::write("../src/generated/board.ts", &generated).expect("write GUI types");
        std::fs::write(
            "../example-mcp-mod-plugin/hooks/board/generated.ts",
            &generated,
        )
        .expect("write Mod types");
        // tauri-specta は event / channel 用の定型コードを常に出力するため、
        // それらを使わない構成では noUnusedLocals に引っかかる。生成物は
        // 手で直せないのでヘッダーで型チェックから外す。
        specta_builder()
            .export(
                Typescript::default().header("// @ts-nocheck"),
                "../src/bindings.ts",
            )
            .expect("failed to export typescript bindings");
    }
}
