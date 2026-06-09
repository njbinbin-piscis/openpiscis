//! Autonomous skill library maintenance (stale/archive + LLM merge + backup/rollback).

use crate::skills::provenance;
use crate::skills::service;
use crate::store::AppState;
use chrono::{DateTime, Duration, Utc};
use piscis_kernel::llm::{build_client_with_timeout, LlmMessage, LlmRequest, MessageContent};
use piscis_kernel::store::SkillEvolutionSettings;
use serde::Deserialize;
use std::path::Path;
use tauri::Manager;
use tracing::{info, warn};

fn skills_root(state: &AppState) -> std::path::PathBuf {
    let app_dir = state
        .app_handle
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| std::path::PathBuf::from(".piscis"));
    service::skills_root_from_app_data(&app_dir)
}

fn copy_dir_all(src: &Path, dst: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let ty = entry.file_type()?;
        let dest = dst.join(entry.file_name());
        if ty.is_dir() {
            copy_dir_all(&entry.path(), &dest)?;
        } else {
            std::fs::copy(entry.path(), dest)?;
        }
    }
    Ok(())
}

fn backup_skills_tree(root: &Path) -> Result<String, String> {
    let ts = Utc::now().format("%Y%m%d-%H%M%S").to_string();
    let backup_dir = root.join(provenance::SUBDIR_CURATOR_BACKUPS).join(&ts);
    std::fs::create_dir_all(&backup_dir).map_err(|e| e.to_string())?;
    for sub in [
        provenance::SUBDIR_INSTALLED,
        provenance::SUBDIR_DRAFT,
        provenance::SUBDIR_LEARNED,
    ] {
        let p = root.join(sub);
        if p.exists() {
            copy_dir_all(&p, &backup_dir.join(sub)).map_err(|e| e.to_string())?;
        }
    }
    Ok(ts)
}

pub fn rollback_latest_backup(state: &AppState) -> Result<(), String> {
    let root = skills_root(state);
    let backups = root.join(provenance::SUBDIR_CURATOR_BACKUPS);
    if !backups.exists() {
        return Err("no curator backups".into());
    }
    let mut dirs: Vec<_> = std::fs::read_dir(&backups)
        .map_err(|e| e.to_string())?
        .flatten()
        .filter(|e| e.path().is_dir())
        .collect();
    dirs.sort_by_key(|e| e.file_name());
    let latest = dirs.pop().ok_or("no backup snapshots")?;
    for sub in [
        provenance::SUBDIR_INSTALLED,
        provenance::SUBDIR_DRAFT,
        provenance::SUBDIR_LEARNED,
    ] {
        let src = latest.path().join(sub);
        if !src.exists() {
            continue;
        }
        let dest = root.join(sub);
        if dest.exists() {
            let _ = std::fs::remove_dir_all(&dest);
        }
        copy_dir_all(&src, &dest).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn is_curator_managed(created_by: &str) -> bool {
    created_by == "agent" || created_by == "background_review"
}

fn last_activity_at(
    last_used: Option<DateTime<Utc>>,
    last_patched: Option<DateTime<Utc>>,
) -> Option<DateTime<Utc>> {
    match (last_used, last_patched) {
        (Some(u), Some(p)) => Some(if u > p { u } else { p }),
        (Some(u), None) => Some(u),
        (None, Some(p)) => Some(p),
        (None, None) => None,
    }
}

fn is_writable_curator_target(root: &Path, db: &crate::store::Database, skill_id: &str) -> bool {
    let meta = service::load_meta(db, skill_id);
    if meta.locked || meta.pinned {
        return false;
    }
    if provenance::is_hub_locked(root, skill_id) {
        return false;
    }
    matches!(
        meta.lifecycle.as_str(),
        provenance::LIFECYCLE_DRAFT | provenance::LIFECYCLE_LEARNED
    )
}

async fn mark_stale_skills(
    state: &AppState,
    cfg: &SkillEvolutionSettings,
    dry_run: bool,
) -> Result<u32, String> {
    let db = state.db.lock().await;
    let usage_list = db.list_skill_usage().map_err(|e| e.to_string())?;
    drop(db);

    let stale_cutoff = Utc::now() - Duration::days(cfg.stale_after_days as i64);
    let archive_cutoff = Utc::now() - Duration::days(cfg.archive_after_days as i64);
    let mut marked = 0u32;

    for u in usage_list {
        if u.pinned || u.state == "archived" {
            continue;
        }
        let created_by = u.created_by.as_deref().unwrap_or("");
        if !is_curator_managed(created_by) {
            continue;
        }
        let Some(last) = last_activity_at(u.last_used_at, u.last_patched_at) else {
            continue;
        };
        if last > stale_cutoff || last <= archive_cutoff {
            continue;
        }
        if dry_run {
            marked += 1;
            continue;
        }
        let db = state.db.lock().await;
        if db.set_skill_usage_state(&u.skill_id, "stale").is_ok() {
            marked += 1;
        }
    }
    Ok(marked)
}

async fn archive_stale_skills(
    state: &AppState,
    cfg: &SkillEvolutionSettings,
    dry_run: bool,
) -> Result<u32, String> {
    let root = skills_root(state);
    let db = state.db.lock().await;
    let usage_list = db.list_skill_usage().map_err(|e| e.to_string())?;
    drop(db);

    let archive_cutoff = Utc::now() - Duration::days(cfg.archive_after_days as i64);
    let mut archived = 0u32;

    for u in usage_list {
        if u.pinned {
            continue;
        }
        let created_by = u.created_by.as_deref().unwrap_or("");
        if !is_curator_managed(created_by) {
            continue;
        }
        let Some(last) = last_activity_at(u.last_used_at, u.last_patched_at) else {
            continue;
        };
        if last > archive_cutoff {
            continue;
        }
        if dry_run {
            archived += 1;
            continue;
        }
        let db = state.db.lock().await;
        if service::archive_skill(&db, &root, &u.skill_id).is_ok() {
            archived += 1;
        }
    }
    Ok(archived)
}

struct DraftCatalogEntry {
    skill_id: String,
    name: String,
    lifecycle: String,
    excerpt: String,
}

fn list_curator_candidates(root: &Path, db: &crate::store::Database) -> Vec<DraftCatalogEntry> {
    let mut out = Vec::new();
    for (dir, lifecycle) in [
        (provenance::draft_dir(root), provenance::LIFECYCLE_DRAFT),
        (provenance::learned_dir(root), provenance::LIFECYCLE_LEARNED),
    ] {
        if !dir.exists() {
            continue;
        }
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let skill_id = entry.file_name().to_string_lossy().to_string();
            let usage = db.get_skill_usage(&skill_id).ok().flatten();
            let created_by = usage
                .as_ref()
                .and_then(|u| u.created_by.as_deref())
                .unwrap_or("");
            if !is_curator_managed(created_by) {
                continue;
            }
            if !is_writable_curator_target(root, db, &skill_id) {
                continue;
            }
            let skill_md = path.join("SKILL.md");
            let content = std::fs::read_to_string(&skill_md).unwrap_or_default();
            let name = db
                .get_skill(&skill_id)
                .ok()
                .flatten()
                .map(|s| s.name)
                .unwrap_or_else(|| skill_id.clone());
            let excerpt: String = content.chars().take(600).collect();
            out.push(DraftCatalogEntry {
                skill_id,
                name,
                lifecycle: lifecycle.to_string(),
                excerpt,
            });
        }
    }
    out
}

#[derive(Debug, Deserialize)]
struct CuratorLlmDecision {
    #[serde(default)]
    merges: Vec<CuratorMerge>,
    #[serde(default)]
    drift_patches: Vec<CuratorDriftPatch>,
}

#[derive(Debug, Deserialize)]
struct CuratorMerge {
    keep_skill_id: String,
    #[serde(default)]
    merge_skill_ids: Vec<String>,
    #[serde(default)]
    pitfalls_append: Option<String>,
}

#[derive(Debug, Deserialize)]
struct CuratorDriftPatch {
    skill_id: String,
    patch_old: String,
    patch_new: String,
}

async fn llm_merge_duplicates(
    state: &AppState,
    cfg: &SkillEvolutionSettings,
    dry_run: bool,
) -> Result<(u32, u32), String> {
    if !cfg.curator_llm_merge_enabled {
        return Ok((0, 0));
    }

    let (provider, api_key, base_url, model, max_tokens) = {
        let s = state.settings.lock().await;
        (
            s.provider.clone(),
            s.active_api_key().to_string(),
            s.custom_base_url.clone(),
            s.model.clone(),
            s.max_tokens,
        )
    };
    if api_key.is_empty() {
        warn!("curator LLM merge skipped: no API key");
        return Ok((0, 0));
    }

    let root = skills_root(state);
    let catalog = {
        let db = state.db.lock().await;
        list_curator_candidates(&root, &db)
    };
    if catalog.len() < 2 {
        return Ok((0, 0));
    }

    let catalog_text: String = catalog
        .iter()
        .take(24)
        .map(|c| {
            format!(
                "- id={} name={} lifecycle={}\n  excerpt: {}",
                c.skill_id,
                c.name,
                c.lifecycle,
                c.excerpt.replace('\n', " ")
            )
        })
        .collect::<Vec<_>>()
        .join("\n");

    let prompt = format!(
        r#"You are the Pisci skill curator. Review agent-created draft/learned skills and output ONLY valid JSON:
{{
  "merges": [
    {{
      "keep_skill_id": "id-to-keep",
      "merge_skill_ids": ["duplicate-id-1"],
      "pitfalls_append": "optional bullet to append to Pitfalls section of kept skill"
    }}
  ],
  "drift_patches": [
    {{
      "skill_id": "id",
      "patch_old": "exact substring",
      "patch_new": "replacement"
    }}
  ]
}}

Rules:
- merges: only near-duplicate skills covering the same workflow; keep the better-named one.
- merge_skill_ids must NOT include keep_skill_id.
- drift_patches: small fixes for outdated Pitfalls (exact substring match).
- Never reference installed/builtin skills.
- If nothing to do, return empty arrays.

Skills:
{}
"#,
        catalog_text
    );

    let client = build_client_with_timeout(
        &provider,
        &api_key,
        if base_url.is_empty() {
            None
        } else {
            Some(base_url.as_str())
        },
        120,
    );
    let req = LlmRequest {
        messages: vec![LlmMessage {
            role: "user".to_string(),
            content: MessageContent::Text(prompt),
        }],
        system: Some("You output only valid JSON for curator skill maintenance.".into()),
        tools: vec![],
        model: model.clone(),
        max_tokens: max_tokens.min(2048),
        stream: false,
        vision_override: None,
    };
    let Ok(resp) = client.complete(req).await else {
        warn!("curator LLM merge: completion failed");
        return Ok((0, 0));
    };
    let text = resp.content;
    let json_start = text.find('{').unwrap_or(0);
    let json_end = text.rfind('}').map(|i| i + 1).unwrap_or(text.len());
    let Ok(decision) = serde_json::from_str::<CuratorLlmDecision>(&text[json_start..json_end])
    else {
        warn!("curator LLM merge: failed to parse JSON");
        return Ok((0, 0));
    };

    if dry_run {
        let merges = decision.merges.len() as u32;
        let patches = decision.drift_patches.len() as u32;
        return Ok((merges, patches));
    }

    let mut merged = 0u32;
    let mut patched = 0u32;
    let db = state.db.lock().await;

    for m in decision.merges {
        if m.merge_skill_ids.is_empty() {
            continue;
        }
        if !is_writable_curator_target(&root, &db, &m.keep_skill_id) {
            continue;
        }
        let keep_path = provenance::find_skill_md(&root, &m.keep_skill_id);
        let Some(keep_path) = keep_path else {
            continue;
        };
        let mut content = std::fs::read_to_string(&keep_path).unwrap_or_default();
        if let Some(note) = m
            .pitfalls_append
            .as_deref()
            .filter(|s| !s.trim().is_empty())
        {
            if content.contains("## Pitfalls") {
                content.push_str(&format!("\n- {}\n", note.trim()));
            } else {
                content.push_str(&format!("\n\n## Pitfalls\n- {}\n", note.trim()));
            }
        }
        for dup_id in &m.merge_skill_ids {
            if dup_id == &m.keep_skill_id {
                continue;
            }
            if !is_writable_curator_target(&root, &db, dup_id) {
                continue;
            }
            if let Some(dup_path) = provenance::find_skill_md(&root, dup_id) {
                let dup_body = std::fs::read_to_string(&dup_path).unwrap_or_default();
                let note: String = dup_body.chars().take(200).collect();
                content.push_str(&format!("\n\n<!-- merged from {} -->\n{}\n", dup_id, note));
            }
            let meta = service::load_meta(&db, dup_id);
            let result = if meta.lifecycle == provenance::LIFECYCLE_DRAFT {
                service::delete_draft(&db, &root, dup_id)
            } else {
                service::archive_skill(&db, &root, dup_id)
            };
            if result.is_ok() {
                merged += 1;
            }
        }
        if service::patch_skill_content(
            &db,
            &root,
            &m.keep_skill_id,
            &content,
            "curator",
            None,
            Some("LLM merge duplicates"),
        )
        .is_ok()
        {
            merged += 1;
        }
    }

    for p in decision.drift_patches {
        if !is_writable_curator_target(&root, &db, &p.skill_id) {
            continue;
        }
        if service::patch_skill_replace(
            &db,
            &root,
            &p.skill_id,
            &p.patch_old,
            &p.patch_new,
            "curator",
            None,
        )
        .is_ok()
        {
            patched += 1;
        }
    }

    Ok((merged, patched))
}

pub async fn run_curator_pass(state: &AppState, dry_run: bool) -> Result<String, String> {
    let cfg = {
        let s = state.settings.lock().await;
        s.skill_evolution.clone()
    };
    let root = skills_root(state);
    provenance::ensure_evolution_dirs(&root).map_err(|e| e.to_string())?;

    if !dry_run {
        let ts = backup_skills_tree(&root)?;
        info!("curator backup written: {}", ts);
    }

    let stale = mark_stale_skills(state, &cfg, dry_run).await?;
    let archived = archive_stale_skills(state, &cfg, dry_run).await?;
    let (merged, patched) = llm_merge_duplicates(state, &cfg, dry_run).await?;

    if !dry_run {
        let marker = root.join(".curator_last_run");
        std::fs::write(&marker, Utc::now().to_rfc3339()).map_err(|e| e.to_string())?;
        let report_dir = state
            .app_handle
            .path()
            .app_data_dir()
            .unwrap_or_else(|_| std::path::PathBuf::from(".piscis"))
            .join("logs")
            .join("curator")
            .join(Utc::now().format("%Y%m%d-%H%M%S").to_string());
        std::fs::create_dir_all(&report_dir).ok();
        let report = format!(
            "# Curator Report\n\n- stale_marked: {}\n- archived: {}\n- llm_merged: {}\n- llm_patched: {}\n- dry_run: {}\n",
            stale, archived, merged, patched, dry_run
        );
        let _ = std::fs::write(report_dir.join("REPORT.md"), &report);
        let _ = std::fs::write(
            report_dir.join("run.json"),
            serde_json::json!({
                "stale_marked": stale,
                "archived": archived,
                "llm_merged": merged,
                "llm_patched": patched,
                "dry_run": dry_run,
            })
            .to_string(),
        );
    }

    Ok(format!(
        "curator complete: stale={} archived={} merged={} patched={} dry_run={}",
        stale, archived, merged, patched, dry_run
    ))
}

pub async fn maybe_run_curator_idle(state: &AppState) {
    let cfg = {
        let s = state.settings.lock().await;
        s.skill_evolution.clone()
    };
    let root = skills_root(state);
    let marker = root.join(".curator_last_run");
    let last = std::fs::read_to_string(&marker)
        .ok()
        .and_then(|s| s.parse::<chrono::DateTime<Utc>>().ok());
    let interval = Duration::hours(cfg.curator_interval_hours as i64);
    let due = match last {
        None => false,
        Some(t) => Utc::now().signed_duration_since(t) > interval,
    };
    if !due {
        return;
    }
    let idle_ok = {
        let db = state.db.lock().await;
        db.is_system_idle_for_hours(cfg.curator_min_idle_hours)
            .unwrap_or(false)
    };
    if !idle_ok {
        return;
    }
    let _ = run_curator_pass(state, false).await;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn curator_managed_sources() {
        assert!(is_curator_managed("agent"));
        assert!(is_curator_managed("background_review"));
        assert!(!is_curator_managed("clawhub"));
    }
}
