/** Pond / IDE assistant CLI sessions (`source === "cli"` or legacy title prefix). */
export function isPondCliSession(
  session: { source?: string | null; title?: string | null } | undefined | null,
): boolean {
  if (!session) return false;
  if (session.source === "cli") return true;
  const title = session.title ?? "";
  return title.startsWith("Piscis CLI") || title === "Piscis CLI";
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
