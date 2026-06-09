use crate::store::{
    db::{AuditEntry, PlanSnapshot, Session, SessionArtifact, SkillRevision},
    AppState,
};
use serde::Serialize;
use tauri::State;

#[derive(Debug, Serialize)]
pub struct SessionActivityBundle {
    pub session_id: String,
    pub session_title: String,
    pub session_updated_at: String,
    pub audits: Vec<AuditEntry>,
    pub plan_snapshots: Vec<PlanSnapshot>,
    pub artifacts: Vec<SessionArtifact>,
    pub skill_revisions: Vec<SkillRevision>,
}

#[tauri::command]
pub async fn get_session_activity_log(
    state: State<'_, AppState>,
    limit_sessions: Option<i64>,
) -> Result<Vec<SessionActivityBundle>, String> {
    let limit = limit_sessions.unwrap_or(30).clamp(1, 100);
    let db = state.db.lock().await;
    let session_ids = db
        .list_activity_session_ids(limit)
        .map_err(|e| e.to_string())?;

    let mut bundles = Vec::with_capacity(session_ids.len());
    for session_id in session_ids {
        let session: Option<Session> = db.get_session(&session_id).map_err(|e| e.to_string())?;
        let session_title = session
            .as_ref()
            .and_then(|s| s.title.clone())
            .filter(|t| !t.trim().is_empty())
            .unwrap_or_else(|| session_id.clone());
        let session_updated_at = session
            .as_ref()
            .map(|s| s.updated_at.to_rfc3339())
            .unwrap_or_default();

        let audits = db
            .get_audit_log(Some(&session_id), None, 200, 0)
            .unwrap_or_default();
        let plan_snapshots = db
            .list_plan_snapshots_for_session(&session_id, 50)
            .unwrap_or_default();
        let artifacts = db
            .list_session_artifacts(&session_id, 50)
            .unwrap_or_default();
        let skill_revisions = db
            .list_skill_revisions_for_session(&session_id, 30)
            .unwrap_or_default();

        if audits.is_empty()
            && plan_snapshots.is_empty()
            && artifacts.is_empty()
            && skill_revisions.is_empty()
        {
            continue;
        }

        bundles.push(SessionActivityBundle {
            session_id,
            session_title,
            session_updated_at,
            audits,
            plan_snapshots,
            artifacts,
            skill_revisions,
        });
    }
    Ok(bundles)
}
