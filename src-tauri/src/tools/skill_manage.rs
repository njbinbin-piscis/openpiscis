use crate::skills::loader::SkillLoader;
use crate::skills::provenance;
use crate::skills::service::{self, SKILL_TEMPLATE};
use crate::store::Database;
use async_trait::async_trait;
use piscis_kernel::agent::tool::{Tool, ToolContext, ToolResult};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::sync::Mutex;

pub struct SkillManageTool {
    pub db: Arc<Mutex<Database>>,
    pub app_data_dir: PathBuf,
    pub loader: Arc<Mutex<SkillLoader>>,
}

/// Resolve `file_path` against the skill `base` dir, rejecting any path that
/// escapes the base (e.g. `../../installed/foo/SKILL.md`). This is a hard
/// guard so `write_file`/`remove_file` can never reach a locked skill even
/// when the agent-supplied skill_id itself is a writable draft.
fn safe_join(base: &Path, file_path: &str) -> anyhow::Result<PathBuf> {
    let rel = Path::new(file_path);
    if rel.is_absolute() {
        anyhow::bail!("file_path must be relative");
    }
    let mut resolved = base.to_path_buf();
    for comp in rel.components() {
        use std::path::Component;
        match comp {
            Component::Normal(seg) => resolved.push(seg),
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                anyhow::bail!("file_path must not traverse outside the skill directory");
            }
        }
    }
    Ok(resolved)
}

#[async_trait]
impl Tool for SkillManageTool {
    fn name(&self) -> &str {
        "skill_manage"
    }

    fn description(&self) -> &str {
        "Create, patch, or delete agent-learned skills (draft/learned only). \
         Installed and locked skills cannot be modified. \
         Actions: create, patch, edit, delete, list, write_file, remove_file."
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "action": {
                    "type": "string",
                    "enum": ["create", "patch", "edit", "delete", "list", "write_file", "remove_file"],
                    "description": "Operation to perform"
                },
                "name": { "type": "string", "description": "Skill id / directory name" },
                "content": { "type": "string", "description": "Full SKILL.md for create/edit" },
                "old_string": { "type": "string", "description": "Substring to replace (patch)" },
                "new_string": { "type": "string", "description": "Replacement text (patch)" },
                "file_path": { "type": "string", "description": "Relative path under skill dir (write_file/remove_file)" },
                "file_content": { "type": "string", "description": "File body for write_file" },
                "description": { "type": "string", "description": "Short description for create" },
                "category": { "type": "string", "description": "Optional category label" }
            },
            "required": ["action"]
        })
    }

    async fn call(&self, input: Value, ctx: &ToolContext) -> anyhow::Result<ToolResult> {
        let action = input["action"].as_str().unwrap_or("").trim();
        let root = service::skills_root_from_app_data(&self.app_data_dir);
        let session_id = Some(ctx.session_id.as_str());

        match action {
            "list" => {
                let loader = self.loader.lock().await;
                let skills = loader.list_skills();
                let lines: Vec<String> = skills
                    .iter()
                    .map(|s| {
                        format!(
                            "- {} [{}] locked={} — {}",
                            s.skill_id, s.lifecycle, s.locked, s.description
                        )
                    })
                    .collect();
                Ok(ToolResult::ok(if lines.is_empty() {
                    "No skills.".to_string()
                } else {
                    lines.join("\n")
                }))
            }
            "create" => {
                let name = input["name"]
                    .as_str()
                    .ok_or_else(|| anyhow::anyhow!("name required"))?;
                let description = input["description"].as_str().unwrap_or(name);
                let content = input["content"].as_str().map(String::from).unwrap_or_else(|| {
                    SKILL_TEMPLATE
                        .replace("{name}", name)
                        .replace("{description}", description)
                        .replace("{title}", name)
                });
                let db = self.db.lock().await;
                let id = service::create_draft(
                    &db,
                    &root,
                    name,
                    &content,
                    "agent",
                    session_id,
                )?;
                drop(db);
                let _ = self.loader.lock().await.load_all();
                Ok(ToolResult::ok(format!("Created draft skill '{}'", id)))
            }
            "edit" => {
                let name = input["name"]
                    .as_str()
                    .ok_or_else(|| anyhow::anyhow!("name required"))?;
                let content = input["content"]
                    .as_str()
                    .ok_or_else(|| anyhow::anyhow!("content required"))?;
                let skill_id = service::sanitize_skill_id(name);
                let db = self.db.lock().await;
                service::patch_skill_content(&db, &root, &skill_id, content, "agent", session_id, Some("edit"))?;
                drop(db);
                let _ = self.loader.lock().await.load_all();
                Ok(ToolResult::ok(format!("Updated skill '{}'", skill_id)))
            }
            "patch" => {
                let name = input["name"]
                    .as_str()
                    .ok_or_else(|| anyhow::anyhow!("name required"))?;
                let old_string = input["old_string"]
                    .as_str()
                    .ok_or_else(|| anyhow::anyhow!("old_string required"))?;
                let new_string = input["new_string"]
                    .as_str()
                    .ok_or_else(|| anyhow::anyhow!("new_string required"))?;
                let skill_id = service::sanitize_skill_id(name);
                let db = self.db.lock().await;
                service::patch_skill_replace(
                    &db,
                    &root,
                    &skill_id,
                    old_string,
                    new_string,
                    "agent",
                    session_id,
                )?;
                drop(db);
                let _ = self.loader.lock().await.load_all();
                Ok(ToolResult::ok(format!("Patched skill '{}'", skill_id)))
            }
            "delete" => {
                let name = input["name"]
                    .as_str()
                    .ok_or_else(|| anyhow::anyhow!("name required"))?;
                let skill_id = service::sanitize_skill_id(name);
                let db = self.db.lock().await;
                service::delete_draft(&db, &root, &skill_id)?;
                drop(db);
                let _ = self.loader.lock().await.load_all();
                Ok(ToolResult::ok(format!("Deleted draft '{}'", skill_id)))
            }
            "write_file" => {
                let name = input["name"]
                    .as_str()
                    .ok_or_else(|| anyhow::anyhow!("name required"))?;
                let file_path = input["file_path"]
                    .as_str()
                    .ok_or_else(|| anyhow::anyhow!("file_path required"))?;
                let file_content = input["file_content"].as_str().unwrap_or("");
                let skill_id = service::sanitize_skill_id(name);
                let db = self.db.lock().await;
                let _meta = service::write_guard(&root, &db, &skill_id)?;
                let base = provenance::find_skill_md(&root, &skill_id)
                    .and_then(|p| p.parent().map(|d| d.to_path_buf()))
                    .ok_or_else(|| anyhow::anyhow!("skill not found"))?;
                let target = safe_join(&base, file_path)?;
                if let Some(parent) = target.parent() {
                    std::fs::create_dir_all(parent)?;
                }
                let before = std::fs::read_to_string(&target).unwrap_or_default();
                std::fs::write(&target, file_content)?;
                let before_hash = provenance::content_hash(&before);
                let after_hash = provenance::content_hash(file_content);
                db.insert_skill_revision(
                    &skill_id,
                    session_id,
                    "agent",
                    Some(&format!("write_file: {}", file_path)),
                    Some(&before_hash),
                    Some(&after_hash),
                )?;
                db.bump_skill_patch(&skill_id)?;
                drop(db);
                Ok(ToolResult::ok(format!("Wrote {}", file_path)))
            }
            "remove_file" => {
                let name = input["name"]
                    .as_str()
                    .ok_or_else(|| anyhow::anyhow!("name required"))?;
                let file_path = input["file_path"]
                    .as_str()
                    .ok_or_else(|| anyhow::anyhow!("file_path required"))?;
                let skill_id = service::sanitize_skill_id(name);
                let db = self.db.lock().await;
                let _meta = service::write_guard(&root, &db, &skill_id)?;
                let base = provenance::find_skill_md(&root, &skill_id)
                    .and_then(|p| p.parent().map(|d| d.to_path_buf()))
                    .ok_or_else(|| anyhow::anyhow!("skill not found"))?;
                let target = safe_join(&base, file_path)?;
                if target.exists() {
                    std::fs::remove_file(&target)?;
                }
                db.insert_skill_revision(
                    &skill_id,
                    session_id,
                    "agent",
                    Some(&format!("remove_file: {}", file_path)),
                    None,
                    None,
                )?;
                drop(db);
                Ok(ToolResult::ok(format!("Removed {}", file_path)))
            }
            other => Ok(ToolResult::err(format!("Unknown action: {}", other))),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn safe_join_allows_nested_relative() {
        let base = Path::new("/skills/.draft/foo");
        let p = safe_join(base, "references/notes.md").unwrap();
        assert!(p.ends_with(".draft/foo/references/notes.md"));
    }

    #[test]
    fn safe_join_rejects_traversal() {
        let base = Path::new("/skills/.draft/foo");
        assert!(safe_join(base, "../../installed/bar/SKILL.md").is_err());
        assert!(safe_join(base, "/etc/passwd").is_err());
    }
}
