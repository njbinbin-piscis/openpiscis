import { useRef, useEffect, useCallback } from "react";
import Editor, { DiffEditor, type OnMount } from "@monaco-editor/react";
import type { OpenTab } from "./types";
import {
  lspApi,
  languageForFile,
  LspClient,
  registerLspProviders,
  type LspProvidersRegistration,
} from "../../../services/tauri/lsp";

interface CodeEditorProps {
  tab: OpenTab;
  theme: string;
  projectDir: string | null;
  onChange: (value: string) => void;
  onSave?: () => void;
}

export default function CodeEditor({ tab, theme, projectDir, onChange, onSave }: CodeEditorProps) {
  const editorRef = useRef<ReturnType<OnMount> extends void ? unknown : null>(null);
  const lspRef = useRef<LspProvidersRegistration | null>(null);

  // Track the content currently in the editor so we can distinguish:
  //   * Monaco's `onChange` firing during initial `value` hydration / tab
  //     switches (same content → must NOT mark dirty)
  //   * A genuine user keystroke (different content → mark dirty)
  //
  // Without this, opening the 2nd/3rd file triggered a spurious dirty dot
  // because Monaco re-emits onChange with the same content after the parent
  // re-renders the <Editor> with a new `value` prop.
  const lastContentRef = useRef<string>(tab.content);

  // Update lastContentRef synchronously when the tab changes, BEFORE
  // Monaco's onChange fires during the render pass. The useEffect below
  // also sets it (for safety), but that runs AFTER render — too late,
  // because @monaco-editor/react's internal model update + onChange
  // callback happen during the React commit phase.
  const lastPathRef = useRef<string>(tab.path);
  if (tab.path !== lastPathRef.current) {
    // Different file entirely — reset tracked content so the next
    // onChange (which fires with the new file's content during Monaco
    // hydration) does NOT mark the tab dirty.
    lastContentRef.current = tab.content;
    lastPathRef.current = tab.path;
  }

  // Stable ref for the latest onSave callback so Monaco's Ctrl+S command
  // does not need to be re-registered every render.
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;

  // Stable ref for the latest onChange callback so the Monaco command
  // closure always sees the current callback without being recreated.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const handleMount: OnMount = useCallback(
    (editor, monaco) => {
      editorRef.current = editor;
      // Add Ctrl+S / Cmd+S save shortcut — delegates to the parent's onSave
      // so the actual disk write (ideApi.writeFile) runs from the IDE layer
      // where tab state + project dir live.
      editor.addCommand(
        // eslint-disable-next-line no-bitwise
        2048 | 49, // KeyMod.CtrlCmd | KeyCode.KeyS
        () => {
          onSaveRef.current?.();
        },
      );

      // ── LSP integration ────────────────────────────────────────────
      const lang = tab.language || languageForFile(tab.path);
      const fullPath = projectDir ? `${projectDir}/${tab.path}` : tab.path;

      if (lang && projectDir) {
        // Clean up previous LSP connection
        lspRef.current?.dispose();
        lspRef.current = null;

        lspApi
          .start(projectDir, lang)
          .then(async (port) => {
            const client = new LspClient(port);
            try {
              await client.connect(
                projectDir,
                lang,
                fullPath,
                tab.content,
              );
              const reg = registerLspProviders(
                monaco as Parameters<typeof registerLspProviders>[0],
                client,
                fullPath,
              );
              lspRef.current = reg;

              // Trigger initial diagnostics
              client.requestDiagnostics(fullPath);
            } catch (e) {
              console.warn("[LSP] Failed to connect:", e);
            }
          })
          .catch((e) => {
            // LSP server may not be available — that's fine
            console.debug("[LSP] Server not available for", lang, ":", e);
          });
      }
    },
    [tab.path, tab.language, tab.content, projectDir],
  );

  useEffect(() => {
    // Update editor content when tab changes.
    // Monaco's `value` prop handles the initial set; calling setValue here
    // keeps the editor in sync when the user switches tabs (same editor
    // instance, different content). Track the content so the next onChange
    // can distinguish user edits from Monaco re-echoing the value.
    const editor = editorRef.current as { setValue?: (v: string) => void } | null;
    if (editor && typeof editor.setValue === "function") {
      editor.setValue(tab.content);
    }
    lastContentRef.current = tab.content;

    // Cleanup LSP on unmount
    return () => {
      lspRef.current?.dispose();
      lspRef.current = null;
    };
  }, [tab.path, tab.content]);

  if (tab.isDiff && tab.originalContent !== undefined) {
    return (
      <DiffEditor
        height="100%"
        theme="vs-dark"
        language={tab.language || "plaintext"}
        original={tab.originalContent}
        modified={tab.content}
        options={{
          readOnly: true,
          renderSideBySide: true,
          minimap: { enabled: false },
          fontSize: 13,
          fontFamily: 'Consolas, "Courier New", monospace',
          scrollBeyondLastLine: false,
        }}
      />
    );
  }

  return (
    <Editor
      height="100%"
      theme={theme === "gold" ? "vs-dark" : "vs-dark"}
      language={tab.language || "plaintext"}
      value={tab.content}
      onChange={(v) => {
        const next = v || "";
        // Only propagate to parent (which sets isDirty=true) when the
        // new content actually differs from what we last pushed in.
        // Monaco fires onChange with the same content during initial
        // hydration and after setValue() — those must be ignored or
        // switching tabs would show a spurious dirty dot.
        if (next !== lastContentRef.current) {
          lastContentRef.current = next;
          onChangeRef.current(next);
        }
      }}
      onMount={handleMount}
      options={{
        readOnly: tab.isReadOnly,
        minimap: { enabled: true },
        fontSize: 13,
        fontFamily: 'Consolas, "Courier New", monospace',
        scrollBeyondLastLine: false,
        wordWrap: "on",
        lineNumbers: "on",
        renderWhitespace: "selection",
        bracketPairColorization: { enabled: true },
        folding: true,
        automaticLayout: true,
        tabSize: 2,
      }}
    />
  );
}
