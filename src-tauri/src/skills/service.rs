//! Shared skill install / mutate / promote logic for Tauri commands and `skill_manage`.

use crate::skills::loader::SkillLoader;
use crate::skills::provenance::{self, SkillConfigMeta, LIFECYCLE_DRAFT, LIFECYCLE_LEARNED};
use crate::store::Database;
use anyhow::{Context, Result};
use std::path::{Path, PathBuf};

pub fn sanitize_skill_id(name: &str) -> String {
    name.chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect::<String>()
        .to_lowercase()
}

pub fn skills_root_from_app_data(app_data: &Path) -> PathBuf {
    provenance::skills_root(app_data)
}

pub fn load_meta(db: &Database, skill_id: &str) -> SkillConfigMeta {
    db.get_skill(skill_id)
        .ok()
        .flatten()
        .map(|s| SkillConfigMeta::from_json(&s.config))
        .unwrap_or_default()
}

pub fn write_guard(root: &Path, db: &Database, skill_id: &str) -> Result<SkillConfigMeta> {
    let meta = load_meta(db, skill_id);
    let hub_locked = provenance::is_hub_locked(root, skill_id);
    if !provenance::is_writable(&meta, hub_locked) {
        anyhow::bail!(
            "skill '{}' is not writable (lifecycle={}, locked={}, pinned={}, hub_locked={})",
            skill_id,
            meta.lifecycle,
            meta.locked,
            meta.pinned,
            hub_locked
        );
    }
    Ok(meta)
}

pub fn register_skill_db(
    db: &Database,
    skill_id: &str,
    name: &str,
    description: &str,
    meta: &SkillConfigMeta,
    created_by: Option<&str>,
) -> Result<()> {
    db.upsert_skill_with_config(skill_id, name, description, "📦", Some(&meta.to_json()))?;
    db.ensure_skill_usage(skill_id, created_by)?;
    Ok(())
}

pub fn install_to_installed(
    db: &Database,
    root: &Path,
    content: &str,
    source: &str,
    source_url: Option<String>,
    session_id: Option<String>,
) -> Result<(String, String)> {
    provenance::ensure_evolution_dirs(root)?;
    let loader = SkillLoader::new(root);
    let skill = loader
        .parse_skill_from_content(content)
        .context("parse SKILL.md")?;
    if skill.name.is_empty() || skill.name == "unnamed" {
        anyhow::bail!("SKILL.md must declare a name");
    }
    let skill_id = sanitize_skill_id(&skill.name);
    let meta = SkillConfigMeta::installed(source, source_url, session_id);
    register_skill_db(
        db,
        &skill_id,
        &skill.name,
        &skill.description,
        &meta,
        Some(source),
    )?;

    let skill_dir = provenance::installed_dir(root).join(&skill_id);
    std::fs::create_dir_all(&skill_dir)?;
    let skill_file = skill_dir.join("SKILL.md");
    std::fs::write(&skill_file, content)?;

    if source == "clawhub" {
        let _ = provenance::add_hub_lock(root, &skill_id);
    }
    Ok((skill_id, skill.name))
}

pub fn create_draft(
    db: &Database,
    root: &Path,
    name: &str,
    content: &str,
    created_by: &str,
    session_id: Option<&str>,
) -> Result<String> {
    provenance::ensure_evolution_dirs(root)?;
    let skill_id = sanitize_skill_id(name);
    if provenance::find_skill_md(root, &skill_id).is_some() {
        anyhow::bail!("skill '{}' already exists", skill_id);
    }
    let loader = SkillLoader::new(root);
    let parsed = loader.parse_skill_from_content(content).ok();
    let (display_name, description) = parsed
        .as_ref()
        .map(|s| (s.name.clone(), s.description.clone()))
        .unwrap_or_else(|| (name.to_string(), String::new()));

    let meta = SkillConfigMeta::draft(created_by, session_id.map(String::from));
    register_skill_db(
        db,
        &skill_id,
        &display_name,
        &description,
        &meta,
        Some(created_by),
    )?;

    let skill_dir = provenance::draft_dir(root).join(&skill_id);
    std::fs::create_dir_all(&skill_dir)?;
    std::fs::write(skill_dir.join("SKILL.md"), content)?;

    let before_hash: Option<&str> = None;
    let after_hash = provenance::content_hash(content);
    db.insert_skill_revision(
        &skill_id,
        session_id,
        created_by,
        Some("create"),
        before_hash,
        Some(&after_hash),
    )?;
    db.bump_skill_patch(&skill_id)?;
    Ok(skill_id)
}

pub fn patch_skill_content(
    db: &Database,
    root: &Path,
    skill_id: &str,
    new_content: &str,
    origin: &str,
    session_id: Option<&str>,
    diff_summary: Option<&str>,
) -> Result<()> {
    let _meta = write_guard(root, db, skill_id)?;
    let path = provenance::find_skill_md(root, skill_id)
        .ok_or_else(|| anyhow::anyhow!("skill '{}' not found on disk", skill_id))?;
    let before = std::fs::read_to_string(&path).unwrap_or_default();
    let before_hash = provenance::content_hash(&before);
    std::fs::write(&path, new_content)?;
    let after_hash = provenance::content_hash(new_content);
    db.insert_skill_revision(
        skill_id,
        session_id,
        origin,
        diff_summary,
        Some(&before_hash),
        Some(&after_hash),
    )?;
    db.bump_skill_patch(skill_id)?;
    Ok(())
}

pub fn patch_skill_replace(
    db: &Database,
    root: &Path,
    skill_id: &str,
    old_string: &str,
    new_string: &str,
    origin: &str,
    session_id: Option<&str>,
) -> Result<()> {
    let path = provenance::find_skill_md(root, skill_id)
        .ok_or_else(|| anyhow::anyhow!("skill '{}' not found", skill_id))?;
    let content = std::fs::read_to_string(&path)?;
    if !content.contains(old_string) {
        anyhow::bail!("old_string not found in skill content");
    }
    let new_content = content.replacen(old_string, new_string, 1);
    patch_skill_content(
        db,
        root,
        skill_id,
        &new_content,
        origin,
        session_id,
        Some(&format!("patch: {} → {}", old_string, new_string)),
    )
}

pub fn delete_draft(db: &Database, root: &Path, skill_id: &str) -> Result<()> {
    let meta = load_meta(db, skill_id);
    if meta.lifecycle != LIFECYCLE_DRAFT {
        anyhow::bail!("only draft skills can be deleted by agent");
    }
    if meta.pinned {
        anyhow::bail!("skill is pinned");
    }
    if let Some(path) = provenance::find_skill_md(root, skill_id) {
        if let Some(dir) = path.parent() {
            let _ = std::fs::remove_dir_all(dir);
        }
    }
    db.delete_skill(skill_id)?;
    Ok(())
}

pub fn promote_draft_to_learned(db: &Database, root: &Path, skill_id: &str) -> Result<()> {
    let meta = load_meta(db, skill_id);
    if meta.lifecycle != LIFECYCLE_DRAFT {
        anyhow::bail!("only draft skills can be promoted");
    }
    let src = provenance::draft_dir(root).join(skill_id);
    let dest = provenance::learned_dir(root).join(skill_id);
    if !src.exists() {
        anyhow::bail!("draft directory missing");
    }
    if dest.exists() {
        anyhow::bail!("learned skill '{}' already exists", skill_id);
    }
    std::fs::rename(&src, &dest)?;
    let new_meta = SkillConfigMeta::learned(&meta);
    if let Some(skill) = db.get_skill(skill_id)? {
        db.upsert_skill_with_config(
            skill_id,
            &skill.name,
            &skill.description,
            &skill.icon,
            Some(&new_meta.to_json()),
        )?;
    }
    db.set_skill_usage_state(skill_id, "active")?;
    Ok(())
}

pub fn set_skill_locked(db: &Database, skill_id: &str, locked: bool) -> Result<()> {
    let mut meta = load_meta(db, skill_id);
    meta.locked = locked;
    if let Some(skill) = db.get_skill(skill_id)? {
        db.update_skill_config(skill_id, &meta.to_json())?;
        db.upsert_skill_with_config(
            skill_id,
            &skill.name,
            &skill.description,
            &skill.icon,
            Some(&meta.to_json()),
        )?;
    }
    Ok(())
}

pub fn set_skill_pinned_db(db: &Database, skill_id: &str, pinned: bool) -> Result<()> {
    let mut meta = load_meta(db, skill_id);
    meta.pinned = pinned;
    if let Some(skill) = db.get_skill(skill_id)? {
        db.upsert_skill_with_config(
            skill_id,
            &skill.name,
            &skill.description,
            &skill.icon,
            Some(&meta.to_json()),
        )?;
    }
    db.set_skill_pinned(skill_id, pinned)?;
    Ok(())
}

pub fn archive_skill(db: &Database, root: &Path, skill_id: &str) -> Result<()> {
    let meta = load_meta(db, skill_id);
    if meta.pinned || meta.locked {
        anyhow::bail!("cannot archive locked or pinned skill");
    }
    let src = provenance::resolve_skill_dir(root, skill_id, &meta.lifecycle);
    if !src.exists() {
        anyhow::bail!("skill '{}' not found at {:?}", skill_id, src);
    }
    let dest = provenance::archive_dir(root).join(skill_id);
    if dest.exists() {
        let _ = std::fs::remove_dir_all(&dest);
    }
    std::fs::rename(&src, &dest)?;
    let mut new_meta = meta;
    new_meta.lifecycle = provenance::LIFECYCLE_ARCHIVED.to_string();
    if let Some(skill) = db.get_skill(skill_id)? {
        db.upsert_skill_with_config(
            skill_id,
            &skill.name,
            &skill.description,
            &skill.icon,
            Some(&new_meta.to_json()),
        )?;
    }
    db.set_skill_usage_state(skill_id, "archived")?;
    Ok(())
}

pub fn restore_archived(db: &Database, root: &Path, skill_id: &str) -> Result<()> {
    let src = provenance::archive_dir(root).join(skill_id);
    if !src.exists() {
        anyhow::bail!("archived skill not found");
    }
    let meta = load_meta(db, skill_id);
    let dest = provenance::resolve_skill_dir(
        root,
        skill_id,
        if meta.lifecycle == LIFECYCLE_LEARNED {
            LIFECYCLE_LEARNED
        } else {
            LIFECYCLE_DRAFT
        },
    );
    std::fs::rename(&src, &dest)?;
    let mut new_meta = meta;
    new_meta.lifecycle = if dest.to_string_lossy().contains("learned") {
        LIFECYCLE_LEARNED.to_string()
    } else {
        LIFECYCLE_DRAFT.to_string()
    };
    if let Some(skill) = db.get_skill(skill_id)? {
        db.upsert_skill_with_config(
            skill_id,
            &skill.name,
            &skill.description,
            &skill.icon,
            Some(&new_meta.to_json()),
        )?;
    }
    db.set_skill_usage_state(skill_id, "active")?;
    Ok(())
}

pub const SKILL_TEMPLATE: &str = r#"---
name: {name}
description: {description}
version: 1.0.0
---

# {title}

## When to Use
Describe when this skill applies.

## Procedure
1. Step one
2. Step two

## Pitfalls
- Known failure modes and fixes

## Verification
How to confirm the task succeeded.
"#;
