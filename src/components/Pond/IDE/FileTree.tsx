import {
  useState, useCallback, useRef, useEffect, useMemo,
  type Ref, type MutableRefObject,
} from "react";
import { useTranslation } from "react-i18next";
import { ideApi } from "../../../services/tauri/ide";
import type { FileNode } from "./types";

/** Right-click context menu position + the path that was right-clicked. */
export interface FileTreeContextMenu {
  x: number;
  y: number;
  /** Path of the node that was right-clicked. May differ from the
   *  current `activePath` (the primary selected node). */
  targetPath: string;
}

interface FileTreeProps {
  nodes: FileNode[];
  activePath: string | null;
  /** Set of all currently selected paths (Ctrl/Cmd multi-select). */
  selectedPaths: Set<string>;
  gitModified: Set<string>;
  gitAdded: Set<string>;
  projectDir: string | null;
  onFileClick: (node: FileNode) => void;
  onRefresh: () => void;
  onSelect: (path: string, opts: { multi: boolean }) => void;
  onContextMenu: (menu: FileTreeContextMenu) => void;
  /** Optional ref to the scrollable tree root (for context-menu actions). */
  containerRef?: Ref<HTMLDivElement>;
  depth?: number;
}

/** Inline creation state: which parent dir, creating file vs dir */
interface CreatingState {
  /** Parent directory relative to project root (empty string = project root). */
  parentPath: string;
  isDir: boolean;
}

/** Join project root with a tree-relative path for Tauri `ide_file_action` / read / write. */
function joinProjectPath(projectDir: string, relativePath: string): string {
  const root = projectDir.replace(/[/\\]+$/, "");
  const rel = relativePath.replace(/^[/\\]+/, "");
  if (!rel) return root;
  const sep = root.includes("\\") ? "\\" : "/";
  return `${root}${sep}${rel}`;
}

function basenameFromPath(path: string): string {
  const sep = path.includes("\\") ? "\\" : "/";
  const i = path.lastIndexOf(sep);
  return i >= 0 ? path.slice(i + 1) : path;
}

/** Inline rename state: the node currently being renamed. */
interface RenamingState {
  path: string;
  name: string;
  isDir: boolean;
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

// ─── Inline name input (used for both create + rename) ──────────────────

function InlineInput({
  depth,
  isDir,
  initialValue,
  onCommit,
  onCancel,
}: {
  depth: number;
  isDir: boolean;
  initialValue?: string;
  onCommit: (name: string) => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState(initialValue ?? "");

  useEffect(() => {
    requestAnimationFrame(() => {
      ref.current?.focus();
      if (initialValue) {
        // Select the filename (without extension) for rename UX parity with VS Code
        const dot = initialValue.lastIndexOf(".");
        ref.current?.setSelectionRange(0, dot > 0 ? dot : initialValue.length);
      }
    });
  }, [initialValue]);

  const commit = () => {
    const trimmed = value.trim();
    if (trimmed && trimmed !== initialValue) onCommit(trimmed);
    else onCancel();
  };

  return (
    <div
      className={`file-tree-item file-tree-inline-input ${isDir ? "dir" : "file"}`}
      style={{ paddingLeft: 8 + depth * 12 }}
    >
      <span className="icon">{isDir ? "▶" : " "}</span>
      <input
        ref={ref}
        className="file-tree-name-input"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") { e.preventDefault(); commit(); }
          else if (e.key === "Escape") { e.preventDefault(); onCancel(); }
        }}
        onBlur={commit}
        spellCheck={false}
        autoComplete="off"
      />
    </div>
  );
}

// ─── Tree node ──────────────────────────────────────────────────────────

function TreeNode({
  node,
  activePath,
  selectedPaths,
  gitModified,
  gitAdded,
  onFileClick,
  onSelect,
  onContextMenu,
  depth,
  creating,
  renaming,
  onCommitCreate,
  onCancelCreate,
  onStartRename,
  onCommitRename,
  onCancelRename,
}: {
  node: FileNode;
  activePath: string | null;
  selectedPaths: Set<string>;
  gitModified: Set<string>;
  gitAdded: Set<string>;
  onFileClick: (node: FileNode) => void;
  onSelect: (path: string, opts: { multi: boolean }) => void;
  onContextMenu: (menu: FileTreeContextMenu) => void;
  depth: number;
  creating: CreatingState | null;
  renaming: RenamingState | null;
  onCommitCreate: (name: string) => void;
  onCancelCreate: () => void;
  onStartRename: (path: string) => void;
  onCommitRename: (name: string) => void;
  onCancelRename: () => void;
}) {
  const isCreateTarget = creating != null && creating.parentPath === node.path;
  const isRenaming = renaming?.path === node.path;
  const [expanded, setExpanded] = useState(depth < 2 || !!isCreateTarget);

  useEffect(() => {
    if (isCreateTarget) setExpanded(true);
  }, [isCreateTarget]);

  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      const multi = e.ctrlKey || e.metaKey;
      onSelect(node.path, { multi });
      if (!multi) {
        if (node.is_dir) {
          setExpanded((x) => !x);
        } else {
          onFileClick(node);
        }
      }
    },
    [node, onFileClick, onSelect],
  );

  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      // If the right-clicked node isn't in the current selection,
      // make it the sole selection (VS Code behavior).
      if (!selectedPaths.has(node.path)) {
        onSelect(node.path, { multi: false });
      }
      onContextMenu({ x: e.clientX, y: e.clientY, targetPath: node.path });
    },
    [node.path, selectedPaths, onSelect, onContextMenu],
  );

  const isActive = node.path === activePath;
  const isSelected = selectedPaths.has(node.path);
  const isModified = gitModified.has(node.path);
  const isAdded = gitAdded.has(node.path);

  const classNames = [
    "file-tree-item",
    node.is_dir ? "dir" : "file",
    isActive ? "active" : "",
    isSelected && !isActive ? "selected" : "",
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
        onContextMenu={handleContextMenu}
        title={node.path}
      >
        <span className="icon">
          {node.is_dir ? (expanded ? "▼" : "▶") : getFileIcon(node.name)}
        </span>
        {isRenaming ? (
          <input
            className="file-tree-name-input"
            defaultValue={node.name}
            autoFocus
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                const v = (e.target as HTMLInputElement).value.trim();
                if (v && v !== node.name) onCommitRename(v);
                else onCancelRename();
              } else if (e.key === "Escape") {
                e.preventDefault();
                onCancelRename();
              }
            }}
            onBlur={(e) => {
              const v = e.target.value.trim();
              if (v && v !== node.name) onCommitRename(v);
              else onCancelRename();
            }}
            spellCheck={false}
            autoComplete="off"
          />
        ) : (
          <span className="name">{node.name}</span>
        )}
      </div>
      {node.is_dir && expanded && (
        <div>
          {isCreateTarget && (
            <InlineInput
              depth={depth + 1}
              isDir={creating!.isDir}
              onCommit={onCommitCreate}
              onCancel={onCancelCreate}
            />
          )}
          {node.children?.map((child) => (
            <TreeNode
              key={child.path}
              node={child}
              activePath={activePath}
              selectedPaths={selectedPaths}
              gitModified={gitModified}
              gitAdded={gitAdded}
              onFileClick={onFileClick}
              onSelect={onSelect}
              onContextMenu={onContextMenu}
              depth={depth + 1}
              creating={creating}
              renaming={renaming}
              onCommitCreate={onCommitCreate}
              onCancelCreate={onCancelCreate}
              onStartRename={onStartRename}
              onCommitRename={onCommitRename}
              onCancelRename={onCancelRename}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── FileTree root ──────────────────────────────────────────────────────

export default function FileTree({
  nodes,
  activePath,
  selectedPaths,
  gitModified,
  gitAdded,
  projectDir,
  onFileClick,
  onRefresh,
  onSelect,
  onContextMenu,
  containerRef,
}: FileTreeProps) {
  const { t } = useTranslation();
  const [creating, setCreating] = useState<CreatingState | null>(null);
  const [renaming, setRenaming] = useState<RenamingState | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  /** Determine the target parent directory for a new file/folder based on
   *  the currently selected path. If a directory is selected, create inside
   *  it. If a file is selected, create inside its parent (sibling level).
   *  If nothing is selected, create at the project root. */
  const resolveParentPath = useCallback((): string | null => {
    if (!projectDir) return null;
    if (!activePath) return projectDir;
    const findNode = (nodes: FileNode[], path: string): FileNode | null => {
      for (const n of nodes) {
        if (n.path === path) return n;
        if (n.children) {
          const found = findNode(n.children, path);
          if (found) return found;
        }
      }
      return null;
    };
    const selected = findNode(nodes, activePath);
    if (!selected) return projectDir;
    if (selected.is_dir) return selected.path;
    const sep = selected.path.includes("\\") ? "\\" : "/";
    const lastSep = selected.path.lastIndexOf(sep);
    return lastSep > 0 ? selected.path.substring(0, lastSep) : projectDir;
  }, [activePath, nodes, projectDir]);

  const startCreate = useCallback(
    (isDir: boolean) => {
      const parentPath = resolveParentPath();
      if (!parentPath) return;
      setCreating({ parentPath, isDir });
    },
    [resolveParentPath],
  );

  const commitCreate = useCallback(
    async (name: string) => {
      if (!creating || !projectDir) return;
      const sep = "/";
      const rel = creating.parentPath ? `${creating.parentPath}${sep}${name}` : name;
      try {
        await ideApi.fileAction(
          joinProjectPath(projectDir, rel),
          creating.isDir ? "create_dir" : "create_file",
        );
        setCreating(null);
        onRefresh();
      } catch (e) {
        console.error("FileTree create failed:", e);
        window.alert(String(e));
      }
    },
    [creating, onRefresh, projectDir],
  );

  const cancelCreate = useCallback(() => setCreating(null), []);

  // ── Rename ─────────────────────────────────────────────────────────
  const startRename = useCallback(
    (path: string) => {
      const findNode = (nodes: FileNode[], p: string): FileNode | null => {
        for (const n of nodes) {
          if (n.path === p) return n;
          if (n.children) {
            const found = findNode(n.children, p);
            if (found) return found;
          }
        }
        return null;
      };
      const node = findNode(nodes, path);
      if (!node) return;
      setRenaming({ path: node.path, name: node.name, isDir: !!node.is_dir });
    },
    [nodes],
  );

  const commitRename = useCallback(
    async (newName: string) => {
      if (!renaming || !projectDir) return;
      const sep = "/";
      const lastSep = renaming.path.lastIndexOf(sep);
      const parent = lastSep > 0 ? renaming.path.substring(0, lastSep) : "";
      const newRel = parent ? `${parent}${sep}${newName}` : newName;
      try {
        await ideApi.fileAction(
          joinProjectPath(projectDir, renaming.path),
          "rename",
          joinProjectPath(projectDir, newRel),
        );
        setRenaming(null);
        onRefresh();
      } catch (e) {
        console.error("FileTree rename failed:", e);
        window.alert(String(e));
      }
    },
    [renaming, onRefresh, projectDir],
  );

  const cancelRename = useCallback(() => setRenaming(null), []);

  // ── Keyboard shortcuts (Delete / F2 / Ctrl+N / Ctrl+Shift+N) ────────
  // Memoized list of selected node info so we can dispatch bulk deletes.
  const selectedNodeInfo = useMemo(() => {
    const info: Array<{ path: string; isDir: boolean }> = [];
    const walk = (list: FileNode[]) => {
      for (const n of list) {
        if (selectedPaths.has(n.path)) info.push({ path: n.path, isDir: !!n.is_dir });
        if (n.children) walk(n.children);
      }
    };
    walk(nodes);
    return info;
  }, [nodes, selectedPaths]);

  // We intentionally expose these to the parent through an imperative-style
  // keyboard handler. The IDE attaches a global `keydown` listener and
  // calls `deleteSelected()` / `renameActive()` via a ref.
  const deleteSelected = useCallback(async () => {
    if (selectedNodeInfo.length === 0 || !projectDir) return;
    const count = selectedNodeInfo.length;
    const hasDir = selectedNodeInfo.some((n) => n.isDir);
    const msgKey = count === 1
      ? (hasDir ? "ide.confirmDeleteFolder" : "ide.confirmDeleteFile")
      : "ide.confirmDeleteMany";
    const name = count === 1 ? basenameFromPath(selectedNodeInfo[0].path) : undefined;
    const msg =
      t(msgKey, { count, name: name ?? "" }) ||
      (count === 1
        ? `Delete ${hasDir ? "folder" : "file"} "${name}"?`
        : `Delete ${count} items?`);
    // eslint-disable-next-line no-alert
    if (!window.confirm(msg)) return;
    // Delete in reverse-path order so children come before parents (avoids
    // the "parent already gone" failure when both are in the selection).
    const ordered = [...selectedNodeInfo].sort((a, b) => b.path.localeCompare(a.path));
    const failures: string[] = [];
    for (const item of ordered) {
      const absPath = joinProjectPath(projectDir, item.path);
      try {
        await ideApi.fileAction(absPath, "delete");
      } catch (e) {
        console.error("FileTree delete failed:", absPath, e);
        failures.push(`${item.path}: ${e}`);
      }
    }
    if (failures.length > 0) {
      window.alert(failures.join("\n"));
    }
    onRefresh();
  }, [selectedNodeInfo, onRefresh, projectDir, t]);

  const renameActive = useCallback(() => {
    if (!activePath) return;
    startRename(activePath);
  }, [activePath, startRename]);

  // Expose imperative-style methods on the root DOM node via dataset attrs
  // so the IDE can call them from its own keydown handler.
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    (el as unknown as { deleteSelected?: () => void }).deleteSelected = deleteSelected;
    (el as unknown as { renameActive?: () => void }).renameActive = renameActive;
    (el as unknown as { startCreate?: (isDir: boolean) => void }).startCreate = startCreate;
  }, [deleteSelected, renameActive, startCreate]);

  useEffect(() => {
    const el = rootRef.current;
    if (!el || !containerRef) return;
    if (typeof containerRef === "function") {
      containerRef(el);
    } else if ("current" in containerRef) {
      (containerRef as MutableRefObject<HTMLDivElement | null>).current = el;
    }
  }, [containerRef, nodes.length, creating, renaming]);

  const isRootCreate = creating && creating.parentPath === "";

  return (
    <>
      <div className="ide-sidebar-header">
        <span>{t("ide.explorer") || "Explorer"}</span>
        <div className="ide-sidebar-header-actions">
          <button
            type="button"
            onClick={() => startCreate(false)}
            disabled={!projectDir}
            title={t("ide.newFile") || "New File"}
            aria-label={t("ide.newFile") || "New File"}
          >
            📄+
          </button>
          <button
            type="button"
            onClick={() => startCreate(true)}
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
      {nodes.length === 0 && !creating ? (
        <div style={{ padding: 12, opacity: 0.5, fontSize: 12 }}>
          {t("ide.noFiles") || "No files found"}
        </div>
      ) : (
        <div className="file-tree-root" ref={rootRef} tabIndex={0}>
          {isRootCreate && (
            <InlineInput
              depth={0}
              isDir={creating!.isDir}
              onCommit={commitCreate}
              onCancel={cancelCreate}
            />
          )}
          {nodes.map((node) => (
            <TreeNode
              key={node.path}
              node={node}
              activePath={activePath}
              selectedPaths={selectedPaths}
              gitModified={gitModified}
              gitAdded={gitAdded}
              onFileClick={onFileClick}
              onSelect={onSelect}
              onContextMenu={onContextMenu}
              depth={0}
              creating={creating}
              renaming={renaming}
              onCommitCreate={commitCreate}
              onCancelCreate={cancelCreate}
              onStartRename={startRename}
              onCommitRename={commitRename}
              onCancelRename={cancelRename}
            />
          ))}
        </div>
      )}
    </>
  );
}
