import { useState, useEffect, useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";
import FileTree from "./FileTree";
import EditorTabs from "./EditorTabs";
import CodeEditor from "./CodeEditor";
import TerminalPanel from "./Terminal";
import GitPanel from "./GitPanel";
import SearchPanel from "./SearchPanel";
import { ideApi, onFileChanged } from "../../../services/tauri/ide";
import type { FileNode, OpenTab, GitFileStatus } from "./types";
import "./IDE.css";

type SidebarTab = "explorer" | "search" | "git";

interface IDEProps {
  projectDir: string | null;
  poolSessionId: string | null;
}

export default function IDE({ projectDir, poolSessionId: _poolSessionId }: IDEProps) {
  const { t } = useTranslation();

  // File tree
  const [fileTree, setFileTree] = useState<FileNode[]>([]);

  // Open tabs
  const [tabs, setTabs] = useState<OpenTab[]>([]);
  const [activeTabPath, setActiveTabPath] = useState<string | null>(null);

  // Git status
  const [gitModified, setGitModified] = useState<Set<string>>(new Set());
  const [gitAdded, setGitAdded] = useState<Set<string>>(new Set());

  // UI state
  const [showTerminal, setShowTerminal] = useState(false);
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>("explorer");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  // Resizable panel widths
  const [sidebarWidth, setSidebarWidth] = useState(260);
  const [terminalHeight, setTerminalHeight] = useState(200);
  const ideRef = useRef<HTMLDivElement>(null);

  const activeTab = tabs.find((t) => t.path === activeTabPath) || null;

  // ─── Load file tree ──────────────────────────────────────────────
  const loadFileTree = useCallback(async () => {
    if (!projectDir) return;
    try {
      const nodes = await ideApi.listFiles(projectDir, 8);
      setFileTree(nodes);
    } catch (e) {
      console.error("Failed to load file tree:", e);
    }
  }, [projectDir]);

  // ─── Load git status ─────────────────────────────────────────────
  const loadGitStatus = useCallback(async () => {
    if (!projectDir) return;
    try {
      const statuses = await ideApi.gitStatus(projectDir);
      const modified = new Set<string>();
      const added = new Set<string>();
      statuses.forEach((s: GitFileStatus) => {
        if (s.status === "modified") modified.add(s.path);
        else if (s.status === "added" || s.status === "untracked") added.add(s.path);
      });
      setGitModified(modified);
      setGitAdded(added);
    } catch {
      // No git repo or error — ignore
    }
  }, [projectDir]);

  // ─── Panel resize drag handlers ──────────────────────────────────
  const startSidebarResize = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const startX = e.clientX;
      const startW = sidebarWidth;
      const onMove = (ev: MouseEvent) => {
        const delta = ev.clientX - startX;
        setSidebarWidth(Math.min(500, Math.max(220, startW + delta)));
      };
      const onUp = () => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    },
    [sidebarWidth],
  );

  const startTerminalResize = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const startY = e.clientY;
      const startH = terminalHeight;
      const onMove = (ev: MouseEvent) => {
        const delta = startY - ev.clientY;
        setTerminalHeight(Math.min(400, Math.max(120, startH + delta)));
      };
      const onUp = () => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
      document.body.style.cursor = "row-resize";
      document.body.style.userSelect = "none";
    },
    [terminalHeight],
  );

  // ─── Initialize ──────────────────────────────────────────────────
  // Debounce file-change refreshes: bursty external edits (Koi agents,
  // formatters, watch-mode builds) used to fire `loadFileTree`+`loadGitStatus`
  // dozens of times per second, which on Windows compounded the popup-loop
  // bug that v0.8.0 fixed at the watcher level. 250 ms trailing-edge is
  // slow enough to coalesce a save-burst yet fast enough to feel live.
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleRefresh = useCallback(() => {
    if (refreshTimer.current) clearTimeout(refreshTimer.current);
    refreshTimer.current = setTimeout(() => {
      refreshTimer.current = null;
      loadFileTree();
      loadGitStatus();
    }, 250);
  }, [loadFileTree, loadGitStatus]);

  useEffect(() => {
    if (!projectDir) return;
    loadFileTree();
    loadGitStatus();

    // Start file watcher
    ideApi.startWatcher(projectDir).catch(() => {});

    // Listen for file changes (from Koi agents or external edits)
    const unlistenPromise = onFileChanged((evt) => {
      if (evt.project_dir === projectDir) {
        // Refresh file tree and git status (debounced)
        scheduleRefresh();

        // If the changed file is open, reload its content
        setTabs((prev) =>
          prev.map((tab) => {
            if (tab.path === evt.path && !tab.isDirty) {
              // Reload content from disk
              const fullPath = `${projectDir}/${evt.path}`;
              ideApi.readFile(fullPath).then((fc) => {
                setTabs((p) =>
                  p.map((t) =>
                    t.path === evt.path && !t.isDirty
                      ? { ...t, content: fc.content }
                      : t,
                  ),
                );
              }).catch(() => {});
            }
            return tab;
          }),
        );
      }
    });

    return () => {
      if (refreshTimer.current) {
        clearTimeout(refreshTimer.current);
        refreshTimer.current = null;
      }
      unlistenPromise.then((fn) => fn());
      ideApi.stopWatcher(projectDir).catch(() => {});
    };
  }, [projectDir, loadFileTree, loadGitStatus, scheduleRefresh]);

  // ─── Open a file ─────────────────────────────────────────────────
  const openFile = useCallback(
    async (path: string, readOnly = false) => {
      // Check if already open
      const existing = tabs.find((t) => t.path === path);
      if (existing) {
        setActiveTabPath(path);
        return;
      }

      const fullPath = projectDir ? `${projectDir}/${path}` : path;
      try {
        const fc = await ideApi.readFile(fullPath);
        if (fc.is_binary) {
          return; // Don't open binary files
        }
        const newTab: OpenTab = {
          path,
          name: path.split("/").pop() || path,
          language: fc.language,
          content: fc.content,
          isDirty: false,
          isReadOnly: readOnly,
        };
        setTabs((prev) => [...prev, newTab]);
        setActiveTabPath(path);
      } catch (e) {
        console.error("Failed to read file:", e);
      }
    },
    [projectDir, tabs],
  );

  // ─── Open diff for a file ────────────────────────────────────────
  const openDiff = useCallback(
    async (path: string) => {
      if (!projectDir) return;
      const diffPath = `diff:${path}`;
      const existing = tabs.find((t) => t.path === diffPath);
      if (existing) {
        setActiveTabPath(diffPath);
        return;
      }

      try {
        const diff = await ideApi.gitDiff(projectDir, path);
        const newTab: OpenTab = {
          path: diffPath,
          name: `${path} (diff)`,
          language: null,
          content: diff.modified,
          isDirty: false,
          isReadOnly: true,
          isDiff: true,
          originalContent: diff.original,
        };
        setTabs((prev) => [...prev, newTab]);
        setActiveTabPath(diffPath);
      } catch (e) {
        console.error("Failed to get diff:", e);
      }
    },
    [projectDir, tabs],
  );

  // ─── Handle editor content change ───────────────────────────────
  const handleEditorChange = useCallback(
    (value: string) => {
      if (!activeTabPath) return;
      setTabs((prev) =>
        prev.map((t) =>
          t.path === activeTabPath
            ? { ...t, content: value, isDirty: true }
            : t,
        ),
      );
    },
    [activeTabPath],
  );

  // ─── Save file (Ctrl+S) ──────────────────────────────────────────
  const saveFile = useCallback(
    async (path: string) => {
      const tab = tabs.find((t) => t.path === path);
      if (!tab || !projectDir) return;
      const fullPath = `${projectDir}/${path}`;
      try {
        await ideApi.writeFile(fullPath, tab.content);
        setTabs((prev) =>
          prev.map((t) => (t.path === path ? { ...t, isDirty: false } : t)),
        );
        loadGitStatus();
      } catch (e) {
        console.error("Failed to save:", e);
      }
    },
    [tabs, projectDir, loadGitStatus],
  );

  // ─── Close tab ───────────────────────────────────────────────────
  const closeTab = useCallback(
    (path: string) => {
      setTabs((prev) => {
        const idx = prev.findIndex((t) => t.path === path);
        const next = prev.filter((t) => t.path !== path);
        if (activeTabPath === path) {
          const newActive = next[Math.min(idx, next.length - 1)] || null;
          setActiveTabPath(newActive?.path || null);
        }
        return next;
      });
    },
    [activeTabPath],
  );

  // ─── Keyboard shortcut: Ctrl+S to save ───────────────────────────
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "s") {
        e.preventDefault();
        if (activeTabPath && !activeTabPath.startsWith("diff:")) {
          saveFile(activeTabPath);
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [activeTabPath, saveFile]);

  // ─── No project dir placeholder ──────────────────────────────────
  if (!projectDir) {
    return (
      <div className="pond-ide">
        <div className="ide-no-project">
          <div className="icon">📂</div>
          <div>{t("ide.noProjectDir") || "No project directory configured for this pool."}</div>
          <div style={{ fontSize: 12, opacity: 0.6 }}>
            {t("ide.noProjectDirHint") ||
              "Set a project_dir on the pool session to enable the IDE."}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="pond-ide" ref={ideRef}>
      {/* Activity bar (icon strip) */}
      <div className="ide-activity-bar">
        <button
          className={sidebarTab === "explorer" && !sidebarCollapsed ? "active" : ""}
          onClick={() => { sidebarCollapsed ? setSidebarCollapsed(false) : setSidebarTab("explorer"); if (sidebarCollapsed) setSidebarTab("explorer"); else if (sidebarTab === "explorer") setSidebarCollapsed(true); else setSidebarTab("explorer"); }}
          title={t("ide.explorer") || "Explorer"}
        >
          <span className="activity-icon">📁</span>
        </button>
        <button
          className={sidebarTab === "search" && !sidebarCollapsed ? "active" : ""}
          onClick={() => { if (sidebarCollapsed) { setSidebarCollapsed(false); setSidebarTab("search"); } else if (sidebarTab === "search") setSidebarCollapsed(true); else setSidebarTab("search"); }}
          title={t("ide.search") || "Search"}
        >
          <span className="activity-icon">🔍</span>
        </button>
        <button
          className={sidebarTab === "git" && !sidebarCollapsed ? "active" : ""}
          onClick={() => { if (sidebarCollapsed) { setSidebarCollapsed(false); setSidebarTab("git"); } else if (sidebarTab === "git") setSidebarCollapsed(true); else setSidebarTab("git"); }}
          title={t("ide.sourceControl") || "Source Control"}
        >
          <span className="activity-icon">⑂</span>
          {(gitModified.size + gitAdded.size) > 0 && (
            <span className="activity-badge">{gitModified.size + gitAdded.size}</span>
          )}
        </button>
        <div style={{ flex: 1 }} />
        <button
          className={showTerminal ? "active" : ""}
          onClick={() => setShowTerminal((v) => !v)}
          title={t("ide.terminal") || "Terminal"}
        >
          <span className="activity-icon">⌨</span>
        </button>
      </div>

      {/* Sidebar content */}
      {!sidebarCollapsed && (
        <div className="ide-sidebar" style={{ width: sidebarWidth }}>
          {sidebarTab === "explorer" && (
            <FileTree
              nodes={fileTree}
              activePath={activeTabPath}
              gitModified={gitModified}
              gitAdded={gitAdded}
              onFileClick={(node) => openFile(node.path)}
              onRefresh={() => {
                loadFileTree();
                loadGitStatus();
              }}
            />
          )}
          {sidebarTab === "search" && (
            <SearchPanel
              projectDir={projectDir}
              onResultClick={(path, _line) => openFile(path)}
            />
          )}
          {sidebarTab === "git" && (
            <GitPanel
              projectDir={projectDir}
              onDiffClick={(path) => openDiff(path)}
              onRefresh={loadGitStatus}
            />
          )}
        </div>
      )}

      {/* Sidebar resize handle */}
      {!sidebarCollapsed && (
        <div
          className="ide-resize-handle-h"
          onMouseDown={startSidebarResize}
        />
      )}

      {/* Editor area */}
      <div className="ide-editor-area">
        <EditorTabs
          tabs={tabs}
          activeTabPath={activeTabPath}
          onTabClick={setActiveTabPath}
          onTabClose={closeTab}
        />
        <div className="ide-editor">
          {activeTab ? (
            <CodeEditor
              tab={activeTab}
              theme="violet"
              onChange={handleEditorChange}
            />
          ) : (
            <div className="ide-editor-welcome">
              <img src="/pisci.png" alt="Pisci" className="welcome-logo" />
              <div className="welcome-title">
                {t("ide.welcome") || "Select a file to start editing"}
              </div>
              <div className="welcome-hint">
                {t("ide.welcomeHint") ||
                  "Collaborate with Koi agents in the same project directory"}
              </div>
            </div>
          )}
        </div>

        {/* Terminal resize handle */}
        {showTerminal && (
          <div
            className="ide-resize-handle-v"
            onMouseDown={startTerminalResize}
          />
        )}

        <TerminalPanel
          projectDir={projectDir}
          visible={showTerminal}
          onClose={() => setShowTerminal(false)}
          height={terminalHeight}
        />
      </div>
    </div>
  );
}
