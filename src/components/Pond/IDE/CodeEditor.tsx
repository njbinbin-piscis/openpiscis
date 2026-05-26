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
}

export default function CodeEditor({ tab, theme, projectDir, onChange }: CodeEditorProps) {
  const editorRef = useRef<ReturnType<OnMount> extends void ? unknown : null>(null);
  const lspRef = useRef<LspProvidersRegistration | null>(null);

  const handleMount: OnMount = useCallback(
    (editor, monaco) => {
      editorRef.current = editor;
      // Add Ctrl+S / Cmd+S save shortcut
      editor.addCommand(
        // eslint-disable-next-line no-bitwise
        2048 | 49, // KeyMod.CtrlCmd | KeyCode.KeyS
        () => {
          // Save will be handled by parent via onChange + dirty state
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
              const reg = registerLspProviders(monaco, client, fullPath);
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
    // Update editor content when tab changes
    if (editorRef.current && typeof (editorRef.current as { setValue?: (v: string) => void }).setValue === "function") {
      (editorRef.current as { setValue: (v: string) => void }).setValue(tab.content);
    }

    // Cleanup LSP on unmount
    return () => {
      lspRef.current?.dispose();
      lspRef.current = null;
    };
  }, [tab.path]);

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
      onChange={(v) => onChange(v || "")}
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
