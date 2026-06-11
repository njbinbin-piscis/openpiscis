/** Shared tool-call presentation helpers (Chat, PiscisInbox, …). */

export const TOOL_ICONS: Record<string, string> = {
  shell: "💻",
  powershell: "💻",
  file_read: "📄",
  file_write: "✏️",
  file_edit: "✏️",
  browser: "🌐",
  web_search: "🔍",
  web_fetch: "📰",
  screen_capture: "📸",
  ssh: "🔐",
  im_send_message: "💬",
  pool_org: "🐟",
  call_koi: "🐠",
  office: "📊",
  plan_todo: "🗂️",
};

export function parsePersistedBlocks(raw?: string | null): Array<Record<string, unknown>> {
  if (!raw?.trim()) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as Array<Record<string, unknown>>) : [];
  } catch {
    return [];
  }
}

export function toolIcon(name: string): string {
  return TOOL_ICONS[name] ?? "⚙️";
}

/** One-line summary of tool input for list headers. */
export function toolSummary(name: string, input: unknown): string {
  const i = input as Record<string, unknown> | null | undefined;
  if (!i || typeof i !== "object") return "";
  if (name === "browser") {
    const parts = [i.action];
    if (i.url) parts.push(String(i.url).slice(0, 60));
    else if (i.selector) parts.push(String(i.selector).slice(0, 40));
    return parts.filter(Boolean).join(" → ");
  }
  if (name === "shell" || name === "powershell") return String(i.command ?? "").slice(0, 120);
  if (name === "file_read" || name === "file_write" || name === "file_edit") {
    return String(i.path ?? "").slice(0, 120);
  }
  if (name === "web_search") return String(i.query ?? "").slice(0, 120);
  if (name === "web_fetch") return String(i.url ?? "").slice(0, 120);
  if (name === "screen_capture") return String(i.mode ?? "fullscreen");
  if (name === "pool_org" && i.action) return String(i.action);
  return Object.entries(i)
    .slice(0, 2)
    .map(([k, v]) => `${k}=${String(v).slice(0, 40)}`)
    .join(" ");
}

export function formatToolInput(input: unknown): string {
  if (typeof input === "string") return input;
  if (input == null) return "";
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return String(input);
  }
}
