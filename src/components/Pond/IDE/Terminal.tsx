import { useEffect, useRef, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import { ideApi, onTerminalOutput } from "../../../services/tauri/ide";

interface TerminalPanelProps {
  projectDir: string;
  visible: boolean;
  onClose: () => void;
  height?: number;
}

export default function TerminalPanel({
  projectDir,
  visible,
  onClose,
  height,
}: TerminalPanelProps) {
  const { t } = useTranslation();
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const termIdRef = useRef<string>("");

  const initTerminal = useCallback(async () => {
    if (!containerRef.current || termRef.current) return;

    const term = new XTerm({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: 'Consolas, "Courier New", monospace',
      fontWeight: 'normal',
      fontWeightBold: 'bold',
      lineHeight: 1.2,
      letterSpacing: 0,
      scrollback: 5000,
      theme: {
        background: "#14141c",
        foreground: "#e8e8f0",
        cursor: "#9585ff",
        cursorAccent: "#14141c",
        selectionBackground: "rgba(124, 106, 247, 0.35)",
        selectionForeground: "#ffffff",
        black: "#15151d",
        red: "#f87171",
        green: "#4ade80",
        yellow: "#fbbf24",
        blue: "#7aa2f7",
        magenta: "#bb9af7",
        cyan: "#7dcfff",
        white: "#c0c0d4",
        brightBlack: "#606078",
        brightRed: "#ff8585",
        brightGreen: "#86efac",
        brightYellow: "#fcd34d",
        brightBlue: "#93b8ff",
        brightMagenta: "#c8b1ff",
        brightCyan: "#9be4ff",
        brightWhite: "#e8e8f0",
      },
    });

    const fit = new FitAddon();
    const links = new WebLinksAddon();
    term.loadAddon(fit);
    term.loadAddon(links);
    term.open(containerRef.current);

    // Fit after the container is rendered
    requestAnimationFrame(() => {
      fit.fit();
      if (term.rows > 0 && term.cols > 0) {
        term.scrollToBottom();
      }
      // Focus so the user can start typing immediately
      term.focus();
    });

    termRef.current = term;
    fitRef.current = fit;

    // Generate id up-front so we can register the output listener BEFORE the
    // backend session is created. Otherwise the shell's initial prompt can be
    // emitted before our listener is attached and the user sees a blank cursor
    // until they press Enter.
    const id = `ide-term-${Date.now()}`;
    termIdRef.current = id;

    // Listen for output FIRST so the initial prompt is not lost.
    const unlisten = await onTerminalOutput((evt) => {
      if (evt.id === id) {
        term.write(evt.data);
      }
    });

    // Create terminal session with initial size from xterm
    await ideApi.terminalCreate(id, projectDir, term.cols, term.rows);

    // Forward keystrokes to backend
    term.onData((data) => {
      ideApi.terminalWrite(id, data).catch(() => {});
    });

    // Forward resize events to backend
    term.onResize(({ cols, rows }) => {
      ideApi.terminalResize(id, cols, rows).catch(() => {});
    });

    // Store unlisten for cleanup
    (term as unknown as { _unlisten: () => void })._unlisten = unlisten;
  }, [projectDir]);

  useEffect(() => {
    if (visible && !termRef.current) {
      initTerminal();
    }
    return () => {
      if (termRef.current) {
        const unlisten = (termRef.current as unknown as { _unlisten?: () => void })._unlisten;
        if (unlisten) unlisten();
        if (termIdRef.current) {
          ideApi.terminalDestroy(termIdRef.current).catch(() => {});
        }
        termRef.current.dispose();
        termRef.current = null;
        fitRef.current = null;
      }
    };
  }, [visible, initTerminal]);

  // Refit when visibility changes
  useEffect(() => {
    if (visible && fitRef.current && containerRef.current) {
      const timer = setTimeout(() => {
        fitRef.current?.fit();
        // Re-focus on each show so keystrokes land in the terminal without
        // an extra click.
        termRef.current?.focus();
      }, 50);
      return () => clearTimeout(timer);
    }
  }, [visible]);

  if (!visible) return null;

  return (
    <div className="ide-terminal-panel" style={height ? { height } : undefined}>
      <div className="ide-terminal-header">
        <span className="term-title">{t("ide.terminal")}</span>
        <div style={{ flex: 1 }} />
        <button onClick={onClose} title={t("ide.closeTerminal")}>✕</button>
      </div>
      <div className="ide-terminal-body" ref={containerRef} />
    </div>
  );
}
