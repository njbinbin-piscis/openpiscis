//! Background review fork — rubric-based memory/skill decisions after each turn.

use crate::skills::service::{self, SKILL_TEMPLATE};
use crate::store::AppState;
use piscis_kernel::llm::{
    build_client_with_timeout, ContentBlock, LlmMessage, LlmRequest, MessageContent,
};
use piscis_kernel::store::SkillEvolutionSettings;
use serde::Deserialize;
use std::collections::HashMap;
use std::sync::{Arc, LazyLock, Mutex};
use tauri::Manager;
use tracing::debug;

static SESSION_REVIEW_TURNS: LazyLock<Mutex<HashMap<String, u32>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
static SESSION_LAST_UMBRELLA_TURN: LazyLock<Mutex<HashMap<String, u32>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

#[derive(Debug, Deserialize)]
struct ReviewDecision {
    save_memories: Vec<ReviewMemory>,
    patch_skill_id: Option<String>,
    patch_old: Option<String>,
    patch_new: Option<String>,
    create_skill: Option<ReviewCreate>,
}

#[derive(Debug, Deserialize)]
struct ReviewMemory {
    content: String,
    category: Option<String>,
    kind: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ReviewCreate {
    name: String,
    description: Option<String>,
}

fn summarize_turn(messages: &[piscis_kernel::llm::LlmMessage], max_chars: usize) -> String {
    let mut parts = Vec::new();
    for m in messages.iter().rev().take(12) {
        let role = match m.role.as_str() {
            "user" => "User",
            "assistant" => "Assistant",
            _ => continue,
        };
        let text = match &m.content {
            MessageContent::Text(t) => t.clone(),
            MessageContent::Blocks(blocks) => blocks
                .iter()
                .filter_map(|b| match b {
                    ContentBlock::Text { text } => Some(text.as_str()),
                    _ => None,
                })
                .collect::<Vec<_>>()
                .join(" "),
        };
        if !text.trim().is_empty() {
            parts.push(format!("{}: {}", role, text.trim()));
        }
    }
    parts.reverse();
    let joined = parts.join("\n");
    if joined.len() > max_chars {
        joined.chars().take(max_chars).collect()
    } else {
        joined
    }
}

fn count_tool_calls(messages: &[LlmMessage]) -> u32 {
    messages
        .iter()
        .filter(|m| m.role == "tool" || m.role == "function")
        .count() as u32
}

pub async fn run_background_skill_review(
    state: Arc<AppState>,
    session_id: String,
    final_messages: Vec<LlmMessage>,
    provider: String,
    api_key: String,
    base_url: Option<String>,
    model: String,
    max_tokens: u32,
    memory_owner_id: String,
) {
    let evo: SkillEvolutionSettings = {
        let s = state.settings.lock().await;
        s.skill_evolution.clone()
    };
    if !evo.review_enabled || !evo.review_every_turn {
        return;
    }

    let summary = summarize_turn(&final_messages, 4000);
    if summary.len() < 80 {
        return;
    }
    let tool_calls = count_tool_calls(&final_messages);
    if tool_calls < 3 {
        debug!("skill_review: skip (tool_calls={})", tool_calls);
        return;
    }

    let turn_no = {
        let mut turns = SESSION_REVIEW_TURNS
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let entry = turns.entry(session_id.clone()).or_insert(0);
        *entry = entry.saturating_add(1);
        *entry
    };

    let prompt = format!(
        r#"You are a background reviewer. Given this conversation turn summary, output ONLY valid JSON:
{{
  "save_memories": [{{"content":"...", "category":"general", "kind":"fact"}}],
  "patch_skill_id": null,
  "patch_old": null,
  "patch_new": null,
  "create_skill": null
}}

Rules:
- save_memories: 0-2 items for corrections, preferences, environment facts only.
- patch_skill_*: only if a loaded skill should get a small Pitfalls fix; use exact substring for patch_old.
- create_skill: only if a novel multi-step workflow succeeded (>= {} tool calls); set name + description.

Turn summary:
{}
Tool calls this turn: {}
"#,
        evo.create_skill_min_tool_calls, summary, tool_calls
    );

    let client = build_client_with_timeout(&provider, &api_key, base_url.as_deref(), 90);
    let req = LlmRequest {
        messages: vec![LlmMessage {
            role: "user".to_string(),
            content: MessageContent::Text(prompt),
        }],
        system: Some(
            "You output only valid JSON for skill/memory review decisions.".into(),
        ),
        tools: vec![],
        model: model.clone(),
        max_tokens: max_tokens.min(1024),
        stream: false,
        vision_override: None,
    };
    let Ok(resp) = client.complete(req).await else {
        return;
    };
    let text = resp.content;
    let json_start = text.find('{').unwrap_or(0);
    let json_end = text.rfind('}').map(|i| i + 1).unwrap_or(text.len());
    let Ok(decision) = serde_json::from_str::<ReviewDecision>(&text[json_start..json_end]) else {
        debug!("skill_review: failed to parse JSON");
        return;
    };

    let app_dir = state
        .app_handle
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| std::path::PathBuf::from(".piscis"));
    let root = service::skills_root_from_app_data(&app_dir);
    let session_ref = session_id.as_str();

    {
        let db = state.db.lock().await;
        for mem in decision.save_memories.iter().take(2) {
            let extras = crate::store::db::MemorySaveExtras {
                kind: mem.kind.clone(),
                evidence_session_id: Some(session_id.clone()),
                evidence_tool_use_id: None,
            };
            let _ = db.save_memory_structured(
                &mem.content,
                mem.category.as_deref().unwrap_or("general"),
                0.75,
                Some(&session_id),
                &memory_owner_id,
                "private",
                &memory_owner_id,
                None,
                extras,
            );
        }

        if let (Some(skill_id), Some(old), Some(new)) = (
            decision.patch_skill_id.as_deref(),
            decision.patch_old.as_deref(),
            decision.patch_new.as_deref(),
        ) {
            let _ = service::patch_skill_replace(
                &db,
                &root,
                skill_id,
                old,
                new,
                "background_review",
                Some(session_ref),
            );
        }

        if tool_calls >= evo.create_skill_min_tool_calls {
            let allow_umbrella = {
                let last = SESSION_LAST_UMBRELLA_TURN
                    .lock()
                    .unwrap_or_else(|e| e.into_inner());
                let prev = last.get(&session_id).copied().unwrap_or(0);
                turn_no.saturating_sub(prev) >= evo.umbrella_skill_interval_turns
            };
            if allow_umbrella {
                if let Some(create) = decision.create_skill {
                    let content = SKILL_TEMPLATE
                        .replace("{name}", &create.name)
                        .replace(
                            "{description}",
                            create.description.as_deref().unwrap_or(&create.name),
                        )
                        .replace("{title}", &create.name);
                    let _ = service::create_draft(
                        &db,
                        &root,
                        &create.name,
                        &content,
                        "background_review",
                        Some(session_ref),
                    );
                    SESSION_LAST_UMBRELLA_TURN
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .insert(session_id.clone(), turn_no);
                }
            }
        }
    }
}
