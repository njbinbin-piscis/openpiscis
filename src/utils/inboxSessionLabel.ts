import type { Session } from "../services/tauri";
import type { KoiTodo, KoiWithStats, PoolSession } from "../services/tauri/pool";

export type InboxSessionLabel = {
  primary: string;
  secondary?: string;
};

function extractKoiIdFromSessionId(sessionId: string): string | null {
  const prefixes = ["koi_runtime_", "koi_notify_", "koi_task_"];
  for (const prefix of prefixes) {
    if (sessionId.startsWith(prefix)) {
      const rest = sessionId.slice(prefix.length);
      const lastUnderscore = rest.lastIndexOf("_");
      return lastUnderscore > 0 ? rest.slice(0, lastUnderscore) : rest;
    }
  }
  return null;
}

function extractTodoShortFromSessionId(sessionId: string): string | null {
  if (!sessionId.startsWith("koi_task_")) return null;
  const rest = sessionId.slice("koi_task_".length);
  const lastUnderscore = rest.lastIndexOf("_");
  return lastUnderscore >= 0 ? rest.slice(lastUnderscore + 1) : null;
}

function findTodoForSession(sessionId: string, todos: KoiTodo[]): KoiTodo | undefined {
  const short = extractTodoShortFromSessionId(sessionId);
  if (!short) return undefined;
  const koiId = extractKoiIdFromSessionId(sessionId);
  return todos.find(
    (todo) =>
      todo.id.slice(0, 8) === short &&
      (!koiId || todo.owner_id === koiId),
  );
}

function findKoi(koiId: string | null, kois: KoiWithStats[]): KoiWithStats | undefined {
  if (!koiId) return undefined;
  return kois.find((k) => k.id === koiId);
}

function findPool(poolId: string, pools: PoolSession[]): PoolSession | undefined {
  return pools.find((p) => p.id === poolId);
}

function koiDisplayName(koi: KoiWithStats | undefined, fallbackId: string | null): string {
  if (koi?.name) return koi.icon ? `${koi.icon} ${koi.name}` : koi.name;
  if (fallbackId) return fallbackId.slice(0, 8);
  return "Koi";
}

/**
 * Human-readable session title for PiscisInbox sidebars (replaces raw session id / hash).
 */
type LabelT = (key: string, opts?: Record<string, unknown>) => string;

export function resolveInboxSessionLabel(
  session: Session,
  ctx: {
    kois: KoiWithStats[];
    todos: KoiTodo[];
    pools: PoolSession[];
  },
  t?: LabelT,
): InboxSessionLabel {
  const id = session.id ?? "";
  const stored = session.title?.trim();
  const looksLikeRawId =
    !stored ||
    stored === id ||
    stored.startsWith("koi_task_") ||
    stored.startsWith("koi_runtime_") ||
    stored.startsWith("koi_notify_") ||
    stored.startsWith("piscis_pool_");

  if (stored && !looksLikeRawId) {
    return { primary: stored };
  }

  if (id.startsWith("koi_task_")) {
    const todo = findTodoForSession(id, ctx.todos);
    const koi = findKoi(extractKoiIdFromSessionId(id), ctx.kois);
    const koiName = koiDisplayName(koi, extractKoiIdFromSessionId(id));
    if (todo) {
      return {
        primary: `${koiName} · ${todo.title}`,
        secondary: todo.status,
      };
    }
    const short = extractTodoShortFromSessionId(id);
    return {
      primary: t
        ? t("pond.inboxSessionUnknownTask", { koi: koiName, id: short ?? "?" })
        : `${koiName} · ${short ?? "task"}`,
    };
  }

  if (id.startsWith("koi_runtime_")) {
    const koiId = extractKoiIdFromSessionId(id);
    const poolId = id.slice("koi_runtime_".length + (koiId?.length ?? 0) + 1);
    const koi = findKoi(koiId, ctx.kois);
    const pool = findPool(poolId, ctx.pools);
    const koiName = koiDisplayName(koi, koiId);
    return {
      primary: t ? t("pond.inboxSessionRuntime", { koi: koiName }) : `${koiName} · Runtime`,
      secondary: pool?.name,
    };
  }

  if (id.startsWith("koi_notify_")) {
    const koiId = extractKoiIdFromSessionId(id);
    const koi = findKoi(koiId, ctx.kois);
    const koiName = koiDisplayName(koi, koiId);
    return {
      primary: t ? t("pond.inboxSessionNotify", { koi: koiName }) : `${koiName} · Notify`,
    };
  }

  if (id.startsWith("piscis_pool_")) {
    const poolId = id.replace("piscis_pool_", "");
    const pool = findPool(poolId, ctx.pools);
    return {
      primary: pool
        ? (t ? t("pond.inboxSessionPool", { pool: pool.name }) : `Piscis · ${pool.name}`)
        : `Piscis · ${poolId.slice(0, 8)}`,
    };
  }

  if (id === "heartbeat" || session.source === "heartbeat") {
    return { primary: t?.("pond.inboxHeartbeat") ?? "Piscis Heartbeat" };
  }

  if (id === "piscis_inbox_global" || session.source === "piscis_inbox_global") {
    return { primary: t?.("pond.inboxGlobalInbox") ?? "Piscis Global Inbox" };
  }

  return { primary: stored || id };
}
