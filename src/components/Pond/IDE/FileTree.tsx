import { useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { ideApi } from "../../../services/tauri/ide";
import type { FileNode } from "./types";

interface FileTreeProps {
  nodes: FileNode[];
  activePath: string | null;
  gitModified: Set<string>;
  gitAdded: Set<string>;
  projectDir: string | null;
  onFileClick: (node: FileNode) => void;
  onRefresh: () => void;
  depth?: number;
}

function getFileIcon(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() || "";
  const iconMap: Record<string, string> = {
    ts: "TS", tsx: "TX", js: "JS", jsx: "JX",
    rs: "RS", py: "PY", go: "GO", java: "JV",
    c: "C", h: "H", cpp: "C+", hpp: "H+",
    json: "{}", yaml: "YM", yml: "YM", toml: "TM",
    md: "MD", txt: "TX", html: "HT", css: "CS",
    scss: "SC", less: "LS", svg: "SV", png: "PN",
    sh: "SH", ps1: "PS", sql: "SQ", lock: "LK",
  };
  return iconMap[ext] || " ";
}

function TreeNode({
  node,
  activePath,
  gitModified,
  gitAdded,
  onFileClick,
  depth,
}: {
  node: FileNode;
  activePath: string | null;
  gitModified: Set<string>;
  gitAdded: Set<string>;
  onFileClick: (node: FileNode) => void;
  depth: number;
}) {
  const [expanded, setExpanded] = useState(depth < 2);

  const handleClick = useCallback(() => {
    if (node.is_dir) {
      setExpanded((e) => !e);
    } else {
      onFileClick(node);
    }
  }, [node, onFileClick]);

  const isActive = node.path === activePath;
  const isModified = gitModified.has(node.path);
  const isAdded = gitAdded.has(node.path);

  const classNames = [
    "file-tree-item",
    node.is_dir ? "dir" : "file",
    isActive ? "active" : "",
    isModified ? "git-modified" : "",
    isAdded ? "git-added" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div>
      <div
        className={classNames}
        style={{ paddingLeft: 8 + depth * 12 }}
        onClick={handleClick}
        title={node.path}
      >
        <span className="icon">
          {node.is_dir ? (expanded ? "▼" : "▶") : getFileIcon(node.name)}
        </span>
        <span className="name">{node.name}</span>
      </div>
      {node.is_dir && expanded && node.children && (
        <div>
          {node.children.map((child) => (
            <TreeNode
              key={child.path}
              node={child}
              activePath={activePath}
              gitModified={gitModified}
              gitAdded={gitAdded}
              onFileClick={onFileClick}
              depth={depth + 1}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export default function FileTree({
  nodes,
  activePath,
  gitModified,
  gitAdded,
  projectDir,
  onFileClick,
  onRefresh,
}: FileTreeProps) {
  const { t } = useTranslation();

  const handleCreate = useCallback(
    async (isDir: boolean) => {
      if (!projectDir) return;
      const promptKey = isDir ? "ide.newFolderPrompt" : "ide.newFilePrompt";
      const name = window.prompt(t(promptKey));
      if (!name || !name.trim()) return;
      const trimmed = name.trim();
      // Construct full path. Use forward slashes — Rust's PathBuf
      // accepts them on Windows too, and the backend already calls
      // create_dir_all on parent before write.
      const sep = projectDir.includes("\\") ? "\\" : "/";
      const fullPath = `${projectDir}${sep}${trimmed}`;
      try {
        await ideApi.fileAction(fullPath, isDir ? "create_dir" : "create_file");
        onRefresh();
      } catch (e) {
        // Surface as a non-blocking alert so the user knows what failed.
        window.alert(`${t(isDir ? "ide.newFolder" : "ide.newFile")}: ${String(e)}`);
      }
    },
    [projectDir, onRefresh, t],
  );

  return (
    <>
      <div className="ide-sidebar-header">
        <span>{t("ide.explorer") || "Explorer"}</span>
        <div className="ide-sidebar-header-actions">
          <button
            type="button"
            onClick={() => handleCreate(false)}
            disabled={!projectDir}
            title={t("ide.newFile") || "New File"}
            aria-label={t("ide.newFile") || "New File"}
          >
            📄+
          </button>
          <button
            type="button"
            onClick={() => handleCreate(true)}
            disabled={!projectDir}
            title={t("ide.newFolder") || "New Folder"}
            aria-label={t("ide.newFolder") || "New Folder"}
          >
            📁+
          </button>
          <button
            type="button"
            onClick={onRefresh}
            title={t("ide.refresh") || "Refresh"}
            aria-label={t("ide.refresh") || "Refresh"}
          >
            ↻
          </button>
        </div>
      </div>
      {nodes.length === 0 ? (
        <div style={{ padding: 12, opacity: 0.5, fontSize: 12 }}>
          {t("ide.noFiles") || "No files found"}
        </div>
      ) : (
        nodes.map((node) => (
          <TreeNode
            key={node.path}
            node={node}
            activePath={activePath}
            gitModified={gitModified}
            gitAdded={gitAdded}
            onFileClick={onFileClick}
            depth={0}
          />
        ))
      )}
    </>
  );
}
