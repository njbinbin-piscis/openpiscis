//! Koi timeline aggregation — read-only data for the video-editor-style
//! timeline view in the Collab page.
//!
//! Returns raw material (members + todos + task event messages) for one
//! pool; the frontend rebuilds per-Koi state segments from it. Timestamps
//! are normalised to RFC3339 because recovery paths write SQLite
//! `datetime('now')` strings ("YYYY-MM-DD HH:MM:SS", UTC, no zone).

use chrono::{DateTime, NaiveDateTime, TimeZone, Utc};
use serde::Serialize;
use tauri::State;

use crate::pool::{KoiDefinition, KoiTodo};
use crate::store::{AppState, Database};

/// One task-lifecycle message from `pool_messages`, trimmed to the fields
/// the timeline needs. `id` doubles as the chat-jump anchor.
#[derive(Debug, Clone, Serialize)]
pub struct TimelineEvent {
    pub id: i64,
    pub sender_id: String,
    pub todo_id: Option<String>,
    pub event_type: Option<String>,
    pub msg_type: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct TimelineMember {
    pub koi: KoiDefinition,
    /// Normalised RFC3339 join time; left boundary of the Koi's lane.
    pub joined_at: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct KoiTimelineData {
    pub pool_id: String,
    pub server_now: String,
    pub members: Vec<TimelineMember>,
    pub todos: Vec<KoiTodo>,
    pub events: Vec<TimelineEvent>,
}

/// Parse a timestamp leniently: RFC3339 first, then SQLite
/// `datetime('now')` shapes (assumed UTC). Returns None when unparseable.
pub(crate) fn parse_ts_lenient(s: &str) -> Option<DateTime<Utc>> {
    if let Ok(dt) = DateTime::parse_from_rfc3339(s) {
        return Some(dt.with_timezone(&Utc));
    }
    for fmt in [
        "%Y-%m-%d %H:%M:%S%.f",
        "%Y-%m-%d %H:%M:%S",
        "%Y-%m-%dT%H:%M:%S%.f",
    ] {
        if let Ok(naive) = NaiveDateTime::parse_from_str(s, fmt) {
            return Some(Utc.from_utc_datetime(&naive));
        }
    }
    None
}

fn normalise_ts(s: &str) -> String {
    parse_ts_lenient(s)
        .map(|dt| dt.to_rfc3339())
        .unwrap_or_else(|| s.to_string())
}

/// Upper bound on event messages pulled per refresh. Task events are a
/// small fraction of pool traffic; 5000 covers months of typical use.
const EVENT_FETCH_LIMIT: i64 = 5000;

pub(crate) fn collect_timeline(db: &Database, pool_id: &str) -> Result<KoiTimelineData, String> {
    let members_def = db.list_pool_members(pool_id).map_err(|e| e.to_string())?;

    // joined_at is not part of KoiDefinition; read it straight from the
    // roster table (Database.conn is intentionally pub for host queries).
    let mut stmt = db
        .conn
        .prepare("SELECT koi_id, joined_at FROM pool_members WHERE pool_session_id = ?1")
        .map_err(|e| e.to_string())?;
    let joined_rows = stmt
        .query_map([pool_id], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })
        .map_err(|e| e.to_string())?;
    let mut joined_by_koi = std::collections::HashMap::new();
    for row in joined_rows {
        let (koi_id, joined_at) = row.map_err(|e| e.to_string())?;
        joined_by_koi.insert(koi_id, normalise_ts(&joined_at));
    }

    let members: Vec<TimelineMember> = members_def
        .into_iter()
        .map(|koi| {
            let joined_at = joined_by_koi
                .get(&koi.id)
                .cloned()
                .unwrap_or_else(|| koi.created_at.to_rfc3339());
            TimelineMember { koi, joined_at }
        })
        .collect();

    let todos: Vec<KoiTodo> = db
        .list_koi_todos(None)
        .map_err(|e| e.to_string())?
        .into_iter()
        .filter(|t| t.pool_session_id.as_deref() == Some(pool_id))
        .collect();

    let messages = db
        .get_pool_messages(pool_id, EVENT_FETCH_LIMIT, 0)
        .map_err(|e| e.to_string())?;
    let mut events: Vec<TimelineEvent> = messages
        .into_iter()
        .filter(|m| m.todo_id.is_some() || m.event_type.is_some())
        .map(|m| TimelineEvent {
            id: m.id,
            sender_id: m.sender_id,
            todo_id: m.todo_id,
            event_type: m.event_type,
            msg_type: m.msg_type,
            created_at: m.created_at.to_rfc3339(),
        })
        .collect();
    // Mixed timestamp formats can break SQL-side ordering; sort by parsed
    // time so the frontend always receives a chronological stream.
    events.sort_by_key(|e| parse_ts_lenient(&e.created_at));

    Ok(KoiTimelineData {
        pool_id: pool_id.to_string(),
        server_now: Utc::now().to_rfc3339(),
        members,
        todos,
        events,
    })
}

#[tauri::command]
pub async fn get_koi_timeline(
    state: State<'_, AppState>,
    pool_id: String,
) -> Result<KoiTimelineData, String> {
    let db = state.db.lock().await;
    collect_timeline(&db, &pool_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_ts_lenient_handles_rfc3339_and_sqlite_shapes() {
        let rfc = parse_ts_lenient("2026-11-27T10:00:00.123456+00:00").expect("rfc3339");
        assert_eq!(rfc.to_rfc3339(), "2026-11-27T10:00:00.123456+00:00");

        let sqlite = parse_ts_lenient("2026-11-27 10:00:00").expect("sqlite datetime");
        assert_eq!(sqlite.to_rfc3339(), "2026-11-27T10:00:00+00:00");

        let offset = parse_ts_lenient("2026-11-27T18:00:00+08:00").expect("offset rfc");
        assert_eq!(offset.to_rfc3339(), "2026-11-27T10:00:00+00:00");

        assert!(parse_ts_lenient("not a date").is_none());
    }

    #[test]
    fn normalise_ts_converts_sqlite_shape_to_rfc3339() {
        assert_eq!(
            normalise_ts("2026-11-27 10:00:00"),
            "2026-11-27T10:00:00+00:00"
        );
        // Unparseable input is passed through unchanged rather than dropped.
        assert_eq!(normalise_ts("garbage"), "garbage");
    }

    fn fixture_db() -> Database {
        let db = Database::open_in_memory().expect("in-memory db");
        let pool = db.create_pool_session("timeline-test", 0).expect("pool");
        let koi = db
            .create_koi("Tester", "dev", "🐟", "#22c55e", "", "", None, 0, 0)
            .expect("koi");
        db.add_pool_member(&pool.id, &koi.id).expect("member");
        let todo = db
            .create_koi_todo(
                &koi.id,
                "task A",
                "",
                "medium",
                "user",
                Some(&pool.id),
                "user",
                None,
                0,
            )
            .expect("todo");
        db.try_claim_koi_todo(&todo.id, &koi.id).expect("claim");
        db.insert_pool_message_ext(
            &pool.id,
            &koi.id,
            "claimed task A",
            "task_claimed",
            "{}",
            Some(&todo.id),
            None,
            Some("task_claimed"),
        )
        .expect("claimed msg");
        db.insert_pool_message_ext(
            &pool.id,
            &koi.id,
            "done task A",
            "result",
            "{}",
            Some(&todo.id),
            None,
            Some("task_completed"),
        )
        .expect("done msg");
        // Plain chat text without todo/event linkage must be filtered out.
        db.insert_pool_message(&pool.id, "user", "hello", "text", "{}")
            .expect("text msg");
        db
    }

    #[test]
    fn collect_timeline_returns_members_todos_and_linked_events() {
        let db = fixture_db();
        let pool_id = db.list_pool_sessions().unwrap()[0].id.clone();
        let data = collect_timeline(&db, &pool_id).expect("timeline");

        assert_eq!(data.pool_id, pool_id);
        assert_eq!(data.members.len(), 1);
        assert!(!data.members[0].joined_at.is_empty());
        assert!(parse_ts_lenient(&data.members[0].joined_at).is_some());
        assert_eq!(data.todos.len(), 1);
        assert_eq!(data.todos[0].status, "in_progress");

        // Only the two linked task events survive the filter.
        assert_eq!(data.events.len(), 2);
        assert_eq!(data.events[0].event_type.as_deref(), Some("task_claimed"));
        assert_eq!(data.events[1].event_type.as_deref(), Some("task_completed"));
        // Chronological order.
        let t0 = parse_ts_lenient(&data.events[0].created_at).unwrap();
        let t1 = parse_ts_lenient(&data.events[1].created_at).unwrap();
        assert!(t0 <= t1);
        assert!(parse_ts_lenient(&data.server_now).is_some());
    }

    #[test]
    fn collect_timeline_normalises_sqlite_joined_at() {
        let db = fixture_db();
        let pool_id = db.list_pool_sessions().unwrap()[0].id.clone();
        // Simulate a recovery-path write: SQLite datetime('now') shape.
        db.conn
            .execute(
                "UPDATE pool_members SET joined_at = '2026-11-27 09:00:00' WHERE pool_session_id = ?1",
                [&pool_id],
            )
            .unwrap();
        let data = collect_timeline(&db, &pool_id).expect("timeline");
        assert_eq!(data.members[0].joined_at, "2026-11-27T09:00:00+00:00");
    }

    #[test]
    fn collect_timeline_empty_pool_has_no_members_or_events() {
        let db = Database::open_in_memory().expect("db");
        let pool = db.create_pool_session("empty", 0).expect("pool");
        let data = collect_timeline(&db, &pool.id).expect("timeline");
        assert!(data.members.is_empty());
        assert!(data.todos.is_empty());
        assert!(data.events.is_empty());
    }
}
