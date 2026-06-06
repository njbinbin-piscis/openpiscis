/** Pond / IDE assistant CLI sessions (`source === "cli"` or legacy title prefix). */
export function isPondCliSession(
  session: { source?: string | null; title?: string | null } | undefined | null,
): boolean {
  if (!session) return false;
  if (session.source === "cli") return true;
  const title = session.title ?? "";
  return title.startsWith("Piscis CLI") || title === "Piscis CLI";
}

export type MainChatSessionKind = "chat" | "im" | "cli";

/** Classify a session for the main Chat sidebar tabs (mirrors Chat/index.tsx). */
export function classifyMainChatSession(
  session: { source?: string | null; id?: string | null; title?: string | null } | undefined | null,
): MainChatSessionKind {
  if (isInternalSession(session)) return "chat";
  if (isPondCliSession(session)) return "cli";
  if (!session?.source || session.source === "chat") return "chat";
  return "im";
}

/** User-visible in the main Chat sidebar for the given filter tab. */
export function isMainChatVisibleSession(
  session: { source?: string | null; id?: string | null; title?: string | null } | undefined | null,
  filter: MainChatSessionKind = "chat",
): boolean {
  if (!session || isInternalSession(session)) return false;
  return classifyMainChatSession(session) === filter;
}

/** First non-internal session suitable as the main Chat active session. */
export function pickMainChatActiveSession(
  sessions: Array<{ source?: string | null; id?: string | null; title?: string | null }>,
  filter: MainChatSessionKind = "chat",
): string | null {
  return sessions.find((s) => isMainChatVisibleSession(s, filter))?.id ?? null;
}

/** Returns true for sessions that are internal/system and should not appear in the
 *  user-facing session list (heartbeat, piscis_inbox, pool coordinators, etc.). */
export function isInternalSession(session: { source?: string | null; id?: string | null } | undefined | null): boolean {
  if (!session) return false;
  const id = session.id ?? "";
  return session.source === "heartbeat"
    || session.source === "heartbeat_pool"
    || session.source === "piscis_inbox_global"
    || session.source === "piscis_inbox_pool"
    || session.source === "piscis_internal"
    || session.source === "piscis_pool"
    || session.source === "piscis_heartbeat_global"
    || session.source === "piscis_heartbeat_pool"
    || session.id === "heartbeat"
    || session.id === "piscis_inbox_global"
    || id.startsWith("piscis_pool_")
    || id.startsWith("koi_runtime_")
    || id.startsWith("koi_notify_")
    || id.startsWith("koi_");
}
