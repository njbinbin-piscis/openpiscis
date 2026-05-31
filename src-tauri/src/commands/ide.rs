//! IDE-domain commands — file tree, file I/O, git integration, terminal PTY,
//! and file-change event bridge for the embedded Monaco Editor IDE.
//!
//! All commands are registered as Tauri commands by `app::bootstrap`.

use pisci_kernel::proc::tokio_command;
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::Write as StdWrite;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;
use tauri::{AppHandle, Emitter, State};
use tokio::process::Command;
use tokio::time::timeout;

use crate::lsp::manager::LspManager;
use crate::store::AppState;

// ─── Types ─────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileNode {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    pub modified: Option<String>,
    pub children: Option<Vec<FileNode>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileContent {
    pub path: String,
    pub content: String,
    pub encoding: String,
    pub is_binary: bool,
    pub size: u64,
    pub language: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchResult {
    pub path: String,
    pub line: usize,
    pub column: usize,
    pub text: String,
    pub context_before: Option<String>,
    pub context_after: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitFileStatus {
    pub path: String,
    pub status: String, // modified, added, deleted, untracked, renamed
    pub staged: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiffResult {
    pub path: String,
    pub original: String,
    pub modified: String,
    pub hunks: Vec<DiffHunk>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiffHunk {
    pub old_start: usize,
    pub old_lines: usize,
    pub new_start: usize,
    pub new_lines: usize,
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BranchInfo {
    pub name: String,
    pub is_current: bool,
    pub is_koi: bool,
    pub last_commit: Option<String>,
    pub last_commit_time: Option<String>,
}

// ─── File Tree ─────────────────────────────────────────────────────────────

/// List files in a project directory as a tree structure.
/// Respects .gitignore patterns. Returns nested FileNode tree.
#[tauri::command]
pub async fn ide_list_files(
    project_dir: String,
    depth: Option<usize>,
) -> Result<Vec<FileNode>, String> {
    let root = PathBuf::from(&project_dir);
    if !root.exists() {
        return Err(format!("Directory not found: {}", project_dir));
    }
    let max_depth = depth.unwrap_or(10);
    let ignore_patterns = load_gitignore_patterns(&root);
    let mut nodes = build_file_tree(&root, &root, 0, max_depth, &ignore_patterns)
        .map_err(|e| format!("Failed to list files: {}", e))?;
    sort_file_nodes(&mut nodes);
    Ok(nodes)
}

fn load_gitignore_patterns(root: &Path) -> Vec<String> {
    let gitignore = root.join(".gitignore");
    if gitignore.exists() {
        std::fs::read_to_string(&gitignore)
            .unwrap_or_default()
            .lines()
            .filter(|l| !l.trim().is_empty() && !l.starts_with('#'))
            .map(|l| l.trim().to_string())
            .collect()
    } else {
        vec![]
    }
}

fn is_ignored(name: &str, path: &Path, patterns: &[String]) -> bool {
    // Always ignore these
    let always_ignore = [
        ".git",
        "node_modules",
        "__pycache__",
        ".koi-worktrees",
        "target",
        ".next",
        ".nuxt",
        "dist",
        ".DS_Store",
    ];
    if always_ignore.contains(&name) {
        return true;
    }
    // Check gitignore patterns (simple glob matching)
    for pattern in patterns {
        let p = pattern.trim_start_matches('/');
        if name == p || path.to_string_lossy().contains(p) {
            return true;
        }
        if p.ends_with('/') && name == p.trim_end_matches('/') {
            return true;
        }
        if p.starts_with('*') {
            let ext = p.trim_start_matches('*');
            if name.ends_with(ext) {
                return true;
            }
        }
    }
    false
}

fn build_file_tree(
    dir: &Path,
    root: &Path,
    current_depth: usize,
    max_depth: usize,
    patterns: &[String],
) -> std::io::Result<Vec<FileNode>> {
    if current_depth >= max_depth {
        return Ok(vec![]);
    }

    let mut nodes = Vec::new();
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return Ok(vec![]),
    };

    for entry in entries {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        let name = entry.file_name().to_string_lossy().to_string();
        let path = entry.path();

        if is_ignored(&name, &path, patterns) {
            continue;
        }

        let metadata = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };

        let relative = path
            .strip_prefix(root)
            .unwrap_or(&path)
            .to_string_lossy()
            .to_string();

        let modified = metadata.modified().ok().map(|t| {
            let dt: chrono::DateTime<chrono::Local> = t.into();
            dt.to_rfc3339()
        });

        if metadata.is_dir() {
            let children = build_file_tree(&path, root, current_depth + 1, max_depth, patterns)?;
            nodes.push(FileNode {
                name,
                path: relative,
                is_dir: true,
                size: 0,
                modified,
                children: Some(children),
            });
        } else {
            nodes.push(FileNode {
                name,
                path: relative,
                is_dir: false,
                size: metadata.len(),
                modified,
                children: None,
            });
        }
    }

    Ok(nodes)
}

fn sort_file_nodes(nodes: &mut [FileNode]) {
    nodes.sort_by(|a, b| {
        // Directories first, then alphabetical
        match (a.is_dir, b.is_dir) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
        }
    });
    for node in nodes.iter_mut() {
        if let Some(ref mut children) = node.children {
            sort_file_nodes(children);
        }
    }
}

// ─── File Read / Write ─────────────────────────────────────────────────────

/// Read a file's content with encoding detection.
#[tauri::command]
pub async fn ide_read_file(path: String) -> Result<FileContent, String> {
    let file_path = PathBuf::from(&path);
    if !file_path.exists() {
        return Err(format!("File not found: {}", path));
    }

    let metadata = std::fs::metadata(&file_path).map_err(|e| e.to_string())?;
    let size = metadata.len();

    // Binary detection: read first 8KB and check for null bytes
    let raw = std::fs::read(&file_path).map_err(|e| e.to_string())?;
    let is_binary = raw[..raw.len().min(8192)].contains(&0);

    if is_binary {
        return Ok(FileContent {
            path: path.clone(),
            content: format!("[Binary file, {} bytes]", size),
            encoding: "binary".to_string(),
            is_binary: true,
            size,
            language: None,
        });
    }

    // Encoding detection
    let (content, encoding) = decode_content(&raw);

    let language = detect_language(&file_path);

    Ok(FileContent {
        path,
        content,
        encoding,
        is_binary: false,
        size,
        language,
    })
}

fn decode_content(raw: &[u8]) -> (String, String) {
    // Check BOM
    if raw.starts_with(&[0xEF, 0xBB, 0xBF]) {
        // UTF-8 BOM
        let s = String::from_utf8_lossy(&raw[3..]).to_string();
        return (s, "utf-8-bom".to_string());
    }
    if raw.starts_with(&[0xFF, 0xFE]) {
        // UTF-16 LE
        let s = encoding_rs::UTF_16LE.decode(&raw[2..]).0.to_string();
        return (s, "utf-16le".to_string());
    }
    if raw.starts_with(&[0xFE, 0xFF]) {
        // UTF-16 BE
        let s = encoding_rs::UTF_16BE.decode(&raw[2..]).0.to_string();
        return (s, "utf-16be".to_string());
    }

    // Try UTF-8 first
    match std::str::from_utf8(raw) {
        Ok(s) => (s.to_string(), "utf-8".to_string()),
        Err(_) => {
            // Fallback to GBK (common in Chinese projects)
            let (s, _, _) = encoding_rs::GBK.decode(raw);
            (s.to_string(), "gbk".to_string())
        }
    }
}

fn detect_language(path: &Path) -> Option<String> {
    let ext = path.extension()?.to_str()?;
    let lang = match ext {
        "ts" | "tsx" => "typescript",
        "js" | "jsx" | "mjs" | "cjs" => "javascript",
        "rs" => "rust",
        "py" | "pyi" => "python",
        "go" => "go",
        "java" => "java",
        "c" | "h" => "c",
        "cpp" | "cc" | "cxx" | "hpp" | "hxx" => "cpp",
        "cs" => "csharp",
        "rb" => "ruby",
        "php" => "php",
        "swift" => "swift",
        "kt" | "kts" => "kotlin",
        "scala" => "scala",
        "r" => "r",
        "lua" => "lua",
        "sh" | "bash" | "zsh" => "shellscript",
        "ps1" | "psm1" | "psd1" => "powershell",
        "bat" | "cmd" => "bat",
        "json" => "json",
        "yaml" | "yml" => "yaml",
        "toml" => "toml",
        "xml" => "xml",
        "html" | "htm" => "html",
        "css" => "css",
        "scss" => "scss",
        "less" => "less",
        "md" | "markdown" => "markdown",
        "sql" => "sql",
        "graphql" | "gql" => "graphql",
        "dockerfile" => "dockerfile",
        "makefile" => "makefile",
        "cmake" => "cmake",
        "proto" => "protobuf",
        _ => return None,
    };
    Some(lang.to_string())
}

/// Write content to a file. Creates parent directories if needed.
#[tauri::command]
pub async fn ide_write_file(path: String, content: String) -> Result<(), String> {
    let file_path = PathBuf::from(&path);
    if let Some(parent) = file_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create directories: {}", e))?;
    }
    std::fs::write(&file_path, content.as_bytes()).map_err(|e| format!("Failed to write: {}", e))
}

/// Perform file actions: create_file, create_dir, delete, rename.
#[tauri::command]
pub async fn ide_file_action(
    path: String,
    action: String,
    new_path: Option<String>,
) -> Result<(), String> {
    let file_path = PathBuf::from(&path);

    match action.as_str() {
        "create_file" => {
            if let Some(parent) = file_path.parent() {
                std::fs::create_dir_all(parent)
                    .map_err(|e| format!("Failed to create directories: {}", e))?;
            }
            std::fs::write(&file_path, "").map_err(|e| format!("Failed to create file: {}", e))
        }
        "create_dir" => std::fs::create_dir_all(&file_path)
            .map_err(|e| format!("Failed to create directory: {}", e)),
        "delete" => {
            if file_path.is_dir() {
                std::fs::remove_dir_all(&file_path)
                    .map_err(|e| format!("Failed to delete directory: {}", e))
            } else {
                std::fs::remove_file(&file_path)
                    .map_err(|e| format!("Failed to delete file: {}", e))
            }
        }
        "rename" => {
            let target = new_path.ok_or("rename requires 'new_path' parameter")?;
            let target_path = PathBuf::from(&target);
            if let Some(parent) = target_path.parent() {
                std::fs::create_dir_all(parent)
                    .map_err(|e| format!("Failed to create directories: {}", e))?;
            }
            std::fs::rename(&file_path, &target_path)
                .map_err(|e| format!("Failed to rename: {}", e))
        }
        _ => Err(format!("Unknown action: {}", action)),
    }
}

/// Full-text search across project files using ripgrep if available,
/// falling back to a simple Rust implementation.
#[tauri::command]
pub async fn ide_search_files(
    project_dir: String,
    query: String,
    file_pattern: Option<String>,
    case_sensitive: Option<bool>,
) -> Result<Vec<SearchResult>, String> {
    let root = PathBuf::from(&project_dir);
    if !root.exists() {
        return Err(format!("Directory not found: {}", project_dir));
    }
    if query.trim().is_empty() {
        return Ok(vec![]);
    }

    let case = case_sensitive.unwrap_or(false);
    let max_results = 500;
    let mut results = Vec::new();

    // Try ripgrep first
    let rg_result = try_ripgrep(&root, &query, file_pattern.as_deref(), case, max_results).await;
    match rg_result {
        Ok(rg_results) => {
            eprintln!(
                "[ide_search] ripgrep ok: {} results for {:?} in {}",
                rg_results.len(),
                query,
                project_dir,
            );
            return Ok(rg_results);
        }
        Err(e) => {
            eprintln!(
                "[ide_search] ripgrep unavailable ({}) — using built-in fallback",
                e,
            );
        }
    }

    // Fallback: simple Rust search
    search_dir_recursive(
        &root,
        &root,
        &query,
        case,
        &file_pattern,
        &mut results,
        max_results,
    )?;
    eprintln!(
        "[ide_search] fallback found {} results for {:?} in {}",
        results.len(),
        query,
        project_dir,
    );
    Ok(results)
}

async fn try_ripgrep(
    root: &Path,
    query: &str,
    file_pattern: Option<&str>,
    case_sensitive: bool,
    max_results: usize,
) -> Result<Vec<SearchResult>, String> {
    let mut cmd = tokio_command("rg");
    cmd.arg("--json")
        .arg("--max-count")
        .arg("5")
        .arg("--max-filesize")
        .arg("1M");

    if !case_sensitive {
        cmd.arg("-i");
    }
    if let Some(pat) = file_pattern {
        cmd.arg("--glob").arg(pat);
    }
    cmd.arg("--").arg(query).arg(root.as_os_str());
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());

    let output = timeout(Duration::from_secs(30), cmd.output())
        .await
        .map_err(|_| "Search timed out")?
        .map_err(|e| format!("ripgrep failed: {}", e))?;

    if !output.status.success() && output.status.code() != Some(1) {
        return Err("ripgrep error".to_string());
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut results = Vec::new();

    for line in stdout.lines() {
        if results.len() >= max_results {
            break;
        }
        if let Ok(val) = serde_json::from_str::<serde_json::Value>(line) {
            if val["type"].as_str() == Some("match") {
                let data = &val["data"];
                let path = data["path"]["text"].as_str().unwrap_or("");
                let line_num = data["line_number"].as_u64().unwrap_or(0) as usize;
                let text = data["lines"]["text"]
                    .as_str()
                    .unwrap_or("")
                    .trim_end()
                    .to_string();

                // Extract relative path
                let rel_path = path
                    .strip_prefix(&root.to_string_lossy().to_string())
                    .unwrap_or(path)
                    .trim_start_matches('/')
                    .to_string();

                results.push(SearchResult {
                    path: rel_path,
                    line: line_num,
                    column: 0,
                    text,
                    context_before: None,
                    context_after: None,
                });
            }
        }
    }

    Ok(results)
}

fn search_dir_recursive(
    dir: &Path,
    root: &Path,
    query: &str,
    case_sensitive: bool,
    file_pattern: &Option<String>,
    results: &mut Vec<SearchResult>,
    max_results: usize,
) -> Result<(), String> {
    if results.len() >= max_results {
        return Ok(());
    }

    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return Ok(()),
    };

    let query_cmp = if case_sensitive {
        query.to_string()
    } else {
        query.to_lowercase()
    };

    for entry in entries {
        if results.len() >= max_results {
            break;
        }
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        let name = entry.file_name().to_string_lossy().to_string();
        let path = entry.path();

        // Skip common non-source dirs and hidden dirs
        if matches!(
            name.as_str(),
            ".git"
                | "node_modules"
                | "__pycache__"
                | "target"
                | "dist"
                | "build"
                | ".koi-worktrees"
                | ".qoder"
                | ".next"
                | ".turbo"
                | ".cache"
                | ".idea"
                | ".vscode"
        ) {
            continue;
        }

        let metadata = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };

        if metadata.is_dir() {
            search_dir_recursive(
                &path,
                root,
                query,
                case_sensitive,
                file_pattern,
                results,
                max_results,
            )?;
        } else if metadata.len() < 1_000_000 {
            // Skip files > 1MB
            if let Some(ref pat) = file_pattern {
                let pat_clean = pat.trim_start_matches('*');
                if !name.ends_with(pat_clean) {
                    continue;
                }
            }

            if let Ok(content) = std::fs::read_to_string(&path) {
                let rel_path = path
                    .strip_prefix(root)
                    .unwrap_or(&path)
                    .to_string_lossy()
                    .to_string();

                for (line_num, line_text) in content.lines().enumerate() {
                    if results.len() >= max_results {
                        break;
                    }
                    let line_cmp = if case_sensitive {
                        line_text.to_string()
                    } else {
                        line_text.to_lowercase()
                    };
                    if line_cmp.contains(&query_cmp) {
                        results.push(SearchResult {
                            path: rel_path.clone(),
                            line: line_num + 1,
                            column: 0,
                            text: line_text.to_string(),
                            context_before: None,
                            context_after: None,
                        });
                    }
                }
            }
        }
    }

    Ok(())
}

// ─── Git Operations ────────────────────────────────────────────────────────

/// Get git status for all files in the project directory.
#[tauri::command]
pub async fn ide_git_status(project_dir: String) -> Result<Vec<GitFileStatus>, String> {
    let root = PathBuf::from(&project_dir);
    if !root.join(".git").exists() {
        return Ok(vec![]);
    }

    let output = run_git_cmd(&root, &["status", "--porcelain=v1", "-uall"])
        .await
        .map_err(|e| format!("git status failed: {}", e))?;

    let mut statuses = Vec::new();
    for line in output.lines() {
        if line.len() < 4 {
            continue;
        }
        let chars: Vec<char> = line.chars().collect();
        let index_status = chars[0];
        let worktree_status = chars[1];
        let path = parse_porcelain_path(&line[3..]);

        // Staged changes (index)
        if index_status != ' ' && index_status != '?' {
            statuses.push(GitFileStatus {
                path: path.clone(),
                status: status_char_to_string(index_status),
                staged: true,
            });
        }

        // Unstaged changes (worktree)
        if worktree_status != ' ' && worktree_status != '?' {
            statuses.push(GitFileStatus {
                path: path.clone(),
                status: status_char_to_string(worktree_status),
                staged: false,
            });
        }

        // Untracked
        if index_status == '?' && worktree_status == '?' {
            statuses.push(GitFileStatus {
                path,
                status: "untracked".to_string(),
                staged: false,
            });
        }
    }

    Ok(statuses)
}

/// Path segment from `git status --porcelain` (after XY + space).
fn parse_porcelain_path(raw: &str) -> String {
    let trimmed = raw.trim_start();
    if let Some((_old, new)) = trimmed.split_once(" -> ") {
        return new.trim().to_string();
    }
    trimmed.to_string()
}

fn status_char_to_string(c: char) -> String {
    match c {
        'M' => "modified",
        'A' => "added",
        'D' => "deleted",
        'R' => "renamed",
        'C' => "copied",
        'T' => "type_changed",
        _ => "unknown",
    }
    .to_string()
}

/// Get diff for a specific file (working tree vs HEAD or vs a specific ref).
#[tauri::command]
pub async fn ide_git_diff(
    project_dir: String,
    path: String,
    base: Option<String>,
) -> Result<DiffResult, String> {
    let root = PathBuf::from(&project_dir);

    // Get original content (from HEAD or specified base)
    let base_ref = base.as_deref().unwrap_or("HEAD");
    let original = run_git_cmd(&root, &["show", &format!("{}:{}", base_ref, path)])
        .await
        .unwrap_or_default();

    // Get current content
    let full_path = root.join(&path);
    let modified = if full_path.exists() {
        std::fs::read_to_string(&full_path).unwrap_or_default()
    } else {
        String::new()
    };

    // Get unified diff
    let diff_args = if base.is_some() {
        vec!["diff", base_ref, "--", &path]
    } else {
        vec!["diff", "HEAD", "--", &path]
    };
    let diff_output = run_git_cmd(&root, &diff_args).await.unwrap_or_default();

    let hunks = parse_diff_hunks(&diff_output);

    Ok(DiffResult {
        path,
        original,
        modified,
        hunks,
    })
}

fn parse_diff_hunks(diff: &str) -> Vec<DiffHunk> {
    let mut hunks = Vec::new();
    let mut current_hunk: Option<DiffHunk> = None;
    let mut hunk_content = String::new();

    for line in diff.lines() {
        if line.starts_with("@@") {
            // Save previous hunk
            if let Some(mut hunk) = current_hunk.take() {
                hunk.content = hunk_content.clone();
                hunks.push(hunk);
                hunk_content.clear();
            }

            // Parse @@ -old_start,old_lines +new_start,new_lines @@
            let parts: Vec<&str> = line.split("@@").collect();
            if parts.len() >= 2 {
                let range = parts[1].trim();
                let ranges: Vec<&str> = range.split_whitespace().collect();
                if ranges.len() >= 2 {
                    let old = parse_range(ranges[0]);
                    let new = parse_range(ranges[1]);
                    current_hunk = Some(DiffHunk {
                        old_start: old.0,
                        old_lines: old.1,
                        new_start: new.0,
                        new_lines: new.1,
                        content: String::new(),
                    });
                }
            }
        } else if current_hunk.is_some()
            && (line.starts_with('+') || line.starts_with('-') || line.starts_with(' '))
        {
            hunk_content.push_str(line);
            hunk_content.push('\n');
        }
    }

    if let Some(mut hunk) = current_hunk {
        hunk.content = hunk_content;
        hunks.push(hunk);
    }

    hunks
}

fn parse_range(s: &str) -> (usize, usize) {
    let s = s.trim_start_matches('-').trim_start_matches('+');
    let parts: Vec<&str> = s.split(',').collect();
    let start = parts[0].parse().unwrap_or(0);
    let lines = parts.get(1).and_then(|l| l.parse().ok()).unwrap_or(1);
    (start, lines)
}

/// List all branches, highlighting koi/* branches.
#[tauri::command]
pub async fn ide_git_branches(project_dir: String) -> Result<Vec<BranchInfo>, String> {
    let root = PathBuf::from(&project_dir);
    if !root.join(".git").exists() {
        return Ok(vec![]);
    }

    let output = run_git_cmd(
        &root,
        &[
            "for-each-ref",
            "--format=%(refname:short)|%(HEAD)|%(subject)|%(creatordate:iso)",
            "refs/heads/",
        ],
    )
    .await
    .map_err(|e| format!("git branch list failed: {}", e))?;

    let mut branches = Vec::new();
    for line in output.lines() {
        let parts: Vec<&str> = line.splitn(4, '|').collect();
        if parts.len() >= 2 {
            let name = parts[0].to_string();
            let is_current = parts[1] == "*";
            let last_commit = parts.get(2).map(|s| s.to_string());
            let last_commit_time = parts.get(3).map(|s| s.to_string());

            branches.push(BranchInfo {
                is_koi: name.starts_with("koi/"),
                name,
                is_current,
                last_commit,
                last_commit_time,
            });
        }
    }

    // Sort: current first, then koi branches, then alphabetically
    branches.sort_by(|a, b| {
        if a.is_current != b.is_current {
            return if a.is_current {
                std::cmp::Ordering::Less
            } else {
                std::cmp::Ordering::Greater
            };
        }
        a.name.cmp(&b.name)
    });

    Ok(branches)
}

/// Get file content at a specific git ref (for diff comparison).
#[tauri::command]
pub async fn ide_git_file_at_ref(
    project_dir: String,
    path: String,
    git_ref: String,
) -> Result<FileContent, String> {
    let root = PathBuf::from(&project_dir);
    let content = run_git_cmd(&root, &["show", &format!("{}:{}", git_ref, path)])
        .await
        .map_err(|e| format!("git show failed: {}", e))?;

    let language = detect_language(&PathBuf::from(&path));

    Ok(FileContent {
        path: format!("{}@{}", path, git_ref),
        content,
        encoding: "utf-8".to_string(),
        is_binary: false,
        size: 0,
        language,
    })
}

/// Stage files for commit (`git add`).
/// Pass `"."` as path to stage all changes.
#[tauri::command]
pub async fn ide_git_add(project_dir: String, path: String) -> Result<(), String> {
    let root = PathBuf::from(&project_dir);
    run_git_cmd(&root, &["add", &path])
        .await
        .map_err(|e| format!("git add failed: {}", e))?;
    Ok(())
}

/// Unstage files (`git reset HEAD -- <path>`).
#[tauri::command]
pub async fn ide_git_reset(project_dir: String, path: String) -> Result<(), String> {
    let root = PathBuf::from(&project_dir);
    run_git_cmd(&root, &["reset", "HEAD", "--", &path])
        .await
        .map_err(|e| format!("git reset failed: {}", e))?;
    Ok(())
}

/// Stage all changes in the working tree (`git add -A`).
/// Unlike `git add .`, `-A` also picks up deletions and changes outside the cwd.
#[tauri::command]
pub async fn ide_git_add_all(project_dir: String) -> Result<(), String> {
    let root = PathBuf::from(&project_dir);
    run_git_cmd(&root, &["add", "-A"])
        .await
        .map_err(|e| format!("git add -A failed: {}", e))?;
    Ok(())
}

/// Unstage everything in the index (`git reset HEAD --`).
#[tauri::command]
pub async fn ide_git_reset_all(project_dir: String) -> Result<(), String> {
    let root = PathBuf::from(&project_dir);
    run_git_cmd(&root, &["reset", "HEAD", "--"])
        .await
        .map_err(|e| format!("git reset all failed: {}", e))?;
    Ok(())
}

async fn git_has_staged_changes(root: &std::path::Path) -> Result<bool, String> {
    let output = timeout(
        Duration::from_secs(30),
        new_git_cmd()
            .args(["diff", "--cached", "--quiet"])
            .current_dir(root)
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .output(),
    )
    .await
    .map_err(|_| "git command timed out")?
    .map_err(|e| format!("git command failed: {}", e))?;

    // diff --cached --quiet: exit 0 = nothing staged, 1 = has staged changes
    Ok(output.status.code() == Some(1))
}

/// Commit staged changes with a message.
#[tauri::command]
pub async fn ide_git_commit(project_dir: String, message: String) -> Result<String, String> {
    let root = PathBuf::from(&project_dir);
    if !root.join(".git").exists() {
        return Err("Not a git repository".into());
    }
    if message.trim().is_empty() {
        return Err("Commit message cannot be empty".into());
    }
    if !git_has_staged_changes(&root).await? {
        return Err(
            "Nothing staged to commit. Stage files with + in the Changes list first.".into(),
        );
    }

    let tmp = std::env::temp_dir().join(format!("openpisci-commit-{}.txt", std::process::id()));
    std::fs::write(&tmp, message.as_bytes())
        .map_err(|e| format!("failed to write commit message file: {}", e))?;
    let path_str = tmp.to_string_lossy().to_string();
    let result = run_git_cmd(&root, &["commit", "-F", &path_str])
        .await
        .map_err(|e| format!("git commit failed: {}", e));
    let _ = std::fs::remove_file(&tmp);
    result
}

/// Checkout (switch to) a branch. Refuses if there are uncommitted changes
/// that would be overwritten (git handles that itself — the error is surfaced).
#[tauri::command]
pub async fn ide_git_checkout(project_dir: String, branch: String) -> Result<String, String> {
    let root = PathBuf::from(&project_dir);
    let output = run_git_cmd(&root, &["checkout", &branch])
        .await
        .map_err(|e| format!("git checkout failed: {}", e))?;
    Ok(output)
}

/// Create a new branch from the current HEAD and switch to it.
#[tauri::command]
pub async fn ide_git_create_branch(project_dir: String, branch: String) -> Result<String, String> {
    let root = PathBuf::from(&project_dir);
    let output = run_git_cmd(&root, &["checkout", "-b", &branch])
        .await
        .map_err(|e| format!("git create branch failed: {}", e))?;
    Ok(output)
}

// ─── Terminal (PTY) ────────────────────────────────────────────────────────

/// Global terminal session registry.
pub struct TerminalRegistry {
    pub sessions: HashMap<String, TerminalSession>,
}

pub struct TerminalSession {
    pub child: Box<dyn portable_pty::Child + Send>,
    pub writer: Option<Box<dyn StdWrite + Send>>,
}

impl TerminalRegistry {
    pub fn new() -> Self {
        Self {
            sessions: HashMap::new(),
        }
    }
}

/// Create a new PTY terminal session with the given working directory.
/// Output is streamed via `ide-terminal-output` Tauri events.
#[tauri::command]
pub async fn ide_terminal_create(
    app: AppHandle,
    state: State<'_, AppState>,
    terminal_id: String,
    project_dir: String,
    cols: Option<u16>,
    rows: Option<u16>,
) -> Result<(), String> {
    let root = PathBuf::from(&project_dir);
    if !root.exists() {
        return Err(format!("Directory not found: {}", project_dir));
    }

    let pty_system = native_pty_system();

    let pair = pty_system
        .openpty(PtySize {
            rows: rows.unwrap_or(24),
            cols: cols.unwrap_or(80),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("Failed to open PTY: {}", e))?;

    // On Windows the $SHELL variable is not set (and bash requires WSL).
    // Fall back to PowerShell which is always available on Windows 10/11.
    #[cfg(windows)]
    let shell = "powershell.exe".to_string();
    #[cfg(not(windows))]
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "bash".to_string());
    let mut cmd = CommandBuilder::new(shell);
    cmd.cwd(&root);
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("Failed to spawn shell: {}", e))?;

    let reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("Failed to clone PTY reader: {}", e))?;

    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("Failed to take PTY writer: {}", e))?;

    // Store the master pty handle for resize support
    let master_pty = pair.master;

    // Register the session
    {
        let mut registry = state.terminals.lock().await;
        registry.sessions.insert(
            terminal_id.clone(),
            TerminalSession {
                child,
                writer: Some(writer),
            },
        );
    }

    // Spawn output reader task
    let app_clone = app.clone();
    let tid = terminal_id.clone();
    tokio::task::spawn_blocking(move || {
        let mut reader = reader;
        let mut buf = vec![0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let data = String::from_utf8_lossy(&buf[..n]).to_string();
                    let _ = app_clone.emit(
                        "ide-terminal-output",
                        serde_json::json!({ "id": tid, "data": data }),
                    );
                }
                Err(_) => break,
            }
        }
        // Drop master_pty to close the PTY when reader ends
        drop(master_pty);
    });

    Ok(())
}

/// Write data (keystrokes) to a terminal session.
#[tauri::command]
pub async fn ide_terminal_write(
    state: State<'_, AppState>,
    terminal_id: String,
    data: String,
) -> Result<(), String> {
    let mut registry = state.terminals.lock().await;
    let session = registry
        .sessions
        .get_mut(&terminal_id)
        .ok_or_else(|| format!("Terminal '{}' not found", terminal_id))?;

    if let Some(ref mut writer) = session.writer {
        writer
            .write_all(data.as_bytes())
            .map_err(|e| format!("Write failed: {}", e))?;
        writer.flush().map_err(|e| format!("Flush failed: {}", e))?;
    }

    Ok(())
}

/// Resize a terminal session's PTY.
#[tauri::command]
pub async fn ide_terminal_resize(
    state: State<'_, AppState>,
    terminal_id: String,
    _cols: u16,
    _rows: u16,
) -> Result<(), String> {
    // PTY resize requires holding the MasterPty handle.
    // Since we currently don't store it in the session, this is a no-op.
    // The frontend xterm.js handles visual reflow on its own.
    let _ = (state, terminal_id, _cols, _rows);
    Ok(())
}

/// Destroy a terminal session.
#[tauri::command]
pub async fn ide_terminal_destroy(
    state: State<'_, AppState>,
    terminal_id: String,
) -> Result<(), String> {
    let mut registry = state.terminals.lock().await;
    if let Some(mut session) = registry.sessions.remove(&terminal_id) {
        // Drop writer to signal EOF
        session.writer.take();
        // Kill the process
        let _ = session.child.kill();
        Ok(())
    } else {
        Err(format!("Terminal '{}' not found", terminal_id))
    }
}

// ─── File Watcher (Event Bridge) ───────────────────────────────────────────

/// Start watching a project directory for file changes.
/// Emits `ide-file-changed` events when files are modified externally
/// (e.g., by Koi agents writing via file_write tool).
#[tauri::command]
pub async fn ide_start_watcher(
    app: AppHandle,
    state: State<'_, AppState>,
    project_dir: String,
) -> Result<(), String> {
    use notify::{Config, Event, RecommendedWatcher, RecursiveMode, Watcher};

    let root = PathBuf::from(&project_dir);
    if !root.exists() {
        return Err(format!("Directory not found: {}", project_dir));
    }

    // Check if already watching
    {
        let watchers = state.file_watchers.lock().await;
        if watchers.contains_key(&project_dir) {
            return Ok(()); // Already watching
        }
    }

    let app_clone = app.clone();
    let dir = project_dir.clone();

    let mut watcher = RecommendedWatcher::new(
        move |res: Result<Event, notify::Error>| {
            if let Ok(event) = res {
                // Filter to relevant events
                match event.kind {
                    notify::EventKind::Modify(_)
                    | notify::EventKind::Create(_)
                    | notify::EventKind::Remove(_) => {
                        for path in &event.paths {
                            let rel = path
                                .strip_prefix(&dir)
                                .unwrap_or(path)
                                .to_string_lossy()
                                .to_string();

                            // Normalize to forward slashes. On Windows the native
                            // separator is `\\`, but the IDE's `tab.path` always
                            // uses `/` (that's how `openFile` stores it, how
                            // `FileTree` reports node paths, and how `ideApi.readFile`
                            // builds the full path). Emitting the raw OS path
                            // meant `tab.path === evt.path` silently failed on
                            // Windows and the editor never reloaded files that
                            // agents / external tools changed.
                            let rel_norm = rel.replace('\\', "/");
                            if rel_norm == ".git"
                                || rel_norm.starts_with(".git/")
                                || rel_norm.contains("/node_modules/")
                                || rel_norm.contains("/.koi-worktrees/")
                            {
                                continue;
                            }

                            let kind = match event.kind {
                                notify::EventKind::Create(_) => "created",
                                notify::EventKind::Modify(_) => "modified",
                                notify::EventKind::Remove(_) => "deleted",
                                _ => "unknown",
                            };

                            let _ = app_clone.emit(
                                "ide-file-changed",
                                serde_json::json!({
                                    "project_dir": dir,
                                    "path": rel_norm,
                                    "kind": kind,
                                }),
                            );
                        }
                    }
                    _ => {}
                }
            }
        },
        Config::default(),
    )
    .map_err(|e| format!("Failed to create watcher: {}", e))?;

    watcher
        .watch(&root, RecursiveMode::Recursive)
        .map_err(|e| format!("Failed to watch: {}", e))?;

    // Store the watcher to keep it alive
    {
        let mut watchers = state.file_watchers.lock().await;
        watchers.insert(project_dir, watcher);
    }

    Ok(())
}

/// Stop watching a project directory.
#[tauri::command]
pub async fn ide_stop_watcher(
    state: State<'_, AppState>,
    project_dir: String,
) -> Result<(), String> {
    let mut watchers = state.file_watchers.lock().await;
    watchers.remove(&project_dir);
    Ok(())
}

// ─── Helpers ───────────────────────────────────────────────────────────────

/// Build a `git` command that never opens a console window on Windows.
///
/// Thin wrapper over [`pisci_kernel::proc::tokio_command`] kept as a named
/// helper so all git invocations remain grep-able.
fn new_git_cmd() -> Command {
    tokio_command("git")
}

async fn run_git_cmd(dir: &Path, args: &[&str]) -> Result<String, String> {
    let output = timeout(
        Duration::from_secs(30),
        new_git_cmd()
            .args(args)
            .current_dir(dir)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .output(),
    )
    .await
    .map_err(|_| "git command timed out")?
    .map_err(|e| format!("git command failed: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("git error: {}", stderr.trim()));
    }

    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

// ─── LSP Commands ──────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
pub struct LspLanguageInfo {
    pub language_id: String,
    pub name: String,
    pub extensions: Vec<String>,
    pub server_command: String,
    pub available: bool,
}

/// List all supported LSP languages with their availability status.
#[tauri::command]
pub async fn ide_lsp_list_languages() -> Result<Vec<LspLanguageInfo>, String> {
    Ok(LspManager::supported_languages()
        .into_iter()
        .map(|l| LspLanguageInfo {
            language_id: l.language_id,
            name: l.name,
            extensions: l.extensions,
            server_command: l.server_command,
            available: l.available,
        })
        .collect())
}

/// Start an LSP server for the given project directory and language.
/// Returns the WebSocket port the Monaco Editor can connect to.
#[tauri::command]
pub async fn ide_lsp_start(
    state: tauri::State<'_, crate::store::AppState>,
    project_dir: String,
    language: String,
) -> Result<u16, String> {
    state.lsp_manager.start(&project_dir, &language).await
}

/// Stop an LSP session for the given project + language.
#[tauri::command]
pub async fn ide_lsp_stop(
    state: tauri::State<'_, crate::store::AppState>,
    project_dir: String,
    language: String,
) -> Result<(), String> {
    state.lsp_manager.stop(&project_dir, &language).await
}
