import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useDispatch, useSelector } from "react-redux";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ChatMessage, Session, sessionsApi, boardApi, poolApi, koiApi, openPath } from "../../../services/tauri";
import type { KoiTodo, KoiWithStats, PoolSession } from "../../../services/tauri/pool";
import { RootState, koiActions } from "../../../store";
import { buildInboxRows, type InboxRow, type InboxToolStep } from "../../../utils/inboxRows";
import { resolveInboxSessionLabel } from "../../../utils/inboxSessionLabel";
import { linkifyPaths, isLocalPath, uriToNativePath } from "../../../utils/linkify";
import { isInternalSession } from "../../../utils/session";
import { formatToolInput, toolIcon, toolSummary } from "../../../utils/toolDisplay";
import ConfirmDialog from "../../ConfirmDialog";
import "./PiscisInbox.css";

const INBOX_INITIAL_SIZE = 200;
const INBOX_LAZY_STEP = 50;
const INBOX_TOOL_RESULT_PREVIEW = 600;

type InboxMode = "coordination" | "koiObserver";

type PiscisInboxProps = {
  mode?: InboxMode;
  /** Active pool session — scopes coordination / observer to this project. */
  poolSessionId?: string | null;
};

function isKoiObserverSession(session: Session): boolean {
  const id = session.id ?? "";
  return id.startsWith("koi_runtime_") || id.startsWith("koi_notify_") || id.startsWith("koi_task_");
}

/**
 * Extract the koi id embedded in a koi-observer session id.
 * Session id formats produced by the backend:
 *   koi_runtime_{koi_id}_{pool_id}
 *   koi_notify_{koi_id}_{pool_id}
 *   koi_task_{koi_id}_{first8_of_todo_id}
 * Koi ids are UUIDs (contain hyphens but no underscores), so the koi id is
 * the segment between the prefix and the trailing pool/todo suffix.
 */
function extractKoiIdFromSessionId(sessionId: string): string | null {
  const prefixes = ["koi_runtime_", "koi_notify_", "koi_task_"];
  for (const prefix of prefixes) {
    if (sessionId.startsWith(prefix)) {
      const rest = sessionId.slice(prefix.length);
      // The koi id is everything up to the last underscore.
      const lastUnderscore = rest.lastIndexOf("_");
      return lastUnderscore > 0 ? rest.slice(0, lastUnderscore) : rest;
    }
  }
  return null;
}

function isCoordinationSession(session: Session): boolean {
  return isInternalSession(session) && !isKoiObserverSession(session);
}

function sessionBelongsToPool(session: Session, poolId: string, mode: InboxMode): boolean {
  const id = session.id ?? "";
  if (mode === "coordination") {
    return id === `piscis_pool_${poolId}`;
  }
  if (id.startsWith("koi_runtime_") || id.startsWith("koi_notify_")) {
    return id.endsWith(`_${poolId}`);
  }
  return false;
}

function InboxToolStepCard({
  step,
  t,
}: {
  step: InboxToolStep;
  t: (key: string, opts?: Record<string, unknown>) => string;
}) {
  const [expanded, setExpanded] = useState(false);
  const summary = toolSummary(step.name, step.input);
  const statusClass = !step.hasResult
    ? "inbox-tool--pending"
    : step.isError
      ? "inbox-tool--error"
      : "inbox-tool--ok";
  const result = step.result ?? "";
  const truncated = result.length > INBOX_TOOL_RESULT_PREVIEW;
  const [showFull, setShowFull] = useState(false);

  return (
    <div className={`inbox-tool-card ${statusClass}`}>
      <button
        type="button"
        className="inbox-tool-header"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
      >
        <span className="inbox-tool-icon">{toolIcon(step.name)}</span>
        <span className="inbox-tool-name">{step.name}</span>
        {summary ? <span className="inbox-tool-summary">{summary}</span> : null}
        <span className={`inbox-tool-status ${statusClass}`}>
          {!step.hasResult ? "…" : step.isError ? "✕" : "✓"}
        </span>
        <span className="inbox-tool-chevron">{expanded ? "▲" : "▼"}</span>
      </button>
      {expanded && (
        <div className="inbox-tool-body">
          {step.input != null && (
            <div className="inbox-tool-section">
              <span className="inbox-tool-section-label">{t("chat.toolStepInput")}</span>
              <pre className="inbox-tool-pre">{formatToolInput(step.input)}</pre>
            </div>
          )}
          <div className="inbox-tool-section">
            <span className={`inbox-tool-section-label ${step.isError ? "label-error" : ""}`}>
              {step.hasResult
                ? (step.isError ? t("chat.toolStepError") : t("chat.toolStepOutput"))
                : t("pond.inboxToolPending")}
            </span>
            <pre className={`inbox-tool-pre ${step.isError ? "pre-error" : ""}`}>
              {step.hasResult
                ? (showFull || !truncated ? result : `${result.slice(0, INBOX_TOOL_RESULT_PREVIEW)}…`)
                : t("pond.inboxToolNoResult")}
            </pre>
            {step.hasResult && truncated && (
              <button
                type="button"
                className="inbox-tool-show-more"
                onClick={(e) => {
                  e.stopPropagation();
                  setShowFull((v) => !v);
                }}
              >
                {showFull
                  ? t("chat.toolStepCollapse")
                  : t("chat.toolStepExpand", { count: result.length })}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function InboxMessageContent({ content }: { content: string }) {
  const processed = linkifyPaths(content);
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      urlTransform={(url) => url.startsWith("file://") ? url : (url.startsWith("http://") || url.startsWith("https://") || url.startsWith("mailto:") || url.startsWith("#") || url.startsWith("/") || !url.includes(":")) ? url : ""}
      components={{
        a: ({ href, children }) => {
          if (isLocalPath(href)) {
            const nativePath = uriToNativePath(href!);
            return (
              <a href="#" title={nativePath}
                onClick={(e) => {
                  e.preventDefault();
                  openPath(nativePath).catch((err) => {
                    console.error("[inbox] openPath failed:", nativePath, err);
                  });
                }}
              >
                {children}
              </a>
            );
          }
          if (!href) return <span>{children}</span>;
          return <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>;
        },
      }}
    >
      {processed}
    </ReactMarkdown>
  );
}


function formatTime(value: string): string {
  try {
    // Defensively append Z if timezone info is absent
    let dateStr = value;
    if (!/[Zz]$/.test(dateStr) && !/[+-]\d{2}:\d{2}$/.test(dateStr)) {
      dateStr = value + "Z";
    }
    return new Date(dateStr).toLocaleString();
  } catch {
    return value;
  }
}

function inboxToolsRowLabel(
  t: (key: string, opts?: Record<string, unknown>) => string,
  mode: InboxMode,
  source: "assistant" | "results",
  koiName?: string | null,
  koiIcon?: string | null,
): string {
  if (source === "results") {
    return t("pond.inboxRoleTool");
  }
  if (mode === "koiObserver") {
    if (koiName) {
      return t("pond.inboxToolsFromAgent", {
        agent: koiIcon ? `${koiIcon} ${koiName}` : koiName,
      });
    }
    return t("pond.observerRoleAssistant");
  }
  return t("pond.inboxToolsFromAgent", { agent: t("chat.piscis") });
}

function inboxMessageRoleLabel(
  t: (key: string) => string,
  mode: InboxMode,
  role: ChatMessage["role"],
  koiName?: string | null,
  koiIcon?: string | null,
): string {
  switch (role) {
    case "assistant":
      if (mode === "koiObserver") {
        if (koiName) return koiIcon ? `${koiIcon} ${koiName}` : koiName;
        return t("pond.observerRoleAssistant");
      }
      return t("chat.piscis");
    case "user":
      return mode === "koiObserver" ? t("pond.observerRoleUser") : t("pond.inboxRoleUser");
    case "system":
      return mode === "koiObserver" ? t("pond.observerRoleSystem") : t("pond.inboxRoleSystem");
    case "tool":
      return mode === "koiObserver" ? t("pond.observerRoleTool") : t("pond.inboxRoleTool");
    default:
      return role;
  }
}

function sessionKindLabel(t: (key: string) => string, mode: InboxMode, session: Session): string {
  if (mode === "koiObserver") {
    if (session.id.startsWith("koi_task_")) return t("pond.observerTask");
    if (session.id.startsWith("koi_runtime_")) return t("pond.observerRuntime");
    if (session.id.startsWith("koi_notify_")) return t("pond.observerNotify");
    return t("pond.observerInternal");
  }
  if (
    session.id === "heartbeat"
    || session.id === "piscis_inbox_global"
    || session.source === "heartbeat"
    || session.source === "piscis_inbox_global"
  ) {
    return t("pond.inboxGlobal");
  }
  return t("pond.inboxProject");
}

export default function PiscisInbox({ mode = "coordination", poolSessionId = null }: PiscisInboxProps) {
  const { t } = useTranslation();
  const dispatch = useDispatch();
  const kois = useSelector((s: RootState) => s.koi.kois) as KoiWithStats[];
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loadingSessions, setLoadingSessions] = useState(false);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [confirmTarget, setConfirmTarget] = useState<{ id: string; title: string; blocked: boolean } | null>(null);

  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const initialLoadDoneRef = useRef<string | null>(null);
  const scrollRestoreRef = useRef<number | null>(null);
  const loadingMoreRef = useRef(false);

  const [poolTodoSessionIds, setPoolTodoSessionIds] = useState<Set<string>>(new Set());
  const [poolTodos, setPoolTodos] = useState<KoiTodo[]>([]);
  const [poolSessions, setPoolSessions] = useState<PoolSession[]>([]);

  useEffect(() => {
    poolApi.listSessions().then(setPoolSessions).catch(() => setPoolSessions([]));
  }, []);

  useEffect(() => {
    boardApi
      .listTodos()
      .then((todos) => {
        if (mode === "koiObserver" && poolSessionId) {
          const scoped = todos.filter((todo) => todo.pool_session_id === poolSessionId);
          setPoolTodos(scoped);
          const ids = new Set(
            scoped.map((todo) => {
              const koiId = todo.owner_id ?? "";
              const short = todo.id.slice(0, 8);
              return `koi_task_${koiId}_${short}`;
            }),
          );
          setPoolTodoSessionIds(ids);
        } else {
          setPoolTodos(todos);
          setPoolTodoSessionIds(new Set());
        }
      })
      .catch(() => {
        setPoolTodos([]);
        setPoolTodoSessionIds(new Set());
      });
  }, [mode, poolSessionId]);

  const sessionFilter = useCallback(
    (session: Session) => {
      const kindOk = mode === "koiObserver"
        ? isKoiObserverSession(session)
        : isCoordinationSession(session);
      if (!kindOk) return false;
      if (!poolSessionId) return true;
      if (session.id?.startsWith("koi_task_")) {
        return poolTodoSessionIds.has(session.id);
      }
      return sessionBelongsToPool(session, poolSessionId, mode);
    },
    [mode, poolSessionId, poolTodoSessionIds],
  );

  const internalSessions = useMemo(
    () => sessions.filter(sessionFilter),
    [sessions, sessionFilter],
  );

  const loadSessions = useCallback(async () => {
    setLoadingSessions(true);
    try {
      const result = await sessionsApi.list(200, 0);
      const internal = result.sessions.filter(sessionFilter);
      setSessions(result.sessions);
      setActiveSessionId((prev) => {
        if (prev && internal.some((session) => session.id === prev)) return prev;
        return internal[0]?.id ?? null;
      });
    } finally {
      setLoadingSessions(false);
    }
  }, [sessionFilter]);

  const loadMessages = useCallback(async (sessionId: string) => {
    setLoadingMessages(true);
    try {
      const result = await sessionsApi.getMessages(sessionId, INBOX_INITIAL_SIZE, 0);
      setMessages(result);
      setHasMore(result.length === INBOX_INITIAL_SIZE);
      initialLoadDoneRef.current = sessionId;
    } finally {
      setLoadingMessages(false);
    }
  }, []);

  const loadOlderMessages = useCallback(async (sessionId: string, currentCount: number) => {
    if (loadingMoreRef.current) return;
    const el = messagesContainerRef.current;
    scrollRestoreRef.current = el ? el.scrollHeight : 0;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    try {
      const result = await sessionsApi.getMessages(sessionId, INBOX_LAZY_STEP, currentCount);
      if (result.length > 0) {
        setMessages((prev) => {
          const existingIds = new Set(prev.map((m) => m.id));
          const newOnes = result.filter((m) => !existingIds.has(m.id));
          return [...newOnes, ...prev];
        });
        setHasMore(result.length === INBOX_LAZY_STEP);
      } else {
        setHasMore(false);
        scrollRestoreRef.current = null;
        loadingMoreRef.current = false;
        setLoadingMore(false);
      }
    } catch {
      scrollRestoreRef.current = null;
      loadingMoreRef.current = false;
      setLoadingMore(false);
    }
  }, []);

  useEffect(() => {
    loadSessions().catch(console.error);
  }, [loadSessions]);

  // Load Koi registry for observer session labels and assistant/tool headers.
  useEffect(() => {
    if (mode !== "koiObserver") return;
    koiApi.list().then((list) => dispatch(koiActions.setKois(list))).catch(() => {});
  }, [mode, dispatch]);

  useEffect(() => {
    if (!activeSessionId) {
      setMessages([]);
      setHasMore(false);
      return;
    }
    loadMessages(activeSessionId).catch(console.error);
  }, [activeSessionId, loadMessages]);

  const inboxRows = useMemo(() => buildInboxRows(messages), [messages]);

  const sessionLabelCtx = useMemo(
    () => ({ kois, todos: poolTodos, pools: poolSessions }),
    [kois, poolTodos, poolSessions],
  );

  const sessionLabel = useCallback(
    (session: Session) => resolveInboxSessionLabel(session, sessionLabelCtx, t),
    [sessionLabelCtx, t],
  );

  // After initial load: jump to bottom once messages are in the DOM
  useLayoutEffect(() => {
    if (initialLoadDoneRef.current === activeSessionId && messagesContainerRef.current) {
      messagesContainerRef.current.scrollTop = messagesContainerRef.current.scrollHeight;
      initialLoadDoneRef.current = null;
    }
  });

  // Restore scroll position after prepending older messages
  useLayoutEffect(() => {
    if (scrollRestoreRef.current == null) return;
    const el = messagesContainerRef.current;
    if (!el) return;
    const prevScrollHeight = scrollRestoreRef.current;
    scrollRestoreRef.current = null;
    el.scrollTop = Math.max(0, el.scrollHeight - prevScrollHeight);
    loadingMoreRef.current = false;
    setLoadingMore(false);
  }, [messages.length]);

  const handleScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    if (el.scrollTop < 60 && hasMore && activeSessionId && !loadingMoreRef.current) {
      loadOlderMessages(activeSessionId, messages.length);
    }
  }, [hasMore, activeSessionId, loadOlderMessages, messages.length]);

  // Short viewport or only empty tool rows: keep loading until scrollable or exhausted
  useEffect(() => {
    if (!activeSessionId || !hasMore || loadingMoreRef.current || loadingMessages) return;
    const el = messagesContainerRef.current;
    if (!el) return;
    const scrollable = el.scrollHeight - el.clientHeight > 8;
    if (scrollable && inboxRows.length > 0) return;
    loadOlderMessages(activeSessionId, messages.length);
  }, [
    activeSessionId,
    hasMore,
    loadingMessages,
    inboxRows.length,
    messages.length,
    loadOlderMessages,
  ]);

  const requestDeleteSession = useCallback(async (e: React.MouseEvent, session: Session) => {
    e.stopPropagation();
    // Check if this inbox session is linked to an active pool
    let blocked = false;
    if (session.id.startsWith("piscis_pool_")) {
      const poolId = session.id.replace("piscis_pool_", "");
      try {
        const pools = await poolApi.listSessions();
        const pool = pools.find((p) => p.id === poolId);
        if (pool && pool.status === "active") blocked = true;
      } catch { /* ignore */ }
    }
    const label = resolveInboxSessionLabel(session, sessionLabelCtx, t);
    setConfirmTarget({ id: session.id, title: label.primary, blocked });
  }, [sessionLabelCtx, t]);

  const confirmDeleteSession = useCallback(async () => {
    if (!confirmTarget) return;
    setDeletingId(confirmTarget.id);
    try {
      await sessionsApi.delete(confirmTarget.id);
      setSessions((prev) => prev.filter((s) => s.id !== confirmTarget.id));
      if (activeSessionId === confirmTarget.id) {
        const remaining = sessions.filter((s) => s.id !== confirmTarget.id && sessionFilter(s));
        setActiveSessionId(remaining.length > 0 ? remaining[0].id : null);
        setMessages([]);
      }
      setConfirmTarget(null);
    } catch (err) {
      console.error("Failed to delete session:", err);
    } finally {
      setDeletingId(null);
    }
  }, [confirmTarget, activeSessionId, sessionFilter, sessions]);

  const copy = mode === "koiObserver"
    ? {
        title: t("pond.observerTitle"),
        subtitle: t("pond.observerDesc"),
        empty: t("pond.observerEmpty"),
        selectHint: t("pond.observerSelectHint"),
        readonly: t("pond.observerReadonly"),
        noMessages: t("pond.observerNoMessages"),
        deleteTitle: t("pond.observerDeleteTitle"),
        deleteMessage: t("pond.observerDeleteMessage", { name: confirmTarget?.title ?? "" }),
      }
    : {
        title: t("pond.inboxTitle"),
        subtitle: t("pond.inboxDesc"),
        empty: t("pond.inboxEmpty"),
        selectHint: t("pond.inboxSelectHint"),
        readonly: t("pond.inboxReadonly"),
        noMessages: t("pond.inboxNoMessages"),
        deleteTitle: t("pond.inboxDeleteTitle"),
        deleteMessage: t("pond.inboxDeleteMessage", { name: confirmTarget?.title ?? "" }),
      };

  const activeSession = internalSessions.find((session) => session.id === activeSessionId) ?? null;

  // Resolve the Koi backing the currently active observer session so we can
  // label assistant messages with the real Koi name + icon.
  const activeKoi = useMemo<KoiWithStats | null>(() => {
    if (mode !== "koiObserver" || !activeSession) return null;
    const koiId = extractKoiIdFromSessionId(activeSession.id);
    if (!koiId) return null;
    return kois.find((k) => k.id === koiId) ?? null;
  }, [mode, activeSession, kois]);

  return (
    <div className="piscis-inbox">
      <div className="piscis-inbox-sidebar">
        <div className="piscis-inbox-sidebar-header">
          <div>
            <div className="piscis-inbox-title">{copy.title}</div>
            <div className="piscis-inbox-subtitle">{copy.subtitle}</div>
          </div>
          <button className="piscis-inbox-refresh" onClick={() => loadSessions().catch(console.error)}>
            {t("pond.inboxRefresh")}
          </button>
        </div>

        <div className="piscis-inbox-session-list">
          {loadingSessions && internalSessions.length === 0 && (
            <div className="piscis-inbox-empty">{t("common.loading")}</div>
          )}
          {!loadingSessions && internalSessions.length === 0 && (
            <div className="piscis-inbox-empty">{copy.empty}</div>
          )}
          {internalSessions.map((session) => {
            const label = sessionLabel(session);
            return (
            <div
              key={session.id}
              className={`piscis-inbox-session ${session.id === activeSessionId ? "active" : ""}`}
              onClick={() => setActiveSessionId(session.id)}
              style={{ cursor: "pointer" }}
            >
              <div className="piscis-inbox-session-top">
                <span className="piscis-inbox-session-name" title={session.id}>{label.primary}</span>
                <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
                  <span className="piscis-inbox-session-kind">{sessionKindLabel(t, mode, session)}</span>
                  <button
                    title={t("common.delete")}
                    disabled={deletingId === session.id}
                    onClick={(e) => requestDeleteSession(e, session)}
                    style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-muted)", fontSize: 12, padding: "0 2px", lineHeight: 1, opacity: 0.6 }}
                    onMouseEnter={(e) => (e.currentTarget.style.opacity = "1")}
                    onMouseLeave={(e) => (e.currentTarget.style.opacity = "0.6")}
                  >✕</button>
                </span>
              </div>
              <div className="piscis-inbox-session-meta">
                <span>{formatTime(session.updated_at)}</span>
                <span>{t("pond.inboxMessageCount", { count: session.message_count })}</span>
              </div>
              {label.secondary ? (
                <div className="piscis-inbox-session-secondary">{label.secondary}</div>
              ) : null}
            </div>
            );
          })}
        </div>
      </div>

      <div className="piscis-inbox-main">
        {!activeSession && (
          <div className="piscis-inbox-main-empty">
            <div className="piscis-inbox-main-empty-icon">📬</div>
            <div>{copy.selectHint}</div>
          </div>
        )}

        {activeSession && (
          <>
            <div className="piscis-inbox-main-header">
              <div>
                <div className="piscis-inbox-main-title">{sessionLabel(activeSession).primary}</div>
                <div className="piscis-inbox-main-meta">
                  {sessionKindLabel(t, mode, activeSession)} · {copy.readonly}
                </div>
              </div>
              <button
                className="piscis-inbox-refresh"
                onClick={() => loadMessages(activeSession.id).catch(console.error)}
              >
                {t("pond.inboxRefresh")}
              </button>
            </div>

            <div
              className="piscis-inbox-messages"
              ref={messagesContainerRef}
              onScroll={handleScroll}
            >
              {loadingMessages && messages.length === 0 && (
                <div className="piscis-inbox-empty">{t("common.loading")}</div>
              )}
              {!loadingMessages && messages.length === 0 && (
                <div className="piscis-inbox-empty">{copy.noMessages}</div>
              )}
              {!loadingMessages && messages.length > 0 && inboxRows.length === 0 && !hasMore && (
                <div className="piscis-inbox-empty">{t("pond.inboxNoMessages")}</div>
              )}
              {hasMore && (
                <button
                  type="button"
                  className="piscis-inbox-load-more-btn"
                  disabled={loadingMore}
                  onClick={() => activeSessionId && loadOlderMessages(activeSessionId, messages.length)}
                >
                  {loadingMore ? t("common.loading") : t("common.loadMore")}
                </button>
              )}
              {inboxRows.map((row) => {
                if (row.kind === "text") {
                  return (
                    <div
                      key={`text-${row.message.id}`}
                      className={`piscis-inbox-message piscis-inbox-message--${row.message.role}`}
                    >
                      <div className="piscis-inbox-message-header">
                        <span className="piscis-inbox-message-role">
                          {inboxMessageRoleLabel(t, mode, row.message.role, activeKoi?.name, activeKoi?.icon)}
                        </span>
                        <span className="piscis-inbox-message-time">{formatTime(row.message.created_at)}</span>
                      </div>
                      <div className="piscis-inbox-message-content">
                        <InboxMessageContent content={row.content} />
                      </div>
                    </div>
                  );
                }
                const toolRow = row as Extract<InboxRow, { kind: "tools" }>;
                return (
                  <div
                    key={`tools-${toolRow.message.id}`}
                    className={`piscis-inbox-message piscis-inbox-message--${toolRow.message.role} piscis-inbox-message--tools`}
                  >
                    <div className="piscis-inbox-message-header">
                      <span className="piscis-inbox-message-role">
                        {inboxToolsRowLabel(t, mode, toolRow.source, activeKoi?.name, activeKoi?.icon)}
                      </span>
                      <span className="piscis-inbox-message-time">{formatTime(toolRow.message.created_at)}</span>
                    </div>
                    <div className="piscis-inbox-tools">
                      {toolRow.steps.map((step) => (
                        <InboxToolStepCard key={step.id} step={step} t={t} />
                      ))}
                    </div>
                  </div>
                );
              })}
              <div ref={messagesEndRef} />
            </div>
          </>
        )}
      </div>

      <ConfirmDialog
        open={!!confirmTarget}
        title={confirmTarget?.blocked ? t("pond.inboxDeleteActiveTitle") : copy.deleteTitle}
        message={
          confirmTarget?.blocked
            ? t("pond.inboxDeleteActiveMessage", { name: confirmTarget.title })
            : copy.deleteMessage
        }
        confirmLabel={t("common.delete")}
        variant="danger"
        loading={deletingId !== null}
        onConfirm={confirmDeleteSession}
        onCancel={() => setConfirmTarget(null)}
      />
    </div>
  );
}
