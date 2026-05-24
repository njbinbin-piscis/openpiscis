/**
 * Tauri IPC — IDE domain.
 *
 * Wraps Rust-side `src-tauri/src/commands/ide.rs` commands for the
 * embedded Monaco Editor IDE inside the Pond collaboration workspace.
 */
import { invoke } from "@tauri-apps/api/core";
import { listen, UnlistenFn } from "@tauri-apps/api/event";

import type {
  FileNode,
  FileContent,
  SearchResult,
  GitFileStatus,
  DiffResult,
  BranchInfo,
} from "../../components/Pond/IDE/types";

// ─── File operations ─────────────────────────────────────────────────────

export const ideApi = {
  listFiles: (projectDir: string, depth?: number) =>
    invoke<FileNode[]>("ide_list_files", { projectDir, depth }),

  readFile: (path: string) => invoke<FileContent>("ide_read_file", { path }),

  writeFile: (path: string, content: string) =>
    invoke<void>("ide_write_file", { path, content }),

  fileAction: (path: string, action: string, newPath?: string) =>
    invoke<void>("ide_file_action", { path, action, newPath }),

  searchFiles: (
    projectDir: string,
    query: string,
    filePattern?: string,
    caseSensitive?: boolean,
  ) =>
    invoke<SearchResult[]>("ide_search_files", {
      projectDir,
      query,
      filePattern,
      caseSensitive,
    }),

  // ─── Git operations ──────────────────────────────────────────────────

  gitStatus: (projectDir: string) =>
    invoke<GitFileStatus[]>("ide_git_status", { projectDir }),

  gitDiff: (projectDir: string, path: string, base?: string) =>
    invoke<DiffResult>("ide_git_diff", { projectDir, path, base }),

  gitBranches: (projectDir: string) =>
    invoke<BranchInfo[]>("ide_git_branches", { projectDir }),

  gitFileAtRef: (projectDir: string, path: string, gitRef: string) =>
    invoke<FileContent>("ide_git_file_at_ref", { projectDir, path, gitRef }),

  gitAdd: (projectDir: string, path: string) =>
    invoke<void>("ide_git_add", { projectDir, path }),

  gitReset: (projectDir: string, path: string) =>
    invoke<void>("ide_git_reset", { projectDir, path }),

  gitAddAll: (projectDir: string) =>
    invoke<void>("ide_git_add_all", { projectDir }),

  gitResetAll: (projectDir: string) =>
    invoke<void>("ide_git_reset_all", { projectDir }),

  gitCommit: (projectDir: string, message: string) =>
    invoke<string>("ide_git_commit", { projectDir, message }),

  gitCheckout: (projectDir: string, branch: string) =>
    invoke<string>("ide_git_checkout", { projectDir, branch }),

  gitCreateBranch: (projectDir: string, branch: string) =>
    invoke<string>("ide_git_create_branch", { projectDir, branch }),

  // ─── Terminal ────────────────────────────────────────────────────────

  terminalCreate: (
    terminalId: string,
    projectDir: string,
    cols?: number,
    rows?: number,
  ) =>
    invoke<void>("ide_terminal_create", {
      terminalId,
      projectDir,
      cols,
      rows,
    }),

  terminalWrite: (terminalId: string, data: string) =>
    invoke<void>("ide_terminal_write", { terminalId, data }),

  terminalResize: (terminalId: string, cols: number, rows: number) =>
    invoke<void>("ide_terminal_resize", { terminalId, cols, rows }),

  terminalDestroy: (terminalId: string) =>
    invoke<void>("ide_terminal_destroy", { terminalId }),

  // ─── File watcher ──────────────────────────────────────────────────

  startWatcher: (projectDir: string) =>
    invoke<void>("ide_start_watcher", { projectDir }),

  stopWatcher: (projectDir: string) =>
    invoke<void>("ide_stop_watcher", { projectDir }),
};

// ─── Event listeners ─────────────────────────────────────────────────────

export interface TerminalOutputEvent {
  id: string;
  data: string;
}

export interface FileChangedEvent {
  project_dir: string;
  path: string;
  kind: "created" | "modified" | "deleted";
}

export function onTerminalOutput(
  cb: (event: TerminalOutputEvent) => void,
): Promise<UnlistenFn> {
  return listen<TerminalOutputEvent>("ide-terminal-output", (e) => cb(e.payload));
}

export function onFileChanged(
  cb: (event: FileChangedEvent) => void,
): Promise<UnlistenFn> {
  return listen<FileChangedEvent>("ide-file-changed", (e) => cb(e.payload));
}
