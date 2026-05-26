//! `read_lints` — agent tool that returns LSP diagnostics for one or more files.
//!
//! Modeled after Cursor's ReadLints. Use this AFTER editing files to surface
//! compiler / type-checker / linter problems before continuing. Cheaper than
//! re-running a full build because it relies on the always-running LSP servers
//! managed by [`crate::lsp::manager::LspManager`].
//!
//! Differences vs. the `lsp` tool's `diagnostics` action:
//! - Accepts an array of paths (`paths: string[]`) for batch checking.
//! - Returns a unified, deduplicated, severity-filtered report.
//! - Tuned defaults for "ran right after edits" semantics: 1500ms wait per
//!   file, errors+warnings only by default.

use async_trait::async_trait;
use pisci_kernel::agent::tool::{Tool, ToolContext, ToolResult};
use serde_json::{json, Value};
use std::sync::Arc;
use tracing::warn;

use crate::lsp::manager::LspManager;
use crate::tools::lsp::{
    collect_diagnostics_for_file, detect_project_root_pub, format_diagnostics_pub,
};

pub struct ReadLintsTool {
    pub lsp_manager: Arc<LspManager>,
}

#[async_trait]
impl Tool for ReadLintsTool {
    fn name(&self) -> &str {
        "read_lints"
    }

    fn description(&self) -> &str {
        "Read lints / diagnostics (compiler errors, type errors, lints) for one \
         or more source files. Pull diagnostics from the running language \
         server (rust-analyzer / typescript-language-server / pyright / clangd).\n\
         \n\
         WHEN TO USE: Right after editing files, BEFORE continuing the task. \
         Do NOT call this on every read — only when you want to verify recent \
         edits or investigate a build failure. Prefer this over running the \
         full build for fast feedback.\n\
         \n\
         Parameters:\n\
         - 'paths' (string[]): absolute file paths to check.\n\
         - 'severity' ('error' | 'warning' | 'all'): filter level. \
         Default 'warning' (errors + warnings).\n\
         - 'wait_ms' (number): how long to wait per file for the server to \
         publish diagnostics. Default 1500. Increase for cold starts / large \
         projects.\n\
         \n\
         Output: a per-file list of `[SEVERITY] line:col — message` lines, or \
         'No diagnostics found.' when clean. Files whose language has no LSP \
         server are skipped with a one-line note."
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "paths": {
                    "type": "array",
                    "items": { "type": "string" },
                    "description": "Absolute paths of files to check."
                },
                "severity": {
                    "type": "string",
                    "enum": ["error", "warning", "all"],
                    "description": "Minimum severity to include. Default 'warning'."
                },
                "wait_ms": {
                    "type": "integer",
                    "description": "Per-file wait for diagnostics in milliseconds. Default 1500."
                }
            },
            "required": ["paths"]
        })
    }

    fn is_read_only(&self) -> bool {
        true
    }

    async fn call(&self, input: Value, _ctx: &ToolContext) -> anyhow::Result<ToolResult> {
        let paths: Vec<String> = match input.get("paths").and_then(|p| p.as_array()) {
            Some(arr) => arr
                .iter()
                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                .collect(),
            None => {
                return Ok(ToolResult::err(
                    "'paths' parameter is required (array of absolute file paths)",
                ));
            }
        };

        if paths.is_empty() {
            return Ok(ToolResult::err("'paths' must contain at least one path"));
        }

        let min_severity = severity_floor(
            input
                .get("severity")
                .and_then(|s| s.as_str())
                .unwrap_or("warning"),
        );
        let wait_ms = input
            .get("wait_ms")
            .and_then(|w| w.as_u64())
            .unwrap_or(1500)
            .clamp(200, 15_000);

        let mut sections: Vec<String> = Vec::new();
        let mut total_errors = 0usize;
        let mut total_warnings = 0usize;

        for file in &paths {
            // Detect language
            let language = match LspManager::language_for_file(file) {
                Some(l) => l,
                None => {
                    sections.push(format!(
                        "── {} ──\n  (no LSP server available for this file type)",
                        file
                    ));
                    continue;
                }
            };

            let project_root = detect_project_root_pub(file);
            let port = match self.lsp_manager.start(&project_root, &language).await {
                Ok(p) => p,
                Err(e) => {
                    warn!("read_lints: failed to start LSP for {}: {}", file, e);
                    sections.push(format!(
                        "── {} ──\n  (failed to start {} LSP: {})",
                        file, language, e
                    ));
                    continue;
                }
            };

            let diags =
                match collect_diagnostics_for_file(port, file, &language, &project_root, wait_ms)
                    .await
                {
                    Ok(d) => d,
                    Err(e) => {
                        warn!("read_lints: collect failed for {}: {}", file, e);
                        sections.push(format!("── {} ──\n  (LSP query failed: {})", file, e));
                        continue;
                    }
                };

            let filtered: Vec<Value> = diags
                .into_iter()
                .filter(|d| {
                    let sev = d.get("severity").and_then(|s| s.as_u64()).unwrap_or(3);
                    sev <= min_severity
                })
                .collect();

            for d in &filtered {
                match d.get("severity").and_then(|s| s.as_u64()).unwrap_or(3) {
                    1 => total_errors += 1,
                    2 => total_warnings += 1,
                    _ => {}
                }
            }

            let body = if filtered.is_empty() {
                "  No diagnostics found.".to_string()
            } else {
                // Indent each line of format_diagnostics_pub by two spaces
                format_diagnostics_pub(&filtered)
                    .lines()
                    .map(|l| format!("  {}", l))
                    .collect::<Vec<_>>()
                    .join("\n")
            };

            sections.push(format!("── {} ──\n{}", file, body));
        }

        let summary = format!(
            "read_lints: {} file(s) checked — {} error(s), {} warning(s)\n\n{}",
            paths.len(),
            total_errors,
            total_warnings,
            sections.join("\n\n")
        );

        Ok(ToolResult::ok(summary))
    }
}

/// Map a severity name to the LSP numeric ceiling we keep.
/// LSP severities: 1=Error, 2=Warning, 3=Information, 4=Hint.
fn severity_floor(name: &str) -> u64 {
    match name.to_ascii_lowercase().as_str() {
        "error" => 1,
        "warning" => 2,
        "all" | "info" | "hint" => 4,
        _ => 2,
    }
}
