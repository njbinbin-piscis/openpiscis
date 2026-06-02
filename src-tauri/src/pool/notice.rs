//! Piscis-visible pool status lines (acks, errors) without going through the agent.

use std::sync::Arc;

use crate::host::DesktopEventSink;
use crate::pool::PoolMessage;
use crate::store::AppState;
use piscis_core::host::{PoolEvent, PoolEventSink, PoolMessageSnapshot};

fn emit_message(app: &tauri::AppHandle, msg: &PoolMessage) {
    let sink = Arc::new(DesktopEventSink::new(app.clone()));
    sink.emit_pool(&PoolEvent::MessageAppended {
        pool_id: msg.pool_session_id.clone(),
        message: PoolMessageSnapshot::from(msg),
    });
}

/// Insert a Piscis supervisor status line into the pool and push it to the UI.
pub async fn post_piscis_pool_notice(
    app: &tauri::AppHandle,
    state: &AppState,
    pool_id: &str,
    content: &str,
) -> Result<PoolMessage, String> {
    let msg = {
        let db = state.db.lock().await;
        db.insert_pool_message_ext(
            pool_id,
            "piscis",
            content,
            "status_update",
            r#"{"event":"piscis_status","controlled_by":"mention_ack"}"#,
            None,
            None,
            Some("piscis_status"),
        )
        .map_err(|e| e.to_string())?
    };
    emit_message(app, &msg);
    Ok(msg)
}
