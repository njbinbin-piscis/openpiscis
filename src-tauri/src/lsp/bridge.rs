//! WebSocket ↔ LSP stdio bridge.
//!
//! Spawned per LSP session. Accepts exactly one WebSocket connection on a TCP
//! port and bidirectionally relays messages between the WS client (Monaco
//! Editor) and the LSP server process (stdin/stdout).

use std::net::SocketAddr;
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpListener;
use tokio::process::{ChildStderr, ChildStdin, ChildStdout};
use tokio::sync::Mutex;
use tokio_tungstenite::tungstenite;
use tracing::{info, warn};

/// Canned `InitializeResult` returned to the first `initialize` request so
/// the language client can proceed without connecting to the real LSP server.
const INIT_RESPONSE: &str = "{\"jsonrpc\":\"2.0\",\"id\":0,\"result\":{\"capabilities\":{\"textDocumentSync\":2,\"hoverProvider\":true,\"completionProvider\":{\"triggerCharacters\":[\".\",\":\",\"/\",\"#\",\"\\\"\",\"'\",\"(\"]},\"definitionProvider\":true,\"referencesProvider\":true,\"documentHighlightProvider\":true,\"documentSymbolProvider\":true,\"workspaceSymbolProvider\":true,\"codeActionProvider\":true,\"renameProvider\":{\"prepareProvider\":true},\"documentFormattingProvider\":true,\"signatureHelpProvider\":{\"triggerCharacters\":[\"(\",\",\"]},\"inlayHintProvider\":true,\"foldingRangeProvider\":true,\"selectionRangeProvider\":true,\"diagnosticProvider\":{\"interFileDependencies\":false,\"workspaceDiagnostics\":false}}},\"serverInfo\":{\"name\":\"OpenPiscis LSP Bridge\",\"version\":\"0.1.0\"}}";

/// Run the LSP ↔ WebSocket bridge.
///
/// Takes ownership of the LSP process I/O handles.
/// - Binds to `127.0.0.1:{port}`
/// - Accepts one WebSocket connection
/// - Relays messages bidirectionally until either side disconnects
/// - Intercepts the first `initialize` message to reply with a canned
///   `InitializeResult`, then forwards all subsequent messages transparently.
///
/// Returns when the bridge shuts down (client disconnected or process died).
pub async fn run_lsp_bridge(
    port: u16,
    lsp_stdin: ChildStdin,
    lsp_stdout: ChildStdout,
    lsp_stderr: Option<ChildStderr>,
    language: &str,
    project_dir: &str,
) -> Result<(), String> {
    let addr: SocketAddr = ([127, 0, 0, 1], port).into();
    let listener = TcpListener::bind(addr)
        .await
        .map_err(|e| format!("LSP bridge: bind port {} failed: {}", port, e))?;

    info!(
        "LSP bridge listening on ws://{} for language={} project={}",
        addr, language, project_dir
    );

    // Accept one connection
    let (stream, peer) = listener
        .accept()
        .await
        .map_err(|e| format!("LSP bridge: accept failed: {}", e))?;

    info!(
        "LSP bridge: client connected from {} (lang={})",
        peer, language
    );

    // WebSocket handshake
    let ws_stream = tokio_tungstenite::accept_async(stream)
        .await
        .map_err(|e| format!("LSP bridge: WS handshake failed: {}", e))?;

    let (mut ws_sender, mut ws_receiver) = ws_stream.split();

    // Wrap stdin for shared async access
    let stdin = Arc::new(Mutex::new(lsp_stdin));

    // ── stdout reader task ──────────────────────────────────────────
    let (stdout_tx, mut stdout_rx) = tokio::sync::mpsc::channel::<String>(256);
    let stdout_task = tokio::spawn(async move {
        let mut reader = BufReader::new(lsp_stdout);
        let mut line = String::new();
        loop {
            line.clear();
            match reader.read_line(&mut line).await {
                Ok(0) => {
                    info!("LSP stdout: EOF");
                    break;
                }
                Ok(_) => {
                    let trimmed = line.trim_end().to_string();
                    if !trimmed.is_empty() && stdout_tx.send(trimmed).await.is_err() {
                        break;
                    }
                }
                Err(e) => {
                    warn!("LSP stdout read error: {}", e);
                    break;
                }
            }
        }
    });

    // ── stderr reader task ──────────────────────────────────────────
    let (stderr_tx, mut stderr_rx) = tokio::sync::mpsc::channel::<String>(256);
    let stderr_task = lsp_stderr.map(|stderr| {
        tokio::spawn(async move {
            let mut reader = BufReader::new(stderr);
            let mut line = String::new();
            loop {
                line.clear();
                match reader.read_line(&mut line).await {
                    Ok(0) => break,
                    Ok(_) => {
                        let trimmed = line.trim_end().to_string();
                        if !trimmed.is_empty() && stderr_tx.send(trimmed).await.is_err() {
                            break;
                        }
                    }
                    Err(_) => break,
                }
            }
        })
    });

    // ── main relay loop ─────────────────────────────────────────────
    use futures::{SinkExt, StreamExt};

    let mut first_message = true;
    let result: Result<(), String> = loop {
        tokio::select! {
            // WS client → LSP stdin
            msg = ws_receiver.next() => {
                match msg {
                    Some(Ok(tungstenite::Message::Text(text))) => {
                        if first_message {
                            first_message = false;
                            info!("LSP bridge: got first WS message (len={})", text.len());
                            // If it's an initialize request, reply with canned response
                            if text.contains("\"initialize\"") {
                                info!("LSP bridge: intercepting initialize, replying with canned capabilities");
                                if ws_sender.send(tungstenite::Message::Text(
                                    INIT_RESPONSE.to_string()
                                )).await.is_err() {
                                    break Err("WS send error after init".into());
                                }
                                continue;
                            }
                        }

                        // Forward to LSP stdin (LSP uses Content-Length framing)
                        let content_len = text.len();
                        let header = format!("Content-Length: {}\r\n\r\n", content_len);
                        {
                            let mut stdin_guard = stdin.lock().await;
                            if stdin_guard.write_all(header.as_bytes()).await.is_err() {
                                break Err("LSP stdin write (header) failed".into());
                            }
                            if stdin_guard.write_all(text.as_bytes()).await.is_err() {
                                break Err("LSP stdin write (body) failed".into());
                            }
                            if stdin_guard.flush().await.is_err() {
                                break Err("LSP stdin flush failed".into());
                            }
                        }
                    }
                    Some(Ok(tungstenite::Message::Close(_))) => {
                        info!("LSP bridge: WS client closed");
                        break Ok(());
                    }
                    Some(Err(e)) => {
                        warn!("LSP bridge: WS recv error: {}", e);
                        break Ok(());
                    }
                    None => break Ok(()),
                    _ => {} // Ignore binary/ping/pong
                }
            }

            // LSP stdout → WS client
            msg = stdout_rx.recv() => {
                match msg {
                    Some(text) => {
                        // LSP stdout may have Content-Length framing; strip header if present
                        let body = strip_lsp_header(&text);
                        if ws_sender.send(tungstenite::Message::Text(body.to_string())).await.is_err() {
                            break Err("WS send error".into());
                        }
                    }
                    None => {
                        info!("LSP bridge: stdout channel closed");
                        break Ok(());
                    }
                }
            }

            // LSP stderr → WS client (as window/logMessage)
            msg = stderr_rx.recv() => {
                match msg {
                    Some(text) => {
                        // Send stderr as a window/logMessage notification
                        let escaped = text.replace('\\', "\\\\").replace('"', "\\\"");
                        let log_msg = format!(
                            r#"{{"jsonrpc":"2.0","method":"window/logMessage","params":{{"type":4,"message":"{}"}}}}"#,
                            escaped
                        );
                        let _ = ws_sender.send(tungstenite::Message::Text(log_msg)).await;
                    }
                    None => break Ok(()),
                }
            }
        }
    };

    // Cleanup
    stdout_task.abort();
    if let Some(t) = stderr_task {
        t.abort();
    }

    info!("LSP bridge for {} shut down", language);
    result
}

/// Strip Content-Length header from an LSP message, returning just the JSON body.
///
/// Input may look like:
/// ```text
/// Content-Length: 1234
/// { ... JSON ... }
/// ```
fn strip_lsp_header(raw: &str) -> &str {
    if let Some(idx) = raw.find("\r\n\r\n") {
        let body = &raw[idx + 4..];
        if body.starts_with('{') {
            return body;
        }
    }
    if let Some(idx) = raw.find("\n\n") {
        let body = &raw[idx + 2..];
        if body.starts_with('{') {
            return body;
        }
    }
    // No header found, return as-is
    raw
}
