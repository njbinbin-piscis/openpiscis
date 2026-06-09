//! Skill lifecycle, paths, and write-guard policy for the evolution system.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

pub const LIFECYCLE_BUILTIN: &str = "builtin";
pub const LIFECYCLE_INSTALLED: &str = "installed";
pub const LIFECYCLE_DRAFT: &str = "draft";
pub const LIFECYCLE_LEARNED: &str = "learned";
pub const LIFECYCLE_ARCHIVED: &str = "archived";

pub const SUBDIR_INSTALLED: &str = "installed";
pub const SUBDIR_DRAFT: &str = ".draft";
pub const SUBDIR_LEARNED: &str = "learned";
pub const SUBDIR_ARCHIVE: &str = ".archive";
pub const SUBDIR_CURATOR_BACKUPS: &str = ".curator_backups";
pub const SUBDIR_HUB: &str = ".hub";

const BUILTIN_IDS: &[&str] = &[
    "office-automation",
    "file-management",
    "web-automation",
    "system-admin",
    "desktop-control",
];

/// JSON stored in `skills.config` column.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct SkillConfigMeta {
    #[serde(default = "default_lifecycle_installed")]
    pub lifecycle: String,
    #[serde(default = "default_locked_true")]
    pub locked: bool,
    #[serde(default)]
    pub pinned: bool,
    #[serde(default)]
    pub source: Option<String>,
    #[serde(default)]
    pub source_url: Option<String>,
    #[serde(default)]
    pub installed_from_session_id: Option<String>,
    #[serde(default)]
    pub promoted_at: Option<String>,
}

fn default_lifecycle_installed() -> String {
    LIFECYCLE_INSTALLED.to_string()
}

fn default_locked_true() -> bool {
    true
}

impl SkillConfigMeta {
    pub fn installed(source: &str, source_url: Option<String>, session_id: Option<String>) -> Self {
        Self {
            lifecycle: LIFECYCLE_INSTALLED.to_string(),
            locked: true,
            pinned: false,
            source: Some(source.to_string()),
            source_url,
            installed_from_session_id: session_id,
            promoted_at: None,
        }
    }

    pub fn draft(created_by: &str, session_id: Option<String>) -> Self {
        Self {
            lifecycle: LIFECYCLE_DRAFT.to_string(),
            locked: false,
            pinned: false,
            source: Some(created_by.to_string()),
            source_url: None,
            installed_from_session_id: session_id,
            promoted_at: None,
        }
    }

    pub fn learned(from_draft: &Self) -> Self {
        let mut m = from_draft.clone();
        m.lifecycle = LIFECYCLE_LEARNED.to_string();
        m.promoted_at = Some(chrono::Utc::now().to_rfc3339());
        m
    }

    pub fn builtin() -> Self {
        Self {
            lifecycle: LIFECYCLE_BUILTIN.to_string(),
            locked: true,
            pinned: true,
            source: Some("builtin".to_string()),
            ..Default::default()
        }
    }

    pub fn to_json(&self) -> String {
        serde_json::to_string(self).unwrap_or_else(|_| "{}".to_string())
    }

    pub fn from_json(s: &str) -> Self {
        serde_json::from_str(s).unwrap_or_default()
    }
}

pub fn skills_root(app_data: &Path) -> PathBuf {
    app_data.join("skills")
}

pub fn installed_dir(root: &Path) -> PathBuf {
    root.join(SUBDIR_INSTALLED)
}

pub fn draft_dir(root: &Path) -> PathBuf {
    root.join(SUBDIR_DRAFT)
}

pub fn learned_dir(root: &Path) -> PathBuf {
    root.join(SUBDIR_LEARNED)
}

pub fn archive_dir(root: &Path) -> PathBuf {
    root.join(SUBDIR_ARCHIVE)
}

pub fn hub_lock_path(root: &Path) -> PathBuf {
    root.join(SUBDIR_HUB).join("lock.json")
}

pub fn ensure_evolution_dirs(root: &Path) -> std::io::Result<()> {
    for d in [
        root,
        &installed_dir(root),
        &draft_dir(root),
        &learned_dir(root),
        &archive_dir(root),
        &root.join(SUBDIR_CURATOR_BACKUPS),
        &root.join(SUBDIR_HUB),
    ] {
        std::fs::create_dir_all(d)?;
    }
    Ok(())
}

pub fn is_builtin_dir_name(name: &str) -> bool {
    BUILTIN_IDS.contains(&name)
}

pub fn infer_lifecycle_from_path(_skills_root: &Path, skill_md: &Path) -> String {
    let path_str = skill_md.to_string_lossy();
    if path_str.contains("/.draft/") || path_str.contains("\\.draft\\") {
        return LIFECYCLE_DRAFT.to_string();
    }
    if path_str.contains("/learned/") || path_str.contains("\\learned\\") {
        return LIFECYCLE_LEARNED.to_string();
    }
    if path_str.contains("/installed/") || path_str.contains("\\installed\\") {
        return LIFECYCLE_INSTALLED.to_string();
    }
    if path_str.contains("/.archive/") || path_str.contains("\\.archive\\") {
        return LIFECYCLE_ARCHIVED.to_string();
    }
    let dir_name = skill_md
        .parent()
        .and_then(|p| p.file_name())
        .and_then(|n| n.to_str())
        .unwrap_or("");
    if is_builtin_dir_name(dir_name) {
        LIFECYCLE_BUILTIN.to_string()
    } else {
        LIFECYCLE_INSTALLED.to_string()
    }
}

pub fn resolve_skill_dir(root: &Path, skill_id: &str, lifecycle: &str) -> PathBuf {
    match lifecycle {
        LIFECYCLE_DRAFT => draft_dir(root).join(skill_id),
        LIFECYCLE_LEARNED => learned_dir(root).join(skill_id),
        LIFECYCLE_ARCHIVED => archive_dir(root).join(skill_id),
        LIFECYCLE_INSTALLED => installed_dir(root).join(skill_id),
        _ => {
            if is_builtin_dir_name(skill_id) {
                root.join(skill_id)
            } else {
                installed_dir(root).join(skill_id)
            }
        }
    }
}

pub fn find_skill_md(root: &Path, skill_id: &str) -> Option<PathBuf> {
    let candidates = [
        draft_dir(root).join(skill_id).join("SKILL.md"),
        learned_dir(root).join(skill_id).join("SKILL.md"),
        installed_dir(root).join(skill_id).join("SKILL.md"),
        root.join(skill_id).join("SKILL.md"),
        archive_dir(root).join(skill_id).join("SKILL.md"),
    ];
    candidates.into_iter().find(|p| p.exists())
}

/// Returns whether an agent/tool may mutate this skill on disk.
pub fn is_writable(meta: &SkillConfigMeta, hub_locked: bool) -> bool {
    if hub_locked {
        return false;
    }
    if meta.locked || meta.pinned {
        return false;
    }
    matches!(meta.lifecycle.as_str(), LIFECYCLE_DRAFT | LIFECYCLE_LEARNED)
}

pub fn is_hub_locked(root: &Path, skill_id: &str) -> bool {
    let lock_path = hub_lock_path(root);
    if !lock_path.exists() {
        return false;
    }
    let Ok(raw) = std::fs::read_to_string(&lock_path) else {
        return false;
    };
    let Ok(ids) = serde_json::from_str::<Vec<String>>(&raw) else {
        return false;
    };
    ids.iter().any(|id| id == skill_id)
}

pub fn add_hub_lock(root: &Path, skill_id: &str) -> std::io::Result<()> {
    std::fs::create_dir_all(root.join(SUBDIR_HUB))?;
    let lock_path = hub_lock_path(root);
    let mut ids: Vec<String> = if lock_path.exists() {
        serde_json::from_str(&std::fs::read_to_string(&lock_path)?).unwrap_or_default()
    } else {
        vec![]
    };
    if !ids.iter().any(|id| id == skill_id) {
        ids.push(skill_id.to_string());
        std::fs::write(
            &lock_path,
            serde_json::to_string_pretty(&ids).unwrap_or_default(),
        )?;
    }
    Ok(())
}

/// One-time migration: move flat `skills/{name}/` → `skills/installed/{name}/`.
pub fn migrate_flat_skills_to_installed(root: &Path) -> std::io::Result<u32> {
    ensure_evolution_dirs(root)?;
    let marker = root.join(".migrated_to_quadrants");
    if marker.exists() {
        return Ok(0);
    }
    let mut moved = 0u32;
    let entries = std::fs::read_dir(root)?;
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.')
            || name == SUBDIR_INSTALLED
            || name == SUBDIR_LEARNED
            || is_builtin_dir_name(&name)
        {
            continue;
        }
        let skill_md = path.join("SKILL.md");
        if !skill_md.exists() {
            continue;
        }
        let dest_parent = installed_dir(root).join(&name);
        if dest_parent.exists() {
            continue;
        }
        std::fs::rename(&path, &dest_parent)?;
        moved += 1;
    }
    std::fs::write(&marker, format!("migrated {} skills\n", moved))?;
    Ok(moved)
}

pub fn content_hash(content: &str) -> String {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    let mut h = DefaultHasher::new();
    content.hash(&mut h);
    format!("{:016x}", h.finish())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn is_writable_matrix() {
        let draft = SkillConfigMeta::draft("agent", None);
        assert!(is_writable(&draft, false));
        assert!(!is_writable(&draft, true));

        let installed = SkillConfigMeta::installed("clawhub", None, None);
        assert!(!is_writable(&installed, false));
        assert!(!is_writable(&installed, true));

        let mut learned = draft.clone();
        learned.lifecycle = LIFECYCLE_LEARNED.to_string();
        assert!(is_writable(&learned, false));

        let mut pinned = learned.clone();
        pinned.pinned = true;
        assert!(!is_writable(&pinned, false));
    }

    #[test]
    fn resolve_skill_dir_paths() {
        let root = std::path::Path::new("/tmp/skills");
        assert!(resolve_skill_dir(root, "foo", LIFECYCLE_DRAFT).ends_with(".draft/foo"));
        assert!(resolve_skill_dir(root, "foo", LIFECYCLE_LEARNED).ends_with("learned/foo"));
        assert!(resolve_skill_dir(root, "foo", LIFECYCLE_INSTALLED).ends_with("installed/foo"));
    }

    #[test]
    fn hub_lock_roundtrip() {
        let root = std::env::temp_dir().join(format!("pisci-prov-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        add_hub_lock(&root, "my-skill").unwrap();
        assert!(is_hub_locked(&root, "my-skill"));
        assert!(!is_hub_locked(&root, "other"));
        let _ = std::fs::remove_dir_all(&root);
    }
}
