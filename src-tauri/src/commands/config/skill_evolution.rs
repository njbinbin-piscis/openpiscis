use crate::skills::provenance;
use crate::skills::service;
use crate::store::{db::SkillRevision, db::SkillUsage, AppState};
use serde::Serialize;
use tauri::Manager;
use tauri::State;

#[derive(Debug, Serialize)]
pub struct SkillRevisionList {
    pub revisions: Vec<SkillRevision>,
}

#[derive(Debug, Serialize)]
pub struct SkillUsageList {
    pub usage: Vec<SkillUsage>,
}

#[derive(Debug, Serialize)]
pub struct CuratorStatus {
    pub last_run_at: Option<String>,
    pub agent_created_count: u32,
    pub draft_count: u32,
    pub learned_count: u32,
    pub archived_count: u32,
    pub top_used: Vec<SkillUsage>,
    pub least_used: Vec<SkillUsage>,
}

fn app_skills_root(state: &AppState) -> std::path::PathBuf {
    let app_dir = state
        .app_handle
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| std::path::PathBuf::from(".piscis"));
    service::skills_root_from_app_data(&app_dir)
}

#[tauri::command]
pub async fn promote_skill(state: State<'_, AppState>, skill_id: String) -> Result<(), String> {
    let root = app_skills_root(&state);
    let db = state.db.lock().await;
    service::promote_draft_to_learned(&db, &root, &skill_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn discard_draft_skill(state: State<'_, AppState>, skill_id: String) -> Result<(), String> {
    let root = app_skills_root(&state);
    let db = state.db.lock().await;
    service::delete_draft(&db, &root, &skill_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn lock_skill(state: State<'_, AppState>, skill_id: String) -> Result<(), String> {
    let db = state.db.lock().await;
    service::set_skill_locked(&db, &skill_id, true).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn unlock_skill(state: State<'_, AppState>, skill_id: String) -> Result<(), String> {
    let db = state.db.lock().await;
    service::set_skill_locked(&db, &skill_id, false).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn pin_skill(state: State<'_, AppState>, skill_id: String) -> Result<(), String> {
    let db = state.db.lock().await;
    service::set_skill_pinned_db(&db, &skill_id, true).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn unpin_skill(state: State<'_, AppState>, skill_id: String) -> Result<(), String> {
    let db = state.db.lock().await;
    service::set_skill_pinned_db(&db, &skill_id, false).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn list_skill_revisions(
    state: State<'_, AppState>,
    skill_id: Option<String>,
    session_id: Option<String>,
    limit: Option<i64>,
) -> Result<SkillRevisionList, String> {
    let limit = limit.unwrap_or(30).clamp(1, 100);
    let db = state.db.lock().await;
    let revisions = if let Some(sid) = skill_id.as_deref() {
        db.list_skill_revisions_for_skill(sid, limit)
    } else if let Some(sess) = session_id.as_deref() {
        db.list_skill_revisions_for_session(sess, limit)
    } else {
        Ok(vec![])
    }
    .map_err(|e| e.to_string())?;
    Ok(SkillRevisionList { revisions })
}

#[tauri::command]
pub async fn list_skill_usage(state: State<'_, AppState>) -> Result<SkillUsageList, String> {
    let db = state.db.lock().await;
    let usage = db.list_skill_usage().map_err(|e| e.to_string())?;
    Ok(SkillUsageList { usage })
}

#[tauri::command]
pub async fn curator_status(state: State<'_, AppState>) -> Result<CuratorStatus, String> {
    let root = app_skills_root(&state);
    let marker = root.join(".curator_last_run");
    let last_run_at = std::fs::read_to_string(&marker).ok();

    let mut draft_count = 0u32;
    let mut learned_count = 0u32;
    let mut archived_count = 0u32;
    for (dir, counter) in [
        (provenance::draft_dir(&root), &mut draft_count),
        (provenance::learned_dir(&root), &mut learned_count),
        (provenance::archive_dir(&root), &mut archived_count),
    ] {
        if dir.exists() {
            *counter = std::fs::read_dir(&dir)
                .map(|entries| entries.flatten().count() as u32)
                .unwrap_or(0);
        }
    }

    let db = state.db.lock().await;
    let usage = db.list_skill_usage().unwrap_or_default();
    let agent_created_count = usage
        .iter()
        .filter(|u| {
            u.created_by.as_deref() == Some("agent")
                || u.created_by.as_deref() == Some("background_review")
        })
        .count() as u32;
    let top_used: Vec<_> = usage.iter().take(5).cloned().collect();
    let least_used: Vec<_> = usage.iter().rev().take(5).cloned().collect();

    Ok(CuratorStatus {
        last_run_at,
        agent_created_count,
        draft_count,
        learned_count,
        archived_count,
        top_used,
        least_used,
    })
}

#[tauri::command]
pub async fn curator_run(
    state: State<'_, AppState>,
    dry_run: Option<bool>,
) -> Result<String, String> {
    crate::commands::chat::curator::run_curator_pass(&state, dry_run.unwrap_or(false)).await
}

#[tauri::command]
pub async fn curator_rollback(state: State<'_, AppState>) -> Result<(), String> {
    crate::commands::chat::curator::rollback_latest_backup(&state).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn restore_archived_skill(
    state: State<'_, AppState>,
    skill_id: String,
) -> Result<(), String> {
    let root = app_skills_root(&state);
    let db = state.db.lock().await;
    service::restore_archived(&db, &root, &skill_id).map_err(|e| e.to_string())
}
