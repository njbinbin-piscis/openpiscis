import type { ChatMessage } from "../services/tauri";
import { parsePersistedBlocks } from "./toolDisplay";

export type InboxToolStep = {
  id: string;
  name: string;
  input: unknown;
  result?: string;
  isError?: boolean;
  hasResult: boolean;
};

export type InboxRow =
  | { kind: "text"; message: ChatMessage; content: string }
  | {
      kind: "tools";
      message: ChatMessage;
      steps: InboxToolStep[];
      /** assistant = tool_calls on agent turn; results = orphan tool_results row */
      source: "assistant" | "results";
    };

function collectToolResults(messages: ChatMessage[]): Map<string, { content: string; isError: boolean }> {
  const map = new Map<string, { content: string; isError: boolean }>();
  for (const msg of messages) {
    for (const block of parsePersistedBlocks(msg.tool_results_json)) {
      const toolUseId = typeof block.tool_use_id === "string" ? block.tool_use_id : "";
      if (!toolUseId) continue;
      const content =
        typeof block.content === "string"
          ? block.content
          : JSON.stringify(block.content ?? "");
      map.set(toolUseId, {
        content,
        isError: Boolean(block.is_error),
      });
    }
  }
  return map;
}

/** Legacy inbox rows stored placeholder text instead of leaving content empty. */
function isInboxToolPlaceholder(text: string): boolean {
  const t = text.trim();
  return t === "🔧 tool result" || t === "🔧 tool" || /^🔧 [^\s]+$/.test(t);
}

function parseLegacyPlaceholderToolName(text: string): string | null {
  const m = text.trim().match(/^🔧 ([^\s]+)$/);
  if (!m) return null;
  const name = m[1];
  if (name === "tool" || name === "result") return null;
  return name;
}

function effectiveMessageText(msg: ChatMessage): string {
  const trimmed = msg.content.trim();
  if (!trimmed) return "";
  if (
    isInboxToolPlaceholder(trimmed) &&
    (msg.tool_calls_json?.trim() || msg.tool_results_json?.trim())
  ) {
    return "";
  }
  return trimmed;
}

function isToolResultCarrier(msg: ChatMessage): boolean {
  if (!msg.tool_results_json?.trim()) return false;
  const text = msg.content.trim();
  return !text || isInboxToolPlaceholder(text);
}

/**
 * Turn persisted chat rows into inbox rows with full tool-call / tool-result detail.
 */
export function buildInboxRows(messages: ChatMessage[]): InboxRow[] {
  const resultsById = collectToolResults(messages);
  const consumedResultIds = new Set<string>();
  const rows: InboxRow[] = [];

  for (const msg of messages) {
    const text = effectiveMessageText(msg);
    const calls = parsePersistedBlocks(msg.tool_calls_json).filter(
      (call) => typeof call.name === "string" && String(call.name).length > 0,
    );

    if (calls.length > 0) {
      const steps: InboxToolStep[] = calls.map((call, index) => {
        const name = String(call.name);
        const id =
          typeof call.id === "string" && call.id.trim()
            ? call.id
            : `${msg.id}_${index}`;
        const matched = resultsById.get(id);
        if (matched) consumedResultIds.add(id);
        return {
          id,
          name,
          input: call.input ?? null,
          result: matched?.content,
          isError: matched?.isError,
          hasResult: matched != null,
        };
      });
      if (text) {
        rows.push({ kind: "text", message: msg, content: text });
      }
      rows.push({ kind: "tools", message: msg, steps, source: "assistant" });
      continue;
    }

    const legacyToolName =
      msg.role === "assistant" ? parseLegacyPlaceholderToolName(msg.content) : null;
    if (legacyToolName) {
      rows.push({
        kind: "tools",
        message: msg,
        steps: [
          {
            id: msg.id,
            name: legacyToolName,
            input: null,
            hasResult: false,
          },
        ],
        source: "assistant",
      });
      continue;
    }

    if (isToolResultCarrier(msg)) {
      const steps: InboxToolStep[] = parsePersistedBlocks(msg.tool_results_json)
        .map((block, index) => {
          const toolUseId =
            typeof block.tool_use_id === "string" ? block.tool_use_id : `${msg.id}_${index}`;
          const content =
            typeof block.content === "string"
              ? block.content
              : JSON.stringify(block.content ?? "");
          return {
            id: toolUseId,
            name: typeof block.tool_name === "string" ? block.tool_name : "tool",
            input: null,
            result: content,
            isError: Boolean(block.is_error),
            hasResult: true,
          };
        })
        .filter((step) => !consumedResultIds.has(step.id));
      if (steps.length > 0) {
        rows.push({ kind: "tools", message: msg, steps, source: "results" });
      }
      continue;
    }

    if (text) {
      rows.push({ kind: "text", message: msg, content: text });
    }
  }

  return rows;
}
