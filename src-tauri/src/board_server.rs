use crate::board::{
    AddProgress, BoardStore, Correlation, CreateCard, PatchBoard, PatchCard, Status, StoreError,
    TurnRecord,
};
use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::IntoResponse,
    routing::get,
    Json, Router,
};
use rmcp::{handler::server::wrapper::Parameters, schemars, tool, tool_router, ErrorData};
use serde::Deserialize;
use std::{io, net::SocketAddr, path::PathBuf, sync::Arc};

fn http_error(error: StoreError) -> (StatusCode, String) {
    match error {
        StoreError::NotFound => (StatusCode::NOT_FOUND, "card not found".into()),
        StoreError::Conflict => (StatusCode::CONFLICT, "card already exists".into()),
        StoreError::Invalid(message) => (StatusCode::BAD_REQUEST, message),
        StoreError::Io(error) => (StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
    }
}

async fn get_board(State(store): State<BoardStore>) -> impl IntoResponse {
    Json(store.board())
}
async fn patch_board(
    State(store): State<BoardStore>,
    Json(body): Json<PatchBoard>,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    store.patch_board(body).map(Json).map_err(http_error)
}
async fn get_card(
    State(store): State<BoardStore>,
    Path(id): Path<String>,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    store.card(&id).map(Json).map_err(http_error)
}
async fn create_card(
    State(store): State<BoardStore>,
    Json(body): Json<CreateCard>,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    store
        .create(body)
        .map(|card| (StatusCode::CREATED, Json(card)))
        .map_err(http_error)
}
async fn patch_card(
    State(store): State<BoardStore>,
    Path(id): Path<String>,
    Json(body): Json<PatchCard>,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    store.patch(&id, body).map(Json).map_err(http_error)
}
async fn delete_card(
    State(store): State<BoardStore>,
    Path(id): Path<String>,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    store
        .delete(&id)
        .map(|()| StatusCode::NO_CONTENT)
        .map_err(http_error)
}
async fn add_progress(
    State(store): State<BoardStore>,
    Path(id): Path<String>,
    Json(body): Json<AddProgress>,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    store.progress(&id, body).map(Json).map_err(http_error)
}
async fn add_correlation(
    State(store): State<BoardStore>,
    Json(body): Json<Correlation>,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    store
        .correlate(body)
        .map(|()| StatusCode::NO_CONTENT)
        .map_err(http_error)
}

async fn add_telemetry(
    State(store): State<BoardStore>,
    Json(body): Json<TurnRecord>,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    store
        .record_turn(body)
        .map(|()| StatusCode::NO_CONTENT)
        .map_err(http_error)
}
async fn add_card_telemetry(
    State(store): State<BoardStore>,
    Path(id): Path<String>,
    Json(mut body): Json<TurnRecord>,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    store.card(&id).map_err(http_error)?;
    body.card_id = Some(id);
    store
        .record_turn(body)
        .map(|()| StatusCode::NO_CONTENT)
        .map_err(http_error)
}

pub fn mod_router(store: BoardStore) -> Router {
    Router::new()
        .route("/board", get(get_board).patch(patch_board))
        .route("/cards", axum::routing::post(create_card))
        .route(
            "/cards/{id}",
            get(get_card).patch(patch_card).delete(delete_card),
        )
        .route("/cards/{id}/progress", axum::routing::post(add_progress))
        .route("/correlations", axum::routing::post(add_correlation))
        .route("/telemetry", axum::routing::post(add_telemetry))
        .route(
            "/cards/{id}/telemetry",
            axum::routing::post(add_card_telemetry),
        )
        .with_state(store)
}

#[derive(Clone)]
pub struct McpBoard {
    store: BoardStore,
}

#[derive(Deserialize, schemars::JsonSchema)]
struct CardId {
    id: String,
}
#[derive(Deserialize, schemars::JsonSchema)]
struct MoveCard {
    id: String,
    status: String,
}
#[derive(Deserialize, schemars::JsonSchema)]
struct Progress {
    id: String,
    note: String,
    summary: Option<String>,
}
#[derive(Deserialize, schemars::JsonSchema)]
struct SetFocus {
    id: Option<String>,
}
#[derive(Deserialize, schemars::JsonSchema)]
struct UpdateCard {
    id: String,
    #[serde(flatten)]
    patch: PatchCard,
}

fn mcp_error(error: StoreError) -> ErrorData {
    match error {
        StoreError::NotFound => ErrorData::invalid_params("card not found", None),
        StoreError::Conflict => ErrorData::invalid_params("card already exists", None),
        StoreError::Invalid(message) => ErrorData::invalid_params(message, None),
        StoreError::Io(error) => ErrorData::internal_error(error.to_string(), None),
    }
}

#[tool_router(server_handler)]
impl McpBoard {
    #[tool(description = "List all kanban cards and current focus")]
    fn board(&self) -> String {
        serde_json::to_string_pretty(&self.store.board()).expect("Board serializes")
    }

    #[tool(description = "Set or clear the board's active card focus")]
    fn set_focus(
        &self,
        Parameters(SetFocus { id }): Parameters<SetFocus>,
    ) -> Result<String, ErrorData> {
        self.store
            .patch_board(PatchBoard {
                focus: Some(id),
                policies: None,
            })
            .map(|board| serde_json::to_string_pretty(&board).expect("Board serializes"))
            .map_err(mcp_error)
    }

    #[tool(description = "Create a kanban card")]
    fn create_card(&self, Parameters(input): Parameters<CreateCard>) -> Result<String, ErrorData> {
        self.store
            .create(input)
            .map(|card| serde_json::to_string_pretty(&card).expect("Card serializes"))
            .map_err(mcp_error)
    }

    #[tool(description = "Read a kanban card by id")]
    fn card(&self, Parameters(CardId { id }): Parameters<CardId>) -> Result<String, ErrorData> {
        self.store
            .card(&id)
            .map(|card| serde_json::to_string_pretty(&card).expect("Card serializes"))
            .map_err(mcp_error)
    }

    #[tool(
        description = "Update a card's title, objective, requirements, status, phase, assignment or summary"
    )]
    fn update_card(
        &self,
        Parameters(UpdateCard { id, patch }): Parameters<UpdateCard>,
    ) -> Result<String, ErrorData> {
        self.store
            .patch(&id, patch)
            .map(|card| serde_json::to_string_pretty(&card).expect("Card serializes"))
            .map_err(mcp_error)
    }

    #[tool(description = "Move a card to backlog, ready, doing, review, done or blocked")]
    fn move_card(
        &self,
        Parameters(MoveCard { id, status }): Parameters<MoveCard>,
    ) -> Result<String, ErrorData> {
        let status = serde_json::from_value::<Status>(serde_json::Value::String(status))
            .map_err(|error| ErrorData::invalid_params(error.to_string(), None))?;
        let patch = PatchCard {
            status: Some(status),
            ..PatchCard::default()
        };
        self.store
            .patch(&id, patch)
            .map(|card| serde_json::to_string_pretty(&card).expect("Card serializes"))
            .map_err(mcp_error)
    }

    #[tool(description = "Append a progress entry to a card")]
    fn progress(
        &self,
        Parameters(Progress { id, note, summary }): Parameters<Progress>,
    ) -> Result<String, ErrorData> {
        let entry = crate::board::ProgressEntry {
            at: time::OffsetDateTime::now_utc()
                .format(&time::format_description::well_known::Rfc3339)
                .unwrap(),
            by: "mcp".into(),
            note,
        };
        self.store
            .progress(&id, AddProgress { entry, summary })
            .map(|card| serde_json::to_string_pretty(&card).expect("Card serializes"))
            .map_err(mcp_error)
    }
}

pub async fn start(store: BoardStore, socket: PathBuf, mcp_address: SocketAddr) -> io::Result<()> {
    let mcp_store = store.clone();
    let mcp_service = rmcp::transport::StreamableHttpService::new(
        move || {
            Ok(McpBoard {
                store: mcp_store.clone(),
            })
        },
        Arc::new(
            rmcp::transport::streamable_http_server::session::local::LocalSessionManager::default(),
        ),
        rmcp::transport::StreamableHttpServerConfig::default().enforce_origin_validation(),
    );
    let mcp_listener = tokio::net::TcpListener::bind(mcp_address).await?;
    tauri::async_runtime::spawn(async move {
        if let Err(error) = axum::serve(
            mcp_listener,
            Router::new().nest_service("/mcp", mcp_service),
        )
        .await
        {
            eprintln!("MCP server stopped: {error}");
        }
    });
    #[cfg(unix)]
    {
        if let Some(parent) = socket.parent() {
            std::fs::create_dir_all(parent)?;
        }
        if socket.exists() {
            if std::os::unix::net::UnixStream::connect(&socket).is_ok() {
                return Err(io::Error::new(
                    io::ErrorKind::AddrInUse,
                    "board socket is already in use",
                ));
            }
            std::fs::remove_file(&socket)?;
        }
        let listener = tokio::net::UnixListener::bind(&socket)?;
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&socket, std::fs::Permissions::from_mode(0o600))?;
        tauri::async_runtime::spawn(async move {
            if let Err(error) = axum::serve(listener, mod_router(store)).await {
                eprintln!("Mod socket server stopped: {error}");
            }
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::{Read, Write},
        time::Duration,
    };

    #[tokio::test]
    async fn mod_and_mcp_share_board() {
        let directory =
            std::env::temp_dir().join(format!("kanban-server-test-{}", std::process::id()));
        let store = BoardStore::open(directory.join("board.json")).unwrap();
        store
            .create(CreateCard {
                id: "demo".into(),
                title: "Demo".into(),
                objective: "Test sharing".into(),
                requirements: vec![],
                status: Status::Ready,
                phase: None,
                assignment: crate::board::Assignment {
                    runtime: crate::board::Runtime::Codex,
                    model: "test-model".into(),
                    effort: crate::board::Effort::Named("low".into()),
                    role: None,
                },
                summary: String::new(),
            })
            .unwrap();
        store
            .patch_board(PatchBoard {
                focus: Some(Some("demo".into())),
                policies: None,
            })
            .unwrap();
        let socket = directory.join("board.sock");
        let free = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = free.local_addr().unwrap().port();
        drop(free);
        start(store.clone(), socket.clone(), ([127, 0, 0, 1], port).into())
            .await
            .unwrap();

        let board_request = b"GET /board HTTP/1.1\r\nHost: kanban\r\nConnection: close\r\n\r\n";
        let response = tokio::task::spawn_blocking(move || {
            let mut client = std::os::unix::net::UnixStream::connect(socket).unwrap();
            client
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            client.write_all(board_request).unwrap();
            let mut body = String::new();
            client.read_to_string(&mut body).unwrap();
            body
        })
        .await
        .unwrap();
        assert!(response.contains("200 OK"), "{response}");
        assert!(
            response.contains(r#""id":"demo""#) && response.contains(r#""focus":"demo""#),
            "{response}"
        );
        let socket = directory.join("board.sock");
        let payload =
            r#"{"entry":{"at":"2026-09-22T00:00:00Z","by":"claude","note":"Mod wrote this"}}"#;
        let request = format!("POST /cards/demo/progress HTTP/1.1\r\nHost: kanban\r\nContent-Type: application/json\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{payload}", payload.len());
        let response = tokio::task::spawn_blocking(move || {
            let mut client = std::os::unix::net::UnixStream::connect(socket).unwrap();
            client
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            client.write_all(request.as_bytes()).unwrap();
            let mut body = String::new();
            client.read_to_string(&mut body).unwrap();
            body
        })
        .await
        .unwrap();
        assert!(response.contains("200 OK"), "{response}");
        assert_eq!(store.card("demo").unwrap().entries.len(), 1);

        let payload = r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"test","version":"1"}}}"#;
        let request = format!("POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAccept: application/json, text/event-stream\r\nContent-Type: application/json\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{payload}", payload.len());
        let response = tokio::task::spawn_blocking(move || {
            let mut client = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
            client
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            client.write_all(request.as_bytes()).unwrap();
            let mut body = String::new();
            let _ = client.read_to_string(&mut body);
            body
        })
        .await
        .unwrap();
        assert!(response.contains("200 OK"), "{response}");
        assert!(response.contains("serverInfo"), "{response}");
        let session_id = response
            .lines()
            .find_map(|line| line.strip_prefix("mcp-session-id: "))
            .map(str::trim)
            .expect("MCP session header")
            .to_string();
        let payload = r#"{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}"#;
        let request = format!("POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nMcp-Session-Id: {session_id}\r\nMCP-Protocol-Version: 2025-11-25\r\nAccept: application/json, text/event-stream\r\nContent-Type: application/json\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{payload}", payload.len());
        let tools = tokio::task::spawn_blocking(move || {
            let mut client = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
            client
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            client.write_all(request.as_bytes()).unwrap();
            let mut body = String::new();
            let _ = client.read_to_string(&mut body);
            body
        })
        .await
        .unwrap();
        assert!(
            tools.contains("board") && tools.contains("create_card"),
            "{tools}"
        );
        let payload = r#"{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"board","arguments":{}}}"#;
        let request = format!("POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nMcp-Session-Id: {session_id}\r\nMCP-Protocol-Version: 2025-11-25\r\nAccept: application/json, text/event-stream\r\nContent-Type: application/json\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{payload}", payload.len());
        let call = tokio::task::spawn_blocking(move || {
            let mut client = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
            client
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            client.write_all(request.as_bytes()).unwrap();
            let mut body = String::new();
            let _ = client.read_to_string(&mut body);
            body
        })
        .await
        .unwrap();
        assert!(
            call.contains("demo") && call.contains("Mod wrote this") && call.contains("result"),
            "{call}"
        );
    }
}
