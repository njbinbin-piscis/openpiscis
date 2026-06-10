//! OpenAI `skills/.curated` registry — git-subdir skill bundle install.
//!
//! Lists curated skills from `openai/skills` via tarball extraction and installs
//! full skill directories (including scripts/references/assets).

use crate::commands::config::skills::SkillCatalogItem;
use crate::skills::loader::{check_skill_compatibility, SkillLoader};
use crate::store::AppState;
use flate2::read::GzDecoder;
use serde::Serialize;
use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use tauri::Manager;
use tauri::State;
use tracing::info;

const REPO_TARBALL_URL: &str = "https://codeload.github.com/openai/skills/tar.gz/main";
const CURATED_SEGMENT: &str = "skills/.curated/";
const SOURCE_ID: &str = "openai-curated";
const GITHUB_TREE_BASE: &str = "https://github.com/openai/skills/tree/main/skills/.curated";

#[derive(Debug, Clone, Serialize)]
pub struct OpenAISkillListItem {
    pub id: String,
    pub name: String,
    pub description: String,
    pub dir_name: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct OpenAISkillPreview {
    pub dir_name: String,
    pub name: String,
    pub description: String,
    pub version: String,
}

#[derive(Debug, Serialize)]
pub struct OpenAISkillListResult {
    pub items: Vec<OpenAISkillListItem>,
    pub total: usize,
    pub query: String,
}

#[derive(Debug, Serialize)]
pub struct OpenAISkillDetail {
    pub skill: OpenAISkillListItem,
    pub preview: OpenAISkillPreview,
}

#[derive(Debug, Serialize)]
pub struct OpenAISkillInstallResult {
    pub installed: Vec<SkillCatalogItem>,
    pub skipped: Vec<String>,
    pub errors: Vec<String>,
}

struct TarballIndex {
    root_prefix: String,
    files: HashMap<String, Vec<u8>>,
}

async fn http_get_with_retry(
    client: &reqwest::Client,
    url: &str,
    max_retries: u32,
) -> Result<reqwest::Response, String> {
    let mut attempt = 0u32;
    loop {
        let resp = client
            .get(url)
            .header("Accept", "application/json")
            .send()
            .await
            .map_err(|e| format!("网络请求失败：{}", e))?;
        let status = resp.status();
        if status.is_success() || (status.is_client_error() && status.as_u16() != 429) {
            return Ok(resp);
        }
        if attempt >= max_retries {
            return Ok(resp);
        }
        let delay_ms = 1000u64.saturating_mul(1 << attempt.min(4));
        tokio::time::sleep(std::time::Duration::from_millis(delay_ms)).await;
        attempt += 1;
    }
}

async fn fetch_curated_tarball(client: &reqwest::Client) -> Result<Vec<u8>, String> {
    info!("Fetching openai/skills tarball");
    let resp = http_get_with_retry(client, REPO_TARBALL_URL, 3).await?;
    if !resp.status().is_success() {
        return Err(format!(
            "无法下载 OpenAI skills 仓库（HTTP {}）",
            resp.status()
        ));
    }
    resp.bytes()
        .await
        .map(|b| b.to_vec())
        .map_err(|e| format!("读取 tarball 失败：{}", e))
}

fn index_tarball(bytes: &[u8]) -> Result<TarballIndex, String> {
    let decoder = GzDecoder::new(bytes);
    let mut archive = tar::Archive::new(decoder);
    let mut files = HashMap::new();
    let mut root_prefix = String::new();

    for entry in archive
        .entries()
        .map_err(|e| format!("tar 解析失败：{}", e))?
    {
        let mut entry = entry.map_err(|e| format!("tar entry 失败：{}", e))?;
        let path = entry
            .path()
            .map_err(|e| format!("tar path 失败：{}", e))?
            .to_string_lossy()
            .replace('\\', "/");
        if root_prefix.is_empty() && path.contains('/') {
            root_prefix = path.split('/').next().unwrap_or("").to_string() + "/";
        }
        if entry.header().entry_type().is_dir() {
            continue;
        }
        let mut buf = Vec::new();
        entry
            .read_to_end(&mut buf)
            .map_err(|e| format!("读取 tar 文件失败：{}", e))?;
        files.insert(path, buf);
    }

    if root_prefix.is_empty() {
        return Err("tarball 根目录前缀未知".to_string());
    }
    Ok(TarballIndex { root_prefix, files })
}

fn curated_prefix(index: &TarballIndex) -> String {
    format!("{}{}", index.root_prefix, CURATED_SEGMENT)
}

fn list_curated_skill_dirs(index: &TarballIndex) -> Vec<String> {
    let prefix = curated_prefix(index);
    let mut dirs: Vec<String> = index
        .files
        .keys()
        .filter_map(|path| {
            if !path.starts_with(&prefix) {
                return None;
            }
            let rel = path.strip_prefix(&prefix)?;
            let skill_md = rel.strip_suffix("SKILL.md")?;
            if skill_md.is_empty() {
                return None;
            }
            let dir = skill_md.trim_end_matches('/');
            if dir.contains('/') {
                return None;
            }
            Some(dir.to_string())
        })
        .collect();
    dirs.sort();
    dirs.dedup();
    dirs
}

fn parse_skill_preview(content: &str, dir_name: &str) -> OpenAISkillPreview {
    let loader = SkillLoader::new(Path::new("."));
    if let Ok(skill) = loader.parse_skill_from_content(content) {
        return OpenAISkillPreview {
            dir_name: dir_name.to_string(),
            name: skill.name,
            description: skill.description,
            version: skill.version,
        };
    }
    OpenAISkillPreview {
        dir_name: dir_name.to_string(),
        name: dir_name.to_string(),
        description: String::new(),
        version: String::new(),
    }
}

fn read_skill_md(index: &TarballIndex, skill_dir: &str) -> Option<String> {
    let key = format!("{}{}/SKILL.md", curated_prefix(index), skill_dir);
    let bytes = index.files.get(&key)?;
    Some(
        String::from_utf8_lossy(bytes)
            .trim_start_matches('\u{FEFF}')
            .to_string(),
    )
}

fn skill_matches_query(dir_name: &str, preview: &OpenAISkillPreview, query: &str) -> bool {
    if query.is_empty() {
        return true;
    }
    let q = query.to_lowercase();
    dir_name.to_lowercase().contains(&q)
        || preview.name.to_lowercase().contains(&q)
        || preview.description.to_lowercase().contains(&q)
}

fn extract_skill_to_temp(index: &TarballIndex, skill_dir: &str, dest: &Path) -> Result<(), String> {
    let prefix = format!("{}{}/", curated_prefix(index), skill_dir);
    std::fs::create_dir_all(dest).map_err(|e| format!("创建临时目录失败：{}", e))?;
    let mut found_skill_md = false;
    for (path, bytes) in &index.files {
        if !path.starts_with(&prefix) {
            continue;
        }
        let rel = path
            .strip_prefix(&prefix)
            .ok_or_else(|| format!("路径前缀异常：{}", path))?;
        if rel.is_empty() || rel.contains("..") {
            continue;
        }
        if rel == "SKILL.md" {
            found_skill_md = true;
        }
        let out = dest.join(rel);
        if let Some(parent) = out.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("创建目录失败：{}", e))?;
        }
        std::fs::write(&out, bytes).map_err(|e| format!("写入 {} 失败：{}", rel, e))?;
    }
    if !found_skill_md {
        return Err(format!("技能目录 '{}' 缺少 SKILL.md", skill_dir));
    }
    Ok(())
}

/// List curated skills from openai/skills (skills/.curated/*).
#[tauri::command]
pub async fn openai_skills_list(
    query: String,
    limit: Option<u32>,
) -> Result<OpenAISkillListResult, String> {
    let limit = limit.unwrap_or(60).min(120) as usize;
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(60))
        .user_agent("Piscis-Desktop/1.0")
        .build()
        .map_err(|e| e.to_string())?;

    let tarball = fetch_curated_tarball(&client).await?;
    let index = index_tarball(&tarball)?;
    let q = query.trim().to_string();

    let mut items = Vec::new();
    for dir_name in list_curated_skill_dirs(&index) {
        let preview = read_skill_md(&index, &dir_name)
            .map(|c| parse_skill_preview(&c, &dir_name))
            .unwrap_or_else(|| OpenAISkillPreview {
                dir_name: dir_name.clone(),
                name: dir_name.clone(),
                description: String::new(),
                version: String::new(),
            });
        if !skill_matches_query(&dir_name, &preview, &q) {
            continue;
        }
        items.push(OpenAISkillListItem {
            id: dir_name.clone(),
            name: preview.name.clone(),
            description: preview.description.clone(),
            dir_name,
        });
        if items.len() >= limit {
            break;
        }
    }

    Ok(OpenAISkillListResult {
        total: items.len(),
        query: q,
        items,
    })
}

/// Detail for one curated OpenAI skill.
#[tauri::command]
pub async fn openai_skills_detail(skill_id: String) -> Result<OpenAISkillDetail, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(60))
        .user_agent("Piscis-Desktop/1.0")
        .build()
        .map_err(|e| e.to_string())?;

    let tarball = fetch_curated_tarball(&client).await?;
    let index = index_tarball(&tarball)?;
    let dir_name = skill_id.trim().to_string();
    if !list_curated_skill_dirs(&index)
        .iter()
        .any(|d| d == &dir_name)
    {
        return Err(format!("未找到 OpenAI curated 技能 '{}'", skill_id));
    }

    let content = read_skill_md(&index, &dir_name)
        .ok_or_else(|| format!("技能 '{}' 缺少 SKILL.md", dir_name))?;
    let preview = parse_skill_preview(&content, &dir_name);
    Ok(OpenAISkillDetail {
        skill: OpenAISkillListItem {
            id: dir_name.clone(),
            name: preview.name.clone(),
            description: preview.description.clone(),
            dir_name,
        },
        preview,
    })
}

/// Install one or more curated OpenAI skills.
#[tauri::command]
pub async fn openai_skills_install(
    state: State<'_, AppState>,
    skill_ids: Option<Vec<String>>,
) -> Result<OpenAISkillInstallResult, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .user_agent("Piscis-Desktop/1.0")
        .build()
        .map_err(|e| e.to_string())?;

    let tarball = fetch_curated_tarball(&client).await?;
    let index = index_tarball(&tarball)?;
    let all_dirs = list_curated_skill_dirs(&index);
    if all_dirs.is_empty() {
        return Err("OpenAI curated 目录为空".to_string());
    }

    let selected: Vec<String> = if let Some(ids) = skill_ids {
        ids.into_iter()
            .map(|d| d.trim().to_string())
            .filter(|d| !d.is_empty())
            .collect()
    } else {
        all_dirs.clone()
    };

    let app_dir = state
        .app_handle
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| PathBuf::from(".piscis"));
    let skills_dir = crate::skills::service::skills_root_from_app_data(&app_dir);

    let temp_root =
        std::env::temp_dir().join(format!("piscis-openai-skills-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&temp_root);

    let mut installed = Vec::new();
    let mut skipped = Vec::new();
    let mut errors = Vec::new();

    for dir_name in &selected {
        if !all_dirs.iter().any(|d| d == dir_name) {
            skipped.push(format!("{}（不在 curated 列表中）", dir_name));
            continue;
        }

        let temp_skill = temp_root.join(dir_name);
        if let Err(e) = extract_skill_to_temp(&index, dir_name, &temp_skill) {
            errors.push(format!("{}: {}", dir_name, e));
            continue;
        }

        let skill_md = temp_skill.join("SKILL.md");
        let content = match std::fs::read_to_string(&skill_md) {
            Ok(c) => c,
            Err(e) => {
                errors.push(format!("{}: 读取 SKILL.md 失败：{}", dir_name, e));
                continue;
            }
        };

        let loader = SkillLoader::new(&skills_dir);
        let parsed = match loader.parse_skill_from_content(&content) {
            Ok(s) => s,
            Err(e) => {
                errors.push(format!("{}: 解析 SKILL.md 失败：{}", dir_name, e));
                continue;
            }
        };

        let compat = check_skill_compatibility(&parsed).await;
        if !compat.compatible {
            errors.push(format!(
                "{} ({}): {}",
                dir_name,
                parsed.name,
                compat.issues.join("; ")
            ));
            continue;
        }

        let source_url = Some(format!("{}/{}", GITHUB_TREE_BASE, dir_name));
        let install_res = {
            let db = state.db.lock().await;
            crate::skills::service::install_from_skill_dir(
                &db,
                &skills_dir,
                &temp_skill,
                SOURCE_ID,
                source_url,
                None,
            )
        };
        match install_res {
            Ok((_id, _display)) => {
                info!("Installed openai curated skill '{}'", parsed.name);
                installed.push(SkillCatalogItem {
                    name: parsed.name.clone(),
                    description: parsed.description.clone(),
                    version: parsed.version.clone(),
                    source: "installed".to_string(),
                    tools: parsed.tools.clone(),
                    dependencies: parsed.dependencies.clone(),
                    permissions: parsed.permissions.clone(),
                    platform: parsed.platform.clone(),
                });
            }
            Err(e) => errors.push(format!("{} ({}): {}", dir_name, parsed.name, e)),
        }
    }

    let _ = std::fs::remove_dir_all(&temp_root);

    if installed.is_empty() && errors.is_empty() && !skipped.is_empty() {
        return Err("未安装任何技能：所选技能目录无效".to_string());
    }
    if installed.is_empty() && !errors.is_empty() {
        return Err(errors.join("\n"));
    }

    Ok(OpenAISkillInstallResult {
        installed,
        skipped,
        errors,
    })
}
