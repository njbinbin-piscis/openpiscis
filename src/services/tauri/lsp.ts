// LSP (Language Server Protocol) client for the IDE.
// Connects to the Rust backend's WebSocket bridge and wires
// Monaco Editor providers for diagnostics, hover, completions,
// go-to-definition, and find-references.

import { invoke } from "@tauri-apps/api/core";
import type * as Monaco from "monaco-editor";

// ─── Tauri command wrappers ──────────────────────────────────────────────

export interface LspLanguageInfo {
  language_id: string;
  name: string;
  extensions: string[];
  server_command: string;
  available: boolean;
}

export const lspApi = {
  /** List all supported LSP languages with availability status. */
  listLanguages: () =>
    invoke<LspLanguageInfo[]>("ide_lsp_list_languages"),

  /** Start an LSP server; returns the WebSocket port. */
  start: (projectDir: string, language: string) =>
    invoke<number>("ide_lsp_start", { projectDir, language }),

  /** Stop an LSP session for a given project+language. */
  stop: (projectDir: string, language: string) =>
    invoke<void>("ide_lsp_stop", { projectDir, language }),
};

// ─── File extension → LSP language mapping ─────────────────────────────

const EXT_TO_LSP_LANG: Record<string, string> = {
  ".rs": "rust",
  ".ts": "typescript",
  ".tsx": "typescript",
  ".js": "typescript",
  ".jsx": "typescript",
  ".mjs": "typescript",
  ".cjs": "typescript",
  ".py": "python",
  ".pyi": "python",
  ".c": "cpp",
  ".h": "cpp",
  ".cpp": "cpp",
  ".cc": "cpp",
  ".cxx": "cpp",
  ".hpp": "cpp",
  ".hxx": "cpp",
};

/** Detect LSP language from a file path. */
export function languageForFile(filePath: string): string | null {
  const lower = filePath.toLowerCase();
  for (const [ext, lang] of Object.entries(EXT_TO_LSP_LANG)) {
    if (lower.endsWith(ext)) return lang;
  }
  return null;
}

// ─── LSP JSON-RPC types ──────────────────────────────────────────────────

interface LspPosition {
  line: number;
  character: number;
}

interface LspRange {
  start: LspPosition;
  end: LspPosition;
}

interface LspLocation {
  uri: string;
  range: LspRange;
}

interface LspDiagnostic {
  range: LspRange;
  severity?: number; // 1=Error, 2=Warning, 3=Info, 4=Hint
  message: string;
  source?: string;
  code?: string | number;
}

// ─── LspClient ───────────────────────────────────────────────────────────

type ResponseHandler = (result: unknown) => void;

/**
 * Manages a single WebSocket connection to one LSP bridge.
 * Handles JSON-RPC framing (Content-Length headers) and request/response
 * correlation via numeric request IDs.
 */
export class LspClient {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<number, ResponseHandler>();
  private url: string;
  private diagnostics: LspDiagnostic[] = [];
  private onDiagnosticsChange?: (diags: LspDiagnostic[]) => void;
  private connectPromise: Promise<void> | null = null;

  constructor(port: number) {
    this.url = `ws://127.0.0.1:${port}`;
  }

  /** Connect to the bridge and perform the LSP handshake. */
  async connect(
    projectDir: string,
    language: string,
    filePath: string,
    fileContent: string,
  ): Promise<void> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return;
    if (this.connectPromise) return this.connectPromise;

    this.connectPromise = new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(this.url);
      this.ws = ws;

      ws.onopen = async () => {
        try {
          // 1) Send initialize request
          const initReq = this.frame({
            jsonrpc: "2.0",
            id: this.nextId++,
            method: "initialize",
            params: {
              processId: null,
              rootUri: `file://${projectDir}`,
              capabilities: {
                textDocument: {
                  hover: { contentFormat: ["markdown", "plaintext"] },
                  completion: { completionItem: { snippetSupport: true } },
                  definition: { linkSupport: true },
                  references: {},
                  rename: { prepareSupport: true },
                  publishDiagnostics: { relatedInformation: true },
                },
              },
              workspaceFolders: [
                { uri: `file://${projectDir}`, name: "project" },
              ],
            },
          });
          ws.send(initReq);

          // Wait for init response (the bridge sends a canned one)
          const initResp = await this.waitForResponse();
          if (!initResp) {
            reject(new Error("LSP init: no response"));
            return;
          }

          // 2) Send initialized notification
          ws.send(
            this.frame({
              jsonrpc: "2.0",
              method: "initialized",
              params: {},
            }),
          );

          // 3) Send textDocument/didOpen
          const lspLang = languageToLspId(language);
          ws.send(
            this.frame({
              jsonrpc: "2.0",
              method: "textDocument/didOpen",
              params: {
                textDocument: {
                  uri: `file://${filePath}`,
                  languageId: lspLang,
                  version: 1,
                  text: fileContent,
                },
              },
            }),
          );

          console.log(`[LSP] Connected to ${this.url} for ${language}`);
          resolve();
        } catch (err) {
          reject(err);
        }
      };

      ws.onmessage = (evt) => {
        this.handleMessage(evt.data as string);
      };

      ws.onerror = (err) => {
        console.error("[LSP] WebSocket error:", err);
        reject(new Error("WebSocket connection failed"));
      };

      ws.onclose = () => {
        console.log("[LSP] WebSocket closed");
        this.ws = null;
      };
    });

    return this.connectPromise;
  }

  /** Send a textDocument/didChange notification when content changes. */
  sendDidChange(filePath: string, content: string) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(
      this.frame({
        jsonrpc: "2.0",
        method: "textDocument/didChange",
        params: {
          textDocument: {
            uri: `file://${filePath}`,
            version: Date.now(),
          },
          contentChanges: [{ text: content }],
        },
      }),
    );
  }

  /** Request diagnostics for a file. */
  async requestDiagnostics(filePath: string): Promise<LspDiagnostic[]> {
    // Some LSP servers don't support textDocument/diagnostic,
    // but they push diagnostics via publishDiagnostics after didOpen/didChange.
    // We collect those passively and return what we have.
    // Also try the pull-model if supported.
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      const id = this.nextId++;
      const promise = new Promise<LspDiagnostic[]>((resolve) => {
        const handler = (result: unknown) => {
          const r = result as { items?: LspDiagnostic[] };
          resolve(r?.items ?? []);
        };
        this.pending.set(id, handler as ResponseHandler);
        // Timeout after 3s
        setTimeout(() => {
          if (this.pending.has(id)) {
            this.pending.delete(id);
            resolve(this.diagnostics);
          }
        }, 3000);
      });

      this.ws.send(
        this.frame({
          jsonrpc: "2.0",
          id,
          method: "textDocument/diagnostic",
          params: {
            textDocument: { uri: `file://${filePath}` },
          },
        }),
      );

      return promise;
    }
    return this.diagnostics;
  }

  /** Request hover info at a position. */
  async requestHover(
    filePath: string,
    line: number,
    character: number,
  ): Promise<string | null> {
    return this.sendRequest("textDocument/hover", {
      textDocument: { uri: `file://${filePath}` },
      position: { line, character },
    }).then((result) => {
      const r = result as { contents?: unknown } | undefined;
      if (!r?.contents) return null;
      const c = r.contents as
        | string
        | { value: string }
        | { kind: string; value: string };
      if (typeof c === "string") return c;
      if ("value" in c && typeof c.value === "string") return c.value;
      return JSON.stringify(c);
    });
  }

  /** Request completion items at a position. */
  async requestCompletions(
    filePath: string,
    line: number,
    character: number,
  ): Promise<Monaco.languages.CompletionItem[] | null> {
    return this.sendRequest("textDocument/completion", {
      textDocument: { uri: `file://${filePath}` },
      position: { line, character },
      context: { triggerKind: 1 },
    }).then((result) => {
      const r = result as
        | { items?: LspCompletionItem[] }
        | LspCompletionItem[]
        | undefined;
      if (!r) return null;
      const items = Array.isArray(r) ? r : r.items ?? [];
      return items.map(toMonacoCompletionItem);
    });
  }

  /** Request go-to-definition at a position. */
  async requestDefinition(
    filePath: string,
    line: number,
    character: number,
  ): Promise<Monaco.languages.Location[] | null> {
    return this.sendRequest("textDocument/definition", {
      textDocument: { uri: `file://${filePath}` },
      position: { line, character },
    }).then((result) => {
      const locations: LspLocation[] = Array.isArray(result)
        ? (result as LspLocation[])
        : result
          ? [result as LspLocation]
          : [];
      return locations.map(toMonacoLocation);
    });
  }

  /** Request find-references at a position. */
  async requestReferences(
    filePath: string,
    line: number,
    character: number,
  ): Promise<Monaco.languages.Location[] | null> {
    return this.sendRequest("textDocument/references", {
      textDocument: { uri: `file://${filePath}` },
      position: { line, character },
      context: { includeDeclaration: true },
    }).then((result) => {
      const locations = result as LspLocation[] | undefined;
      if (!locations?.length) return null;
      return locations.map(toMonacoLocation);
    });
  }

  /** Register a callback for diagnostics changes. */
  setDiagnosticsCallback(cb: (diags: LspDiagnostic[]) => void) {
    this.onDiagnosticsChange = cb;
  }

  /** Disconnect and clean up. */
  disconnect() {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.pending.clear();
    this.connectPromise = null;
  }

  // ─── Private helpers ──────────────────────────────────────────────────

  private frame(msg: unknown): string {
    const body = JSON.stringify(msg);
    return `Content-Length: ${body.length}\r\n\r\n${body}`;
  }

  private async sendRequest(
    method: string,
    params: unknown,
  ): Promise<unknown> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return null;

    const id = this.nextId++;
    return new Promise((resolve) => {
      const handler = (result: unknown) => resolve(result);
      this.pending.set(id, handler);
      // Timeout after 5s
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          resolve(null);
        }
      }, 5000);

      this.ws!.send(
        this.frame({
          jsonrpc: "2.0",
          id,
          method,
          params,
        }),
      );
    });
  }

  /** Wait for the next JSON-RPC response message. */
  private waitForResponse(): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("Timeout waiting for LSP response"));
      }, 10000);

      const origHandler = this.ws!.onmessage;
      this.ws!.onmessage = (evt) => {
        const body = this.parseBody(evt.data as string);
        if (!body) return;
        try {
          const msg = JSON.parse(body);
          if (msg.id !== undefined && msg.result !== undefined) {
            clearTimeout(timeout);
            this.ws!.onmessage = origHandler;
            resolve(msg.result);
          } else if (msg.id !== undefined && msg.error) {
            clearTimeout(timeout);
            this.ws!.onmessage = origHandler;
            reject(new Error(msg.error.message ?? "LSP error"));
          }
        } catch {
          // ignore parse errors for non-JSON frames
        }
      };
    });
  }

  /** Parse a Content-Length framed message body. */
  private parseBody(data: string): string | null {
    const idx = data.indexOf("\r\n\r\n");
    if (idx === -1) return data; // no framing
    return data.slice(idx + 4);
  }

  /** Handle incoming WebSocket messages. */
  private handleMessage(data: string) {
    const body = this.parseBody(data);
    if (!body) return;
    try {
      const msg = JSON.parse(body);

      // Handle responses to our requests
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const handler = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        if (msg.error) {
          console.warn(`[LSP] Error for id ${msg.id}:`, msg.error);
        }
        handler(msg.result ?? null);
        return;
      }

      // Handle pushed diagnostics
      if (msg.method === "textDocument/publishDiagnostics") {
        const params = msg.params as {
          uri: string;
          diagnostics: LspDiagnostic[];
        };
        if (params?.diagnostics) {
          this.diagnostics = params.diagnostics;
          this.onDiagnosticsChange?.(params.diagnostics);
        }
      }
    } catch {
      // ignore
    }
  }
}

// ─── LSP ↔ Monaco type converters ────────────────────────────────────────

interface LspCompletionItem {
  label: string;
  kind?: number;
  detail?: string;
  documentation?: string | { value: string };
  insertText?: string;
  insertTextFormat?: number; // 2 = snippet
  sortText?: string;
  filterText?: string;
  textEdit?: { range: LspRange; newText: string };
  additionalTextEdits?: { range: LspRange; newText: string }[];
}

function toMonacoCompletionItem(
  item: LspCompletionItem,
): Monaco.languages.CompletionItem {
  let docString: string | undefined;
  if (typeof item.documentation === "object" && item.documentation && "value" in item.documentation) {
    docString = (item.documentation as { value: string }).value;
  } else {
    docString = item.documentation as string | undefined;
  }

  const result: Monaco.languages.CompletionItem = {
    label: item.label,
    kind: lspKindToMonaco(item.kind ?? 1),
    detail: item.detail,
    documentation: docString,
    insertText: item.insertText ?? item.label,
    insertTextRules:
      item.insertTextFormat === 2
        ? 4 /* InsertAsSnippet */
        : undefined,
    sortText: item.sortText,
    filterText: item.filterText,
    range: item.textEdit?.range
      ? {
          startLineNumber: item.textEdit.range.start.line + 1,
          startColumn: item.textEdit.range.start.character + 1,
          endLineNumber: item.textEdit.range.end.line + 1,
          endColumn: item.textEdit.range.end.character + 1,
        }
      : { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 },
  };

  return result;
}

function toMonacoLocation(loc: LspLocation): Monaco.languages.Location {
  const path = loc.uri.replace(/^file:\/\//, "");
  return {
    uri: monacoUri(path),
    range: {
      startLineNumber: loc.range.start.line + 1,
      startColumn: loc.range.start.character + 1,
      endLineNumber: loc.range.end.line + 1,
      endColumn: loc.range.end.character + 1,
    },
  };
}

/** Create a Monaco Uri from a filesystem path. */
function monacoUri(path: string): Monaco.Uri {
  // We need to import Monaco dynamically for Uri, but since
  // this is in a service layer, we use the path directly.
  // The conversion is handled in the provider functions
  // which have access to the monaco namespace.
  return { path, scheme: "file" } as unknown as Monaco.Uri;
}

function lspKindToMonaco(kind: number): Monaco.languages.CompletionItemKind {
  // LSP CompletionItemKind → Monaco CompletionItemKind
  const map: Record<number, number> = {
    1: 0, // Text
    2: 1, // Method
    3: 2, // Function
    4: 3, // Constructor
    5: 4, // Field
    6: 5, // Variable
    7: 6, // Class
    8: 7, // Interface
    9: 8, // Module
    10: 9, // Property
    11: 10, // Unit
    12: 11, // Value
    13: 12, // Enum
    14: 13, // Keyword
    15: 14, // Snippet
    16: 15, // Color
    17: 16, // File
    18: 17, // Reference
    19: 18, // Folder
    20: 19, // EnumMember
    21: 20, // Constant
    22: 21, // Struct
    23: 22, // Event
    24: 23, // Operator
    25: 24, // TypeParameter
  };
  return map[kind] ?? 0;
}

/** Map our language IDs to LSP language IDs. */
function languageToLspId(lang: string): string {
  return lang;
}

// ─── Monaco provider registration helpers ─────────────────────────────────

/**
 * Register LSP-powered providers on a Monaco languages namespace
 * and editor model. Returns a cleanup function.
 */
export interface LspProvidersRegistration {
  dispose: () => void;
  client: LspClient;
}

export function registerLspProviders(
  monaco: typeof Monaco,
  client: LspClient,
  filePath: string,
): LspProvidersRegistration {
  const disposables: Monaco.IDisposable[] = [];
  const modelUri = monaco.Uri.parse(`file://${filePath}`);

  // ── Diagnostics via markers ──────────────────────────────────────────
  client.setDiagnosticsCallback((diags) => {
    const markers: Monaco.editor.IMarkerData[] = diags.map((d) => ({
      severity: d.severity === 1
        ? monaco.MarkerSeverity.Error
        : d.severity === 2
          ? monaco.MarkerSeverity.Warning
          : d.severity === 4
            ? monaco.MarkerSeverity.Hint
            : monaco.MarkerSeverity.Info,
      message: d.message,
      source: d.source,
      code: typeof d.code === "string" ? d.code : String(d.code ?? ""),
      startLineNumber: d.range.start.line + 1,
      startColumn: d.range.start.character + 1,
      endLineNumber: d.range.end.line + 1,
      endColumn: d.range.end.character + 1,
    }));
    monaco.editor.setModelMarkers(
      monaco.editor.getModel(modelUri) ?? monaco.editor.getModels()[0],
      "lsp",
      markers,
    );
  });

  // ── Hover provider ───────────────────────────────────────────────────
  const hoverDisposable = monaco.languages.registerHoverProvider("*", {
    provideHover: async (_model, position) => {
      const result = await client.requestHover(
        filePath,
        position.lineNumber - 1,
        position.column - 1,
      );
      if (!result) return null;
      return {
        contents: [{ value: result }],
        range: {
          startLineNumber: position.lineNumber,
          startColumn: position.column,
          endLineNumber: position.lineNumber,
          endColumn: position.column,
        },
      };
    },
  });
  disposables.push(hoverDisposable);

  // ── Completion provider ──────────────────────────────────────────────
  const completionDisposable = monaco.languages.registerCompletionItemProvider(
    "*",
    {
      provideCompletionItems: async (_model, position) => {
        const items = await client.requestCompletions(
          filePath,
          position.lineNumber - 1,
          position.column - 1,
        );
        if (!items?.length) return null;
        return { suggestions: items };
      },
      triggerCharacters: [".", ":", '"', "'", "/", "@", "#"],
    },
  );
  disposables.push(completionDisposable);

  // ── Definition provider ──────────────────────────────────────────────
  const defDisposable = monaco.languages.registerDefinitionProvider("*", {
    provideDefinition: async (_model, position) => {
      return await client.requestDefinition(
        filePath,
        position.lineNumber - 1,
        position.column - 1,
      );
    },
  });
  disposables.push(defDisposable);

  // ── Reference provider ───────────────────────────────────────────────
  const refDisposable = monaco.languages.registerReferenceProvider("*", {
    provideReferences: async (_model, position) => {
      return await client.requestReferences(
        filePath,
        position.lineNumber - 1,
        position.column - 1,
      );
    },
  });
  disposables.push(refDisposable);

  return {
    dispose: () => {
      disposables.forEach((d) => d.dispose());
      client.disconnect();
    },
    client,
  };
}
