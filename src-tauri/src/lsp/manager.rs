//! LSP process lifecycle manager.
//!
//! Manages language server processes per project+language combination:
//! - Auto-detects installed language servers
//! - Spawns processes with proper args and stdio piped
//! - Tracks session state (process handle, port)
//! - Provides cleanup on drop

use std::collections::HashMap;
use std::process::Stdio;
use std::sync::Arc;
use tokio::process::Child;
use tokio::sync::Mutex;
use tracing::{info, warn};

/// Unique key for an LSP session: project_dir + language.
type SessionKey = String;

/// Represents one language for which LSP is available.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LanguageSupport {
    /// Monaco language ID (e.g. "rust", "typescript", "python")
    pub language_id: String,
    /// Human-readable name
    pub name: String,
    /// File extensions (e.g. [".rs"], [".ts", ".tsx"])
    pub extensions: Vec<String>,
    /// LSP server command (e.g. "rust-analyzer")
    pub server_command: String,
    /// Extra args for the server
    pub server_args: Vec<String>,
    /// Whether the server binary was detected on this machine
    pub available: bool,
}

/// Running LSP session.
struct LspSession {
    #[allow(dead_code)]
    project_dir: String,
    #[allow(dead_code)]
    language: String,
    /// WebSocket port the bridge is listening on
    port: u16,
    /// The child process handle — keeps the process alive.
    /// Dropping this kills the process.
    #[allow(dead_code)]
    child: Child,
}

/// Global LSP process manager.
///
/// Thread-safe, designed to be stored in [`crate::store::AppState`].
pub struct LspManager {
    sessions: Mutex<HashMap<SessionKey, Arc<LspSession>>>,
}

impl LspManager {
    pub fn new() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
        }
    }

    /// Build a session key from project dir + language.
    fn session_key(project_dir: &str, language: &str) -> SessionKey {
        format!("{}|{}", project_dir, language)
    }

    /// List all supported languages with auto-detection of installed servers.
    pub fn supported_languages() -> Vec<LanguageSupport> {
        fn is_on_path(cmd: &str) -> bool {
            #[cfg(windows)]
            let probe = "where";
            #[cfg(not(windows))]
            let probe = "which";
            piscis_kernel::proc::std_command(probe)
                .arg(cmd)
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status()
                .map(|s| s.success())
                .unwrap_or(false)
        }
        vec![
            LanguageSupport {
                language_id: "rust".into(),
                name: "Rust".into(),
                extensions: vec![".rs".into()],
                server_command: "rust-analyzer".into(),
                server_args: vec![],
                available: is_on_path("rust-analyzer"),
            },
            LanguageSupport {
                language_id: "typescript".into(),
                name: "TypeScript / JavaScript".into(),
                extensions: vec![
                    ".ts".into(),
                    ".tsx".into(),
                    ".js".into(),
                    ".jsx".into(),
                    ".mjs".into(),
                    ".cjs".into(),
                ],
                server_command: "typescript-language-server".into(),
                server_args: vec!["--stdio".into()],
                available: is_on_path("typescript-language-server"),
            },
            LanguageSupport {
                language_id: "python".into(),
                name: "Python".into(),
                extensions: vec![".py".into(), ".pyi".into()],
                server_command: "pyright-langserver".into(),
                server_args: vec!["--stdio".into()],
                available: is_on_path("pyright-langserver"),
            },
            LanguageSupport {
                language_id: "cpp".into(),
                name: "C / C++".into(),
                extensions: vec![
                    ".c".into(),
                    ".h".into(),
                    ".cpp".into(),
                    ".cc".into(),
                    ".cxx".into(),
                    ".hpp".into(),
                    ".hxx".into(),
                ],
                server_command: "clangd".into(),
                server_args: vec![],
                available: is_on_path("clangd"),
            },
        ]
    }

    /// Detect which language to use for a file path.
    pub fn language_for_file(path: &str) -> Option<String> {
        let lower = path.to_lowercase();
        for lang in Self::supported_languages() {
            if lang.available
                && lang
                    .extensions
                    .iter()
                    .any(|ext| lower.ends_with(ext.as_str()))
            {
                return Some(lang.language_id.clone());
            }
        }
        None
    }

    /// Get the command and args for a given language.
    fn server_info(language: &str) -> Option<LanguageSupport> {
        Self::supported_languages()
            .into_iter()
            .find(|l| l.language_id == language && l.available)
    }

    /// Start an LSP server for the given project directory and language.
    ///
    /// Returns the WebSocket port the bridge is listening on.
    /// If a session already exists for this project+language, returns its port.
    pub async fn start(&self, project_dir: &str, language: &str) -> Result<u16, String> {
        let key = Self::session_key(project_dir, language);

        // Return existing session
        {
            let sessions = self.sessions.lock().await;
            if let Some(session) = sessions.get(&key) {
                info!(
                    "LSP session {}/{} already running on port {}",
                    project_dir, language, session.port
                );
                return Ok(session.port);
            }
        }

        // Find server info
        let info = Self::server_info(language)
            .ok_or_else(|| format!("No available LSP server for language: {}", language))?;

        // Allocate a TCP port for the WebSocket bridge
        let port = pick_unused_port()
            .ok_or_else(|| "Failed to allocate a TCP port for LSP bridge".to_string())?;

        info!(
            "Starting LSP server '{}' for {}/{} on port {}",
            info.server_command, project_dir, language, port
        );

        // Spawn the LSP server process
        let mut child = piscis_kernel::proc::tokio_command(&info.server_command)
            .args(&info.server_args)
            .current_dir(project_dir)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| format!("Failed to spawn '{}': {}", info.server_command, e))?;

        let stdin = child
            .stdin
            .take()
            .ok_or("Failed to take LSP stdin handle")?;
        let stdout = child
            .stdout
            .take()
            .ok_or("Failed to take LSP stdout handle")?;
        let stderr = child.stderr.take();

        // Spawn the WebSocket bridge
        let language_clone = language.to_string();
        let project_clone = project_dir.to_string();
        let server_name = info.server_command.clone();
        tokio::spawn(async move {
            if let Err(e) = crate::lsp::bridge::run_lsp_bridge(
                port,
                stdin,
                stdout,
                stderr,
                &language_clone,
                &project_clone,
            )
            .await
            {
                warn!("LSP bridge for {} exited: {}", server_name, e);
            }
        });

        // Store session
        let session = Arc::new(LspSession {
            project_dir: project_dir.to_string(),
            language: language.to_string(),
            port,
            child,
        });

        {
            let mut sessions = self.sessions.lock().await;
            sessions.insert(key, session);
        }

        Ok(port)
    }

    /// Stop an LSP session for the given project + language.
    pub async fn stop(&self, project_dir: &str, language: &str) -> Result<(), String> {
        let key = Self::session_key(project_dir, language);
        let session = {
            let mut sessions = self.sessions.lock().await;
            sessions.remove(&key)
        };

        match session {
            Some(_s) => {
                info!(
                    "Stopped LSP session {}/{} (process will be killed on drop)",
                    project_dir, language
                );
                Ok(())
            }
            None => Err(format!(
                "No active LSP session for {}/{}",
                project_dir, language
            )),
        }
    }

    /// Stop all active LSP sessions.
    pub async fn stop_all(&self) {
        let mut sessions = self.sessions.lock().await;
        let count = sessions.len();
        sessions.clear();
        info!("Stopped all {} LSP session(s)", count);
    }
}

impl Default for LspManager {
    fn default() -> Self {
        Self::new()
    }
}

/// Try to find an unused TCP port on localhost.
fn pick_unused_port() -> Option<u16> {
    use std::net::TcpListener;
    // Let the OS assign a random free port
    TcpListener::bind("127.0.0.1:0").ok().and_then(|l| {
        l.local_addr().ok().map(|a| a.port())
        // listener is dropped here, freeing the port
    })
}
