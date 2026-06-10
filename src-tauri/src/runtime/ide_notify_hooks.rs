//! Agent hooks that journal file edits and notify the IDE file tree / git panel.
//!
//! `notify` watchers can miss same-process writes on some platforms; emitting
//! `ide-file-changed` after successful `file_write` / `file_edit` keeps the
//! Pond IDE explorer and git status in sync when Piscis runs from the CLI panel.

use std::sync::Arc;

use async_trait::async_trait;
use piscis_kernel::agent::file_journal::FileJournal;
use piscis_kernel::agent::hooks::{AgentHooks, ContextHookEvent, HookDecision, ToolHookEvent};
use piscis_kernel::agent::tool::ToolResult;
use std::collections::HashMap;
use once_cell::sync::Lazy;
use std::sync::Mutex;

use tauri::{AppHandle, Emitter, Manager};

const FILE_TOOLS: &[&str] = &["file_write", "file_edit"];
const COMPACTION_CONSOLIDATION_THRESHOLD: u32 = 3;

static SESSION_COMPACTION_COUNTS: Lazy<Mutex<HashMap<String, u32>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

/// Wraps [`FileJournal`] and broadcasts IDE refresh events after file mutations.
pub struct JournalWithIdeNotify {
    journal: Arc<FileJournal>,
    app: AppHandle,
}

impl JournalWithIdeNotify {
    pub fn new(journal: Arc<FileJournal>, app: AppHandle) -> Self {
        Self { journal, app }
    }

    fn rel_path(workspace_root: &std::path::Path, raw: &str) -> Option<String> {
        let p = std::path::Path::new(raw);
        let rel = p
            .strip_prefix(workspace_root)
            .unwrap_or(p)
            .to_string_lossy()
            .replace('\\', "/");
        let rel = rel.trim_start_matches('/').to_string();
        if rel.is_empty() || rel == ".git" || rel.starts_with(".git/") {
            return None;
        }
        Some(rel)
    }

    fn emit_file_changed(&self, ev: &ToolHookEvent<'_>, kind: &str) {
        let Some(path) = ev
            .input
            .get("path")
            .and_then(|v| v.as_str())
            .and_then(|raw| Self::rel_path(ev.workspace_root, raw))
        else {
            return;
        };
        let project_dir = ev.workspace_root.to_string_lossy().to_string();
        let _ = self.app.emit(
            "ide-file-changed",
            serde_json::json!({
                "project_dir": project_dir,
                "path": path,
                "kind": kind,
            }),
        );
    }
}

#[async_trait]
impl AgentHooks for JournalWithIdeNotify {
    async fn before_tool(&self, ev: &ToolHookEvent<'_>) -> HookDecision {
        if FILE_TOOLS.contains(&ev.tool_name) {
            if let Some(path) = ev.input.get("path").and_then(|v| v.as_str()) {
                let normalized = path.replace('\\', "/").to_lowercase();
                if normalized.contains("/skills/installed/")
                    || normalized.contains("/skills/.hub/")
                    || normalized.ends_with("/skill.md") && normalized.contains("/skills/")
                {
                    return HookDecision::Deny(
                        "Cannot modify locked skill files via file_write/file_edit. Use skill_manage for draft/learned skills.".into(),
                    );
                }
            }
        }
        self.journal.before_tool(ev).await
    }

    async fn after_tool(&self, ev: &ToolHookEvent<'_>, result: &ToolResult) {
        self.journal.after_tool(ev, result).await;
        if result.is_error || !FILE_TOOLS.contains(&ev.tool_name) {
            return;
        }
        self.emit_file_changed(ev, "modified");
    }

    async fn on_context_event(&self, ev: &ContextHookEvent<'_>) {
        if let ContextHookEvent::AfterCompact { session_id, .. } = ev {
            let count = {
                let mut counts = SESSION_COMPACTION_COUNTS
                    .lock()
                    .unwrap_or_else(|e| e.into_inner());
                let entry = counts.entry(session_id.to_string()).or_insert(0);
                *entry = entry.saturating_add(1);
                *entry
            };
            if count >= COMPACTION_CONSOLIDATION_THRESHOLD {
                SESSION_COMPACTION_COUNTS
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .remove(*session_id);
                if let Some(state) = self.app.try_state::<crate::store::AppState>() {
                    let state = state.inner().clone();
                    let sid = session_id.to_string();
                    tokio::spawn(async move {
                        let _ =
                            crate::commands::chat::scheduler::trigger_consolidation_for_session(
                                &state, &sid,
                            )
                            .await;
                    });
                }
            }
        }
    }
}
