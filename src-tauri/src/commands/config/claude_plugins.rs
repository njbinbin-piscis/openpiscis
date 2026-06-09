//! Anthropic `claude-plugins-official` registry — git-subdir skill bundle install.
//!
//! Lists in-repo plugins from `.claude-plugin/marketplace.json`, discovers
//! `skills/*/SKILL.md` via tarball extraction, and installs full skill directories
//! (including scripts/references/assets).

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

const REPO_TARBALL_URL: &str =
    "https://codeload.github.com/anthropics/claude-plugins-official/tar.gz/main";
const MARKETPLACE_JSON_URL: &str = "https://raw.githubusercontent.com/anthropics/claude-plugins-official/main/.claude-plugin/marketplace.json";
const SOURCE_ID: &str = "claude-plugins-official";
const GITHUB_TREE_BASE: &str = "https://github.com/anthropics/claude-plugins-official/tree/main";

#[derive(Debug, Clone, Serialize)]
pub struct ClaudePluginListItem {
    pub id: String,
    pub name: String,
    pub description: String,
    pub category: String,
    pub author: String,
    pub source_path: String,
    pub homepage: Option<String>,
    pub skill_count: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct ClaudePluginSkillPreview {
    pub dir_name: String,
    pub name: String,
    pub description: String,
    pub version: String,
}

#[derive(Debug, Serialize)]
pub struct ClaudePluginListResult {
    pub items: Vec<ClaudePluginListItem>,
    pub total: usize,
    pub query: String,
}

#[derive(Debug, Serialize)]
pub struct ClaudePluginDetail {
    pub plugin: ClaudePluginListItem,
    pub skills: Vec<ClaudePluginSkillPreview>,
}

#[derive(Debug, Serialize)]
pub struct ClaudePluginInstallResult {
    pub plugin_id: String,
    pub installed: Vec<SkillCatalogItem>,
    pub skipped: Vec<String>,
    pub errors: Vec<String>,
}

struct TarballIndex {
    root_prefix: String,
    files: HashMap<String, Vec<u8>>,
}

struct MarketplacePlugin {
    name: String,
    description: String,
    category: String,
    author: String,
    source_path: String,
    homepage: Option<String>,
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

async fn fetch_marketplace_plugins(
    client: &reqwest::Client,
) -> Result<Vec<MarketplacePlugin>, String> {
    let resp = http_get_with_retry(client, MARKETPLACE_JSON_URL, 3).await?;
    if !resp.status().is_success() {
        return Err(format!(
            "无法读取 marketplace.json（HTTP {}）",
            resp.status()
        ));
    }
    let body: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("marketplace.json 解析失败：{}", e))?;
    let entries = body["plugins"]
        .as_array()
        .ok_or_else(|| "marketplace.json 缺少 plugins 数组".to_string())?;

    let mut out = Vec::new();
    for entry in entries {
        let source = entry.get("source");
        let Some(source_path) = source.and_then(|s| s.as_str()) else {
            continue;
        };
        if !source_path.starts_with("./") {
            continue;
        }
        let normalized = source_path.trim_start_matches("./").to_string();
        let name = entry["name"].as_str().unwrap_or("").to_string();
        if name.is_empty() {
            continue;
        }
        let author = entry["author"]["name"]
            .as_str()
            .or_else(|| entry["author"].as_str())
            .unwrap_or("Anthropic")
            .to_string();
        out.push(MarketplacePlugin {
            name: name.clone(),
            description: entry["description"].as_str().unwrap_or("").to_string(),
            category: entry["category"].as_str().unwrap_or("").to_string(),
            author,
            source_path: normalized,
            homepage: entry["homepage"].as_str().map(String::from),
        });
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

async fn fetch_official_tarball(client: &reqwest::Client) -> Result<Vec<u8>, String> {
    info!("Fetching claude-plugins-official tarball");
    let resp = http_get_with_retry(client, REPO_TARBALL_URL, 3).await?;
    if !resp.status().is_success() {
        return Err(format!("无法下载官方插件仓库（HTTP {}）", resp.status()));
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

fn plugin_prefix(index: &TarballIndex, source_path: &str) -> String {
    format!("{}{}/", index.root_prefix, source_path.trim_matches('/'))
}

fn list_skill_dirs(index: &TarballIndex, source_path: &str) -> Vec<String> {
    let prefix = format!("{}skills/", plugin_prefix(index, source_path));
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

fn parse_skill_preview(content: &str, dir_name: &str) -> ClaudePluginSkillPreview {
    let loader = SkillLoader::new(Path::new("."));
    if let Ok(skill) = loader.parse_skill_from_content(content) {
        return ClaudePluginSkillPreview {
            dir_name: dir_name.to_string(),
            name: skill.name,
            description: skill.description,
            version: skill.version,
        };
    }
    ClaudePluginSkillPreview {
        dir_name: dir_name.to_string(),
        name: dir_name.to_string(),
        description: String::new(),
        version: String::new(),
    }
}

fn read_skill_md(index: &TarballIndex, source_path: &str, skill_dir: &str) -> Option<String> {
    let key = format!(
        "{}skills/{}/SKILL.md",
        plugin_prefix(index, source_path),
        skill_dir
    );
    let bytes = index.files.get(&key)?;
    Some(
        String::from_utf8_lossy(bytes)
            .trim_start_matches('\u{FEFF}')
            .to_string(),
    )
}

fn extract_skill_to_temp(
    index: &TarballIndex,
    source_path: &str,
    skill_dir: &str,
    dest: &Path,
) -> Result<(), String> {
    let prefix = format!("{}skills/{}/", plugin_prefix(index, source_path), skill_dir);
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

fn plugin_matches_query(plugin: &MarketplacePlugin, query: &str) -> bool {
    if query.is_empty() {
        return true;
    }
    let q = query.to_lowercase();
    plugin.name.to_lowercase().contains(&q)
        || plugin.description.to_lowercase().contains(&q)
        || plugin.source_path.to_lowercase().contains(&q)
        || plugin.category.to_lowercase().contains(&q)
}

async fn build_plugin_list_item(
    plugin: &MarketplacePlugin,
    index: &TarballIndex,
) -> ClaudePluginListItem {
    let skill_count = list_skill_dirs(index, &plugin.source_path).len();
    ClaudePluginListItem {
        id: plugin.name.clone(),
        name: plugin.name.clone(),
        description: plugin.description.clone(),
        category: plugin.category.clone(),
        author: plugin.author.clone(),
        source_path: plugin.source_path.clone(),
        homepage: plugin.homepage.clone(),
        skill_count,
    }
}

fn find_marketplace_plugin<'a>(
    plugins: &'a [MarketplacePlugin],
    plugin_id: &str,
) -> Option<&'a MarketplacePlugin> {
    plugins
        .iter()
        .find(|p| p.name == plugin_id || p.source_path.ends_with(plugin_id))
}

/// List in-repo Anthropic official plugins (relative `source` entries in marketplace.json).
#[tauri::command]
pub async fn claude_plugins_list(
    query: String,
    limit: Option<u32>,
) -> Result<ClaudePluginListResult, String> {
    let limit = limit.unwrap_or(40).min(100) as usize;
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .user_agent("Piscis-Desktop/1.0")
        .build()
        .map_err(|e| e.to_string())?;

    let plugins = fetch_marketplace_plugins(&client).await?;

    let q = query.trim().to_string();
    let mut items = Vec::new();
    for plugin in &plugins {
        if !plugin_matches_query(plugin, &q) {
            continue;
        }
        items.push(ClaudePluginListItem {
            id: plugin.name.clone(),
            name: plugin.name.clone(),
            description: plugin.description.clone(),
            category: plugin.category.clone(),
            author: plugin.author.clone(),
            source_path: plugin.source_path.clone(),
            homepage: plugin.homepage.clone(),
            skill_count: 0,
        });
        if items.len() >= limit {
            break;
        }
    }

    Ok(ClaudePluginListResult {
        total: items.len(),
        query: q,
        items,
    })
}

/// Detail for one official plugin, including discoverable skills.
#[tauri::command]
pub async fn claude_plugins_detail(plugin_id: String) -> Result<ClaudePluginDetail, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(60))
        .user_agent("Piscis-Desktop/1.0")
        .build()
        .map_err(|e| e.to_string())?;

    let plugins = fetch_marketplace_plugins(&client).await?;
    let plugin = find_marketplace_plugin(&plugins, plugin_id.trim())
        .ok_or_else(|| format!("未找到官方插件 '{}'", plugin_id))?;

    let tarball = fetch_official_tarball(&client).await?;
    let index = index_tarball(&tarball)?;
    let plugin_item = build_plugin_list_item(plugin, &index).await;

    let mut skills = Vec::new();
    for dir_name in list_skill_dirs(&index, &plugin.source_path) {
        if let Some(content) = read_skill_md(&index, &plugin.source_path, &dir_name) {
            skills.push(parse_skill_preview(&content, &dir_name));
        }
    }

    Ok(ClaudePluginDetail {
        plugin: plugin_item,
        skills,
    })
}

/// Install all or selected skills from an official plugin git-subdir.
#[tauri::command]
pub async fn claude_plugins_install(
    state: State<'_, AppState>,
    plugin_id: String,
    skill_dirs: Option<Vec<String>>,
) -> Result<ClaudePluginInstallResult, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .user_agent("Piscis-Desktop/1.0")
        .build()
        .map_err(|e| e.to_string())?;

    let plugins = fetch_marketplace_plugins(&client).await?;
    let plugin = find_marketplace_plugin(&plugins, plugin_id.trim())
        .ok_or_else(|| format!("未找到官方插件 '{}'", plugin_id))?;

    let tarball = fetch_official_tarball(&client).await?;
    let index = index_tarball(&tarball)?;

    let all_dirs = list_skill_dirs(&index, &plugin.source_path);
    if all_dirs.is_empty() {
        return Err(format!(
            "插件 '{}' 不包含可安装的 SKILL（可能仅为 MCP/LSP 插件）",
            plugin.name
        ));
    }

    let selected: Vec<String> = if let Some(dirs) = skill_dirs {
        dirs.into_iter()
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
    let source_url = Some(format!("{}/{}", GITHUB_TREE_BASE, plugin.source_path));

    let temp_root = std::env::temp_dir().join(format!(
        "piscis-claude-plugin-{}-{}",
        plugin.name,
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&temp_root);

    let mut installed = Vec::new();
    let mut skipped = Vec::new();
    let mut errors = Vec::new();

    for dir_name in &selected {
        if !all_dirs.iter().any(|d| d == dir_name) {
            skipped.push(format!("{}（不在插件中）", dir_name));
            continue;
        }

        let temp_skill = temp_root.join(dir_name);
        if let Err(e) = extract_skill_to_temp(&index, &plugin.source_path, dir_name, &temp_skill) {
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

        let install_res = {
            let db = state.db.lock().await;
            crate::skills::service::install_from_skill_dir(
                &db,
                &skills_dir,
                &temp_skill,
                SOURCE_ID,
                source_url.clone(),
                None,
            )
        };
        match install_res {
            Ok((_id, _display)) => {
                info!(
                    "Installed claude plugin skill '{}' from plugin '{}'",
                    parsed.name, plugin.name
                );
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

    Ok(ClaudePluginInstallResult {
        plugin_id: plugin.name.clone(),
        installed,
        skipped,
        errors,
    })
}
