//! LSP tool for agents — access Language Server Protocol features
//! (diagnostics, hover, completions, go-to-definition, references, rename)
//! from within an agent conversation.
//!
//! Connects to the LSP WebSocket bridge managed by [`crate::lsp::manager::LspManager`]
//! and issues JSON-RPC requests on the agent's behalf.

use async_trait::async_trait;
use piscis_kernel::agent::tool::{Tool, ToolContext, ToolResult};
use serde_json::{json, Value};
use std::sync::Arc;
use tokio_tungstenite::tungstenite::Message;
use tracing::{info, warn};

use crate::lsp::manager::LspManager;

pub struct LspTool {
    pub lsp_manager: Arc<LspManager>,
}

#[async_trait]
impl Tool for LspTool {
    fn name(&self) -> &str {
        "lsp"
    }

    fn description(&self) -> &str {
        "Access Language Server Protocol features for code understanding. \
         Actions:\n\
         - 'diagnostics': Get compiler errors/warnings for a file. \
         Returns a list of diagnostics (line, column, severity, message).\n\
         - 'hover': Get type information and documentation for the symbol at \
         a given line:column position.\n\
         - 'complete': Get code completions at a given position. \
         Useful for discovering available methods, fields, or APIs.\n\
         - 'definition': Get the location where the symbol at the given \
         position is defined (go-to-definition).\n\
         - 'references': Find all references to the symbol at the given position.\n\
         - 'rename': Rename a symbol across the project. \
         Requires 'new_name' parameter.\n\
         \n\
         Each request requires: file (absolute path), line, character (0-based column). \
         For best results, use the language that matches the file extension \
         (e.g., 'rust' for .rs, 'typescript' for .ts, 'python' for .py, 'cpp' for .c/.cpp). \
         The 'definition' and 'references' actions help you navigate and understand \
         code structure without manual grep/search."
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "action": {
                    "type": "string",
                    "enum": ["diagnostics", "hover", "complete", "definition", "references", "rename"],
                    "description": "LSP action to perform."
                },
                "file": {
                    "type": "string",
                    "description": "Absolute path to the source file."
                },
                "line": {
                    "type": "integer",
                    "description": "1-based line number."
                },
                "character": {
                    "type": "integer",
                    "description": "0-based character (column) offset on the line."
                },
                "new_name": {
                    "type": "string",
                    "description": "New name for rename action. Required only for 'rename'."
                }
            },
            "required": ["action", "file", "line", "character"]
        })
    }

    fn is_read_only(&self) -> bool {
        true
    }

    async fn call(&self, input: Value, _ctx: &ToolContext) -> anyhow::Result<ToolResult> {
        let action = input["action"]
            .as_str()
            .unwrap_or("diagnostics")
            .to_string();
        let file = input["file"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("'file' parameter is required"))?
            .to_string();
        let line = input["line"].as_u64().unwrap_or(1) as usize;
        let character = input["character"].as_u64().unwrap_or(0) as usize;

        // Detect language from file extension
        let project_root = detect_project_root(&file);
        let language = match LspManager::language_for_file(&file) {
            Some(l) => l,
            None => {
                return Ok(ToolResult::err(format!(
                    "No LSP server available for file: {}. Supported languages: rust, typescript, python, c/c++",
                    file
                )));
            }
        };

        // Start LSP if needed and get port
        let port = match self.lsp_manager.start(&project_root, &language).await {
            Ok(p) => p,
            Err(e) => {
                return Ok(ToolResult::err(format!(
                    "Failed to start LSP server for {}: {}",
                    language, e
                )));
            }
        };

        // Connect via WebSocket
        let result =
            match lsp_request(port, &file, &language, &action, line, character, &input).await {
                Ok(text) => ToolResult::ok(text),
                Err(e) => ToolResult::err(e),
            };

        Ok(result)
    }
}

/// Detect project root from a file path by looking for common markers.
fn detect_project_root(file: &str) -> String {
    let path = std::path::Path::new(file);
    let mut current = if path.is_dir() {
        path.to_path_buf()
    } else {
        path.parent()
            .map(|p| p.to_path_buf())
            .unwrap_or_else(|| std::path::PathBuf::from("."))
    };

    let markers = [
        "Cargo.toml",
        "package.json",
        "pyproject.toml",
        "setup.py",
        "CMakeLists.txt",
        "Makefile",
    ];

    loop {
        for marker in &markers {
            if current.join(marker).exists() {
                return current.to_string_lossy().to_string();
            }
        }
        if let Some(parent) = current.parent() {
            current = parent.to_path_buf();
        } else {
            break;
        }
    }

    // Fallback to the file's directory
    std::path::Path::new(file)
        .parent()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|| ".".to_string())
}

/// Connect to the LSP WebSocket bridge, issue a request, and return the response.
async fn lsp_request(
    port: u16,
    file: &str,
    language: &str,
    action: &str,
    line: usize,
    character: usize,
    full_input: &Value,
) -> Result<String, String> {
    use futures::{SinkExt, StreamExt};
    use tokio_tungstenite::connect_async;

    let url = format!("ws://127.0.0.1:{}", port);
    info!("LspTool: connecting to {}", url);

    let (mut ws, _) = connect_async(&url)
        .await
        .map_err(|e| format!("Failed to connect to LSP bridge on port {}: {}", port, e))?;

    // 1) Send initialize request
    let init_req = json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {
            "processId": null,
            "rootUri": format!("file://{}", detect_project_root(file)),
            "capabilities": {
                "textDocument": {
                    "hover": { "contentFormat": ["markdown", "plaintext"] },
                    "completion": { "completionItem": { "snippetSupport": true } },
                    "definition": { "linkSupport": true },
                    "references": {},
                    "rename": { "prepareSupport": true },
                    "publishDiagnostics": { "relatedInformation": true }
                }
            },
            "workspaceFolders": [{
                "uri": format!("file://{}", detect_project_root(file)),
                "name": "project"
            }]
        }
    });

    // LSP uses Content-Length framing
    let init_str = serde_json::to_string(&init_req).unwrap();
    let framed = format!("Content-Length: {}\r\n\r\n{}", init_str.len(), init_str);
    ws.send(Message::Text(framed))
        .await
        .map_err(|e| format!("WS send error: {}", e))?;

    // Read initialize response (skip canned response + real response)
    let mut got_init = false;
    while let Some(Ok(Message::Text(text))) = ws.next().await {
        if text.contains("\"initialize\"") || text.contains("\"id\":1") {
            got_init = true;
            break;
        }
    }
    if !got_init {
        return Err("LSP init: no response received".to_string());
    }

    // Send initialized notification
    let init_done = json!({
        "jsonrpc": "2.0",
        "method": "initialized",
        "params": {}
    });
    let init_done_str = serde_json::to_string(&init_done).unwrap();
    ws.send(Message::Text(format!(
        "Content-Length: {}\r\n\r\n{}",
        init_done_str.len(),
        init_done_str
    )))
    .await
    .map_err(|e| format!("WS send error: {}", e))?;

    // 2) Send didOpen notification (tell LSP about the file)
    let (content, _) = read_file_content(file)?;
    let lsp_lang = language_to_lsp_id(language);
    let did_open = json!({
        "jsonrpc": "2.0",
        "method": "textDocument/didOpen",
        "params": {
            "textDocument": {
                "uri": format!("file://{}", file),
                "languageId": lsp_lang,
                "version": 1,
                "text": content
            }
        }
    });
    let did_open_str = serde_json::to_string(&did_open).unwrap();
    ws.send(Message::Text(format!(
        "Content-Length: {}\r\n\r\n{}",
        did_open_str.len(),
        did_open_str
    )))
    .await
    .map_err(|e| format!("WS send error: {}", e))?;

    // Small delay to let LSP process didOpen and build index
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;

    // 3) Send the actual request based on action
    let request_id = 2u64;
    let lsp_request = build_lsp_request(
        request_id, action, file, line, character, full_input, lsp_lang,
    );
    let req_str = serde_json::to_string(&lsp_request).unwrap();
    ws.send(Message::Text(format!(
        "Content-Length: {}\r\n\r\n{}",
        req_str.len(),
        req_str
    )))
    .await
    .map_err(|e| format!("WS send error: {}", e))?;

    // 4) Read responses until we get our result
    let mut result_text = String::new();
    let mut diagnostics: Vec<Value> = Vec::new();
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(15);

    loop {
        if tokio::time::Instant::now() > deadline {
            if !result_text.is_empty() {
                break;
            }
            return Err("LSP request timed out".to_string());
        }

        match tokio::time::timeout(std::time::Duration::from_secs(2), ws.next()).await {
            Ok(Some(Ok(Message::Text(text)))) => {
                // Strip Content-Length header if present
                let body = if let Some(idx) = text.find("\r\n\r\n") {
                    text[idx + 4..].to_string()
                } else {
                    text
                };

                if let Ok(val) = serde_json::from_str::<Value>(&body) {
                    // Check if it's our response
                    if val.get("id").and_then(|i| i.as_u64()) == Some(request_id) {
                        if let Some(result) = val.get("result") {
                            result_text = format_lsp_result(action, result, &diagnostics);
                            break;
                        }
                        if let Some(error) = val.get("error") {
                            return Err(format!(
                                "LSP error: {}",
                                error
                                    .get("message")
                                    .and_then(|m| m.as_str())
                                    .unwrap_or("unknown error")
                            ));
                        }
                    }

                    // Collect diagnostics from publishDiagnostics notifications
                    if val.get("method").and_then(|m| m.as_str())
                        == Some("textDocument/publishDiagnostics")
                    {
                        if let Some(params) = val.get("params") {
                            if let Some(diags) =
                                params.get("diagnostics").and_then(|d| d.as_array())
                            {
                                diagnostics.extend(diags.iter().cloned());
                            }
                        }
                    }
                }
            }
            Ok(Some(Ok(Message::Close(_)))) => break,
            Ok(Some(Err(e))) => {
                warn!("WS recv error: {}", e);
                break;
            }
            Ok(None) => break,
            Err(_) if !result_text.is_empty() || !diagnostics.is_empty() => {
                // Timeout, check if we have enough data
                break;
            }
            Err(_) => {}
            _ => {} // ignore Binary/Ping/Pong/Frame
        }
    }

    // Close the connection
    let _ = ws.close(None).await;

    if result_text.is_empty() && !diagnostics.is_empty() {
        result_text = format_diagnostics(&diagnostics);
    }

    if result_text.is_empty() {
        result_text = format!(
            "LSP {} returned empty result for {} at line {}, char {}",
            action, file, line, character
        );
    }

    Ok(result_text)
}

/// Build an LSP JSON-RPC request based on the action.
fn build_lsp_request(
    id: u64,
    action: &str,
    file: &str,
    line: usize,
    character: usize,
    full_input: &Value,
    _lsp_lang: &str,
) -> Value {
    let uri = format!("file://{}", file);
    let position = json!({
        "line": line.saturating_sub(1),  // LSP uses 0-based lines
        "character": character
    });

    match action {
        "diagnostics" => json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": "textDocument/diagnostic",
            "params": {
                "textDocument": { "uri": uri.clone() }
            }
        }),
        "hover" => json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": "textDocument/hover",
            "params": {
                "textDocument": { "uri": uri.clone() },
                "position": position
            }
        }),
        "complete" => json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": "textDocument/completion",
            "params": {
                "textDocument": { "uri": uri.clone() },
                "position": position,
                "context": { "triggerKind": 1 }
            }
        }),
        "definition" => json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": "textDocument/definition",
            "params": {
                "textDocument": { "uri": uri.clone() },
                "position": position
            }
        }),
        "references" => json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": "textDocument/references",
            "params": {
                "textDocument": { "uri": uri.clone() },
                "position": position,
                "context": { "includeDeclaration": true }
            }
        }),
        "rename" => {
            let new_name = full_input["new_name"].as_str().unwrap_or("new_name");
            json!({
                "jsonrpc": "2.0",
                "id": id,
                "method": "textDocument/rename",
                "params": {
                    "textDocument": { "uri": uri.clone() },
                    "position": position,
                    "newName": new_name
                }
            })
        }
        _ => json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": "textDocument/hover",
            "params": {
                "textDocument": { "uri": uri.clone() },
                "position": position
            }
        }),
    }
}

/// Format an LSP result into human-readable text for the agent.
fn format_lsp_result(action: &str, result: &Value, diagnostics: &[Value]) -> String {
    match action {
        "diagnostics" => {
            if diagnostics.is_empty() {
                "No diagnostics found.".to_string()
            } else {
                format_diagnostics(diagnostics)
            }
        }
        "hover" => {
            if let Some(contents) = result.get("contents") {
                let text = match contents {
                    Value::String(s) => s.clone(),
                    Value::Object(obj) => obj
                        .get("value")
                        .and_then(|v| v.as_str())
                        .unwrap_or("(hover info)")
                        .to_string(),
                    _ => "(hover info)".to_string(),
                };
                format!("Hover: {}", text)
            } else {
                "No hover information available at this position.".to_string()
            }
        }
        "complete" => {
            if let Some(items) = result.get("items").and_then(|i| i.as_array()) {
                let completions: Vec<String> = items
                    .iter()
                    .take(30)
                    .map(|item| {
                        let label = item.get("label").and_then(|l| l.as_str()).unwrap_or("?");
                        let detail = item
                            .get("detail")
                            .and_then(|d| d.as_str())
                            .map(|d| format!(" — {}", d))
                            .unwrap_or_default();
                        format!("  - {}{}", label, detail)
                    })
                    .collect();
                if completions.is_empty() {
                    "No completions available.".to_string()
                } else {
                    format!(
                        "Completions ({} total):\n{}",
                        items.len(),
                        completions.join("\n")
                    )
                }
            } else {
                "No completions available.".to_string()
            }
        }
        "definition" => {
            let locations: Vec<String> = match result {
                Value::Array(arr) => arr.iter().filter_map(format_location).collect(),
                Value::Object(_) => {
                    vec![format_location(result).unwrap_or_default()]
                }
                _ => vec![],
            };
            if locations.is_empty() {
                "Definition not found.".to_string()
            } else {
                format!("Definitions found:\n{}", locations.join("\n"))
            }
        }
        "references" => {
            if let Some(arr) = result.as_array() {
                let refs: Vec<String> = arr.iter().filter_map(format_location).collect();
                if refs.is_empty() {
                    "No references found.".to_string()
                } else {
                    format!(
                        "{} reference(s) found:\n{}",
                        refs.len(),
                        refs.iter().take(50).cloned().collect::<Vec<_>>().join("\n")
                    )
                }
            } else {
                "No references found.".to_string()
            }
        }
        "rename" => {
            if let Some(changes) = result
                .get("changes")
                .or_else(|| result.get("documentChanges"))
            {
                let count = if let Some(obj) = changes.as_object() {
                    obj.values()
                        .filter_map(|v| v.as_array())
                        .map(|a| a.len())
                        .sum()
                } else {
                    0
                };
                format!("Rename completed. {} file(s) modified.", count)
            } else {
                "Rename completed.".to_string()
            }
        }
        _ => format!(
            "LSP result: {}",
            serde_json::to_string_pretty(result).unwrap_or_default()
        ),
    }
}

/// Format a single LSP location into a human-readable string.
fn format_location(loc: &Value) -> Option<String> {
    let uri = loc.get("uri").and_then(|u| u.as_str()).unwrap_or("?");
    let range = loc.get("range");
    let start = range.and_then(|r| r.get("start"));

    let line = start
        .and_then(|s| s.get("line").and_then(|l| l.as_u64()))
        .unwrap_or(0) as usize
        + 1; // Convert 0-based to 1-based
    let col = start
        .and_then(|s| s.get("character").and_then(|c| c.as_u64()))
        .unwrap_or(0) as usize;

    // Strip file:// prefix
    let path = uri.strip_prefix("file://").unwrap_or(uri);
    Some(format!("  {}:{}:{}", path, line, col))
}

/// Format diagnostics array into text.
fn format_diagnostics(diagnostics: &[Value]) -> String {
    if diagnostics.is_empty() {
        return "No diagnostics found.".to_string();
    }

    let mut lines = Vec::new();
    lines.push(format!("{} diagnostic(s):", diagnostics.len()));

    for (i, diag) in diagnostics.iter().enumerate().take(50) {
        let severity = diag.get("severity").and_then(|s| s.as_u64()).unwrap_or(3);
        let severity_str = match severity {
            1 => "ERROR",
            2 => "WARNING",
            3 => "INFO",
            4 => "HINT",
            _ => "?",
        };
        let message = diag.get("message").and_then(|m| m.as_str()).unwrap_or("?");

        let range = diag.get("range");
        let start = range.and_then(|r| r.get("start"));
        let line = start
            .and_then(|s| s.get("line").and_then(|l| l.as_u64()))
            .unwrap_or(0) as usize
            + 1;
        let col = start
            .and_then(|s| s.get("character").and_then(|c| c.as_u64()))
            .unwrap_or(0) as usize;

        let source = diag.get("source").and_then(|s| s.as_str()).unwrap_or("");

        let code = diag
            .get("code")
            .map(|c| format!(" [{}]", c))
            .unwrap_or_default();

        let source_str = if source.is_empty() {
            String::new()
        } else {
            format!(" ({})", source)
        };

        lines.push(format!(
            "  {}. [{}]{} line {}:{} — {}{}",
            i + 1,
            severity_str,
            source_str,
            line,
            col,
            message,
            code
        ));
    }

    if diagnostics.len() > 50 {
        lines.push(format!(
            "  ... and {} more diagnostics",
            diagnostics.len() - 50
        ));
    }

    lines.join("\n")
}

/// Read file content (simplified relative to ide_read_file).
fn read_file_content(path: &str) -> Result<(String, String), String> {
    let raw = std::fs::read(path).map_err(|e| format!("Cannot read {}: {}", path, e))?;
    if raw.len() > 2 * 1024 * 1024 {
        return Err("File too large (>2MB)".to_string());
    }
    let content = String::from_utf8_lossy(&raw).to_string();
    // Detect language from path
    let lang = LspManager::language_for_file(path).unwrap_or_else(|| "plaintext".to_string());
    Ok((content, lang))
}

/// Map Monaco language ID to LSP language ID.
pub(crate) fn language_to_lsp_id(lang: &str) -> &str {
    match lang {
        "rust" => "rust",
        "typescript" => "typescript",
        "python" => "python",
        "cpp" => "cpp",
        _ => lang,
    }
}

/// Connect to the LSP bridge, open the file, and collect any
/// `textDocument/publishDiagnostics` notifications emitted within the timeout.
///
/// This is the building block reused by both the `lsp` tool's `diagnostics`
/// action and the standalone `read_lints` tool. Returns the raw `Diagnostic[]`
/// JSON array (LSP shape: `{ range, severity, message, source?, code? }`).
pub(crate) async fn collect_diagnostics_for_file(
    port: u16,
    file: &str,
    language: &str,
    project_root: &str,
    wait_ms: u64,
) -> Result<Vec<Value>, String> {
    use futures::{SinkExt, StreamExt};
    use tokio_tungstenite::connect_async;

    let url = format!("ws://127.0.0.1:{}", port);
    let (mut ws, _) = connect_async(&url)
        .await
        .map_err(|e| format!("Failed to connect to LSP bridge on port {}: {}", port, e))?;

    // initialize
    let init_req = json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {
            "processId": null,
            "rootUri": format!("file://{}", project_root),
            "capabilities": {
                "textDocument": {
                    "publishDiagnostics": { "relatedInformation": true }
                }
            },
            "workspaceFolders": [{
                "uri": format!("file://{}", project_root),
                "name": "project"
            }]
        }
    });
    let init_str = serde_json::to_string(&init_req).unwrap();
    ws.send(Message::Text(format!(
        "Content-Length: {}\r\n\r\n{}",
        init_str.len(),
        init_str
    )))
    .await
    .map_err(|e| format!("WS send error: {}", e))?;

    // wait for init response (canned or real)
    let init_deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(5);
    while tokio::time::Instant::now() < init_deadline {
        match tokio::time::timeout(std::time::Duration::from_millis(500), ws.next()).await {
            Ok(Some(Ok(Message::Text(t)))) => {
                if t.contains("\"id\":1") || t.contains("\"id\":0") {
                    break;
                }
            }
            Ok(Some(Ok(_))) => {}
            Ok(Some(Err(e))) => return Err(format!("WS error during init: {}", e)),
            Ok(None) => return Err("WS closed during init".into()),
            Err(_) => {}
        }
    }

    // initialized
    let init_done = json!({ "jsonrpc": "2.0", "method": "initialized", "params": {} });
    let init_done_str = serde_json::to_string(&init_done).unwrap();
    ws.send(Message::Text(format!(
        "Content-Length: {}\r\n\r\n{}",
        init_done_str.len(),
        init_done_str
    )))
    .await
    .map_err(|e| format!("WS send error: {}", e))?;

    // didOpen
    let (content, _) = read_file_content(file)?;
    let lsp_lang = language_to_lsp_id(language);
    let did_open = json!({
        "jsonrpc": "2.0",
        "method": "textDocument/didOpen",
        "params": {
            "textDocument": {
                "uri": format!("file://{}", file),
                "languageId": lsp_lang,
                "version": 1,
                "text": content
            }
        }
    });
    let did_open_str = serde_json::to_string(&did_open).unwrap();
    ws.send(Message::Text(format!(
        "Content-Length: {}\r\n\r\n{}",
        did_open_str.len(),
        did_open_str
    )))
    .await
    .map_err(|e| format!("WS send error: {}", e))?;

    // collect publishDiagnostics for up to wait_ms
    let target_uri = format!("file://{}", file);
    let mut diagnostics: Vec<Value> = Vec::new();
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_millis(wait_ms);

    while tokio::time::Instant::now() < deadline {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        match tokio::time::timeout(
            remaining.min(std::time::Duration::from_millis(400)),
            ws.next(),
        )
        .await
        {
            Ok(Some(Ok(Message::Text(text)))) => {
                let body = if let Some(idx) = text.find("\r\n\r\n") {
                    &text[idx + 4..]
                } else {
                    text.as_str()
                };
                if let Ok(val) = serde_json::from_str::<Value>(body) {
                    if val.get("method").and_then(|m| m.as_str())
                        == Some("textDocument/publishDiagnostics")
                    {
                        if let Some(params) = val.get("params") {
                            let uri = params.get("uri").and_then(|u| u.as_str()).unwrap_or("");
                            if uri == target_uri {
                                if let Some(arr) =
                                    params.get("diagnostics").and_then(|d| d.as_array())
                                {
                                    diagnostics = arr.clone();
                                }
                            }
                        }
                    }
                }
            }
            Ok(Some(Ok(Message::Close(_)))) => break,
            Ok(Some(Err(_))) => break,
            Ok(None) => break,
            Err(_) => {} // timeout slice; loop until overall deadline
            _ => {}      // ignore Binary/Ping/Pong/Frame
        }
    }

    let _ = ws.close(None).await;
    Ok(diagnostics)
}

/// Public re-export of `format_diagnostics` so the `read_lints` tool can
/// produce the same human-readable shape.
pub(crate) fn format_diagnostics_pub(diagnostics: &[Value]) -> String {
    format_diagnostics(diagnostics)
}

/// Public re-export of `detect_project_root` for the `read_lints` tool.
pub(crate) fn detect_project_root_pub(file: &str) -> String {
    detect_project_root(file)
}
