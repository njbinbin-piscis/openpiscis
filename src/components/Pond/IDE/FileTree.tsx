import { useState, useCallback } from "react";
import type { FileNode } from "./types";

interface FileTreeProps {
  nodes: FileNode[];
  activePath: string | null;
  gitModified: Set<string>;
  gitAdded: Set<string>;
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
  onFileClick,
  onRefresh,
}: FileTreeProps) {
  return (
    <>
      <div className="ide-sidebar-header">
        <span>Explorer</span>
        <button onClick={onRefresh} title="Refresh">↻</button>
      </div>
      {nodes.length === 0 ? (
        <div style={{ padding: 12, opacity: 0.5, fontSize: 12 }}>
          No files found
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
