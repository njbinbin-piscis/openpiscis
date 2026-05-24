import { useRef, useEffect } from "react";
import Editor, { DiffEditor, type OnMount } from "@monaco-editor/react";
import type { OpenTab } from "./types";

interface CodeEditorProps {
  tab: OpenTab;
  theme: string;
  onChange: (value: string) => void;
}

export default function CodeEditor({ tab, theme, onChange }: CodeEditorProps) {
  const editorRef = useRef<ReturnType<OnMount> extends void ? unknown : null>(null);

  const handleMount: OnMount = (editor) => {
    editorRef.current = editor;
    // Add Ctrl+S / Cmd+S save shortcut
    editor.addCommand(
      // eslint-disable-next-line no-bitwise
      2048 | 49, // KeyMod.CtrlCmd | KeyCode.KeyS
      () => {
        // Save will be handled by parent via onChange + dirty state
      },
    );
  };

  useEffect(() => {
    // Update editor content when tab changes
    if (editorRef.current && typeof (editorRef.current as { setValue?: (v: string) => void }).setValue === "function") {
      (editorRef.current as { setValue: (v: string) => void }).setValue(tab.content);
    }
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
