import { useEffect, useState, useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import {
  activityApi,
  auditApi,
  AuditEntry,
  PlanSnapshot,
  SessionActivityBundle,
  SessionArtifact,
} from "../../services/tauri";
import { PlanTodoItem } from "../../store";
import ConfirmDialog from "../ConfirmDialog";
import AppDropdown, { type AppMenuItem } from "../ui/AppDropdown";

const TOOL_COLORS: Record<string, string> = {
  shell: "#e67e22",
  file_write: "#e74c3c",
  file_read: "#3498db",
  web_search: "#9b59b6",
  browser: "#1abc9c",
  uia: "#f39c12",
  screen_capture: "#2ecc71",
  powershell_query: "#e67e22",
  wmi: "#95a5a6",
  com: "#34495e",
  office: "#27ae60",
  plan_todo: "#8e44ad",
};

const PLAN_SNAPSHOT_STRIPES = [
  "rgba(142, 68, 173, 0.06)",
  "rgba(52, 152, 219, 0.06)",
];

function toolColor(name: string) {
  return TOOL_COLORS[name] ?? "#7f8c8d";
}

function parsePlanItems(itemsJson: string): PlanTodoItem[] {
  try {
    const parsed = JSON.parse(itemsJson);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item) => item && typeof item.id === "string" && typeof item.content === "string",
    );
  } catch {
    return [];
  }
}

function planStatusLabel(
  t: ReturnType<typeof useTranslation>["t"],
  status: PlanTodoItem["status"],
): string {
  switch (status) {
    case "pending":
      return t("chat.planPending");
    case "in_progress":
      return t("chat.planInProgress");
    case "completed":
      return t("chat.planCompleted");
    case "cancelled":
      return t("chat.planCancelled");
    default:
      return status;
  }
}

function AuditRow({
  entry,
  expanded,
  onToggle,
  sessionTitle,
}: {
  entry: AuditEntry;
  expanded: boolean;
  onToggle: () => void;
  sessionTitle: string;
}) {
  const { t } = useTranslation();
  const ts = new Date(entry.timestamp).toLocaleString();

  return (
    <div
      style={{
        borderBottom: "1px solid var(--border)",
        padding: "10px 14px",
        background: entry.is_error ? "rgba(220,53,69,0.04)" : "transparent",
        cursor: "pointer",
      }}
      onClick={onToggle}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span
          style={{
            fontSize: 11,
            fontWeight: 600,
            padding: "2px 7px",
            borderRadius: 4,
            background: `${toolColor(entry.tool_name)}22`,
            color: toolColor(entry.tool_name),
            border: `1px solid ${toolColor(entry.tool_name)}44`,
            minWidth: 80,
            textAlign: "center",
          }}
        >
          {entry.tool_name}
        </span>
        <span style={{ fontSize: 13, color: "var(--text-primary)", fontWeight: 500, flex: 1 }}>
          {entry.action}
        </span>
        {entry.is_error ? (
          <span style={{ fontSize: 11, color: "#ff6b6b", fontWeight: 600 }}>
            {t("audit.statusError")}
          </span>
        ) : (
          <span style={{ fontSize: 11, color: "#28a745" }}>{t("audit.statusSuccess")}</span>
        )}
        <span style={{ fontSize: 11, color: "var(--text-muted)", whiteSpace: "nowrap" }}>{ts}</span>
        <span style={{ color: "var(--text-muted)", fontSize: 12 }}>{expanded ? "▲" : "▼"}</span>
      </div>

      {expanded && (
        <div style={{ marginTop: 10, fontSize: 12, display: "flex", flexDirection: "column", gap: 6 }}>
          {entry.input_summary && (
            <div>
              <span style={{ color: "var(--text-muted)", fontWeight: 600 }}>{t("audit.inputLabel")}</span>
              <code
                style={{
                  color: "var(--text-secondary)",
                  background: "var(--bg-secondary)",
                  padding: "2px 6px",
                  borderRadius: 3,
                  wordBreak: "break-all",
                }}
              >
                {entry.input_summary}
              </code>
            </div>
          )}
          {entry.result_summary && (
            <div>
              <span style={{ color: "var(--text-muted)", fontWeight: 600 }}>{t("audit.resultLabel")}</span>
              <code
                style={{
                  color: entry.is_error ? "#ff6b6b" : "var(--text-secondary)",
                  background: "var(--bg-secondary)",
                  padding: "2px 6px",
                  borderRadius: 3,
                  wordBreak: "break-all",
                }}
              >
                {entry.result_summary}
              </code>
            </div>
          )}
          <div style={{ color: "var(--text-muted)", fontSize: 11 }}>
            {t("audit.sessionLabel")}{sessionTitle}
          </div>
        </div>
      )}
    </div>
  );
}

function PlanSnapshotBlock({
  snapshot,
  stripeIndex,
}: {
  snapshot: PlanSnapshot;
  stripeIndex: number;
}) {
  const { t } = useTranslation();
  const items = parsePlanItems(snapshot.items_json);
  const bg = PLAN_SNAPSHOT_STRIPES[stripeIndex % PLAN_SNAPSHOT_STRIPES.length];
  const ts = new Date(snapshot.created_at).toLocaleString();

  return (
    <div
      style={{
        margin: "8px 0",
        padding: "10px 12px",
        borderRadius: 8,
        border: "1px solid var(--border)",
        background: bg,
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, marginBottom: 8 }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)" }}>
          🗂️ {snapshot.label || t("audit.planRound", { index: stripeIndex + 1 })}
        </span>
        <span style={{ fontSize: 11, color: "var(--text-muted)", whiteSpace: "nowrap" }}>{ts}</span>
      </div>
      {items.length === 0 ? (
        <div style={{ fontSize: 12, color: "var(--text-muted)" }}>{t("audit.planEmpty")}</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {items.map((item, idx) => (
            <div
              key={item.id}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                fontSize: 12,
                padding: "4px 6px",
                borderRadius: 4,
                background: idx % 2 === 0 ? "rgba(0,0,0,0.03)" : "transparent",
              }}
            >
              <span style={{ color: "var(--text-muted)", minWidth: 18 }}>{idx + 1}.</span>
              <span style={{ flex: 1, color: "var(--text-primary)" }}>{item.content}</span>
              <span
                style={{
                  fontSize: 10,
                  padding: "1px 6px",
                  borderRadius: 3,
                  background: "var(--bg-secondary)",
                  color: "var(--text-muted)",
                }}
              >
                {planStatusLabel(t, item.status)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ArtifactRow({ artifact }: { artifact: SessionArtifact }) {
  const ts = new Date(artifact.created_at).toLocaleString();
  return (
    <div
      style={{
        padding: "8px 12px",
        borderBottom: "1px solid var(--border)",
        fontSize: 12,
      }}
    >
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <span style={{ fontWeight: 600, color: "var(--text-primary)" }}>{artifact.name}</span>
        <span
          style={{
            fontSize: 10,
            padding: "1px 6px",
            borderRadius: 3,
            background: "var(--bg-secondary)",
            color: "var(--text-muted)",
          }}
        >
          {artifact.artifact_type}
        </span>
        {artifact.source_tool && (
          <span style={{ fontSize: 10, color: toolColor(artifact.source_tool) }}>
            {artifact.source_tool}
          </span>
        )}
        <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--text-muted)" }}>{ts}</span>
      </div>
      {artifact.content_summary && (
        <div style={{ marginTop: 4, color: "var(--text-secondary)", wordBreak: "break-all" }}>
          {artifact.content_summary}
        </div>
      )}
    </div>
  );
}

function SessionBundleCard({
  bundle,
  expanded,
  sessionExpanded,
  onToggleSession,
  onToggleAudit,
  filterTool,
  showErrors,
}: {
  bundle: SessionActivityBundle;
  expanded: Set<string>;
  sessionExpanded: boolean;
  onToggleSession: () => void;
  onToggleAudit: (id: string) => void;
  filterTool: string;
  showErrors: boolean;
}) {
  const { t } = useTranslation();
  const audits = bundle.audits.filter((e) => {
    if (filterTool && e.tool_name !== filterTool) return false;
    if (showErrors && !e.is_error) return false;
    return true;
  });
  const updated = bundle.session_updated_at
    ? new Date(bundle.session_updated_at).toLocaleString()
    : "";

  if (
    audits.length === 0 &&
    bundle.plan_snapshots.length === 0 &&
    bundle.artifacts.length === 0 &&
    (bundle.skill_revisions?.length ?? 0) === 0
  ) {
    return null;
  }

  return (
    <div
      style={{
        marginBottom: 12,
        border: "1px solid var(--border)",
        borderRadius: 10,
        overflow: "hidden",
        background: "var(--bg-primary)",
      }}
    >
      <div
        onClick={onToggleSession}
        style={{
          padding: "12px 16px",
          cursor: "pointer",
          background: "var(--bg-secondary)",
          display: "flex",
          alignItems: "center",
          gap: 10,
        }}
      >
        <span style={{ fontSize: 14, fontWeight: 700, color: "var(--text-primary)", flex: 1 }}>
          💬 {bundle.session_title}
        </span>
        <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
          {t("audit.bundleMeta", {
            tools: audits.length,
            plans: bundle.plan_snapshots.length,
            artifacts: bundle.artifacts.length,
            skills: bundle.skill_revisions?.length ?? 0,
          })}
        </span>
        {updated && (
          <span style={{ fontSize: 11, color: "var(--text-muted)", whiteSpace: "nowrap" }}>
            {updated}
          </span>
        )}
        <span style={{ color: "var(--text-muted)" }}>{sessionExpanded ? "▲" : "▼"}</span>
      </div>

      {sessionExpanded && (
        <div style={{ padding: "8px 12px 12px" }}>
          {bundle.plan_snapshots.length > 0 && (
            <div style={{ marginBottom: 12 }}>
              <div
                style={{
                  fontSize: 12,
                  fontWeight: 700,
                  color: "var(--text-muted)",
                  marginBottom: 6,
                  textTransform: "uppercase",
                  letterSpacing: 0.5,
                }}
              >
                {t("audit.sectionTodos")}
              </div>
              {[...bundle.plan_snapshots].reverse().map((snap, idx) => (
                <PlanSnapshotBlock key={snap.id} snapshot={snap} stripeIndex={idx} />
              ))}
            </div>
          )}

          {bundle.artifacts.length > 0 && (
            <div style={{ marginBottom: 12 }}>
              <div
                style={{
                  fontSize: 12,
                  fontWeight: 700,
                  color: "var(--text-muted)",
                  marginBottom: 6,
                  textTransform: "uppercase",
                  letterSpacing: 0.5,
                }}
              >
                {t("audit.sectionArtifacts")}
              </div>
              <div style={{ border: "1px solid var(--border)", borderRadius: 8, overflow: "hidden" }}>
                {bundle.artifacts.map((a) => (
                  <ArtifactRow key={a.id} artifact={a} />
                ))}
              </div>
            </div>
          )}

          {(bundle.skill_revisions?.length ?? 0) > 0 && (
            <div style={{ marginBottom: 12 }}>
              <div
                style={{
                  fontSize: 12,
                  fontWeight: 700,
                  color: "var(--text-muted)",
                  marginBottom: 6,
                  textTransform: "uppercase",
                  letterSpacing: 0.5,
                }}
              >
                {t("audit.sectionSkillRevisions")}
              </div>
              <div style={{ border: "1px solid var(--border)", borderRadius: 8, overflow: "hidden" }}>
                {bundle.skill_revisions.map((rev) => (
                  <div
                    key={rev.id}
                    style={{
                      padding: "8px 12px",
                      borderBottom: "1px solid var(--border)",
                      fontSize: 12,
                    }}
                  >
                    <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                      <span style={{ fontWeight: 600 }}>{rev.skill_id}</span>
                      {rev.origin && (
                        <span style={{ fontSize: 10, color: "var(--text-muted)" }}>{rev.origin}</span>
                      )}
                      <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--text-muted)" }}>
                        {new Date(rev.created_at).toLocaleString()}
                      </span>
                    </div>
                    {rev.diff_summary && (
                      <div style={{ marginTop: 4, color: "var(--text-secondary)" }}>{rev.diff_summary}</div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {audits.length > 0 && (
            <div>
              <div
                style={{
                  fontSize: 12,
                  fontWeight: 700,
                  color: "var(--text-muted)",
                  marginBottom: 6,
                  textTransform: "uppercase",
                  letterSpacing: 0.5,
                }}
              >
                {t("audit.sectionTools")}
              </div>
              <div style={{ border: "1px solid var(--border)", borderRadius: 8, overflow: "hidden" }}>
                {audits.map((entry) => (
                  <AuditRow
                    key={entry.id}
                    entry={entry}
                    expanded={expanded.has(entry.id)}
                    onToggle={() => onToggleAudit(entry.id)}
                    sessionTitle={bundle.session_title}
                  />
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function AuditLog() {
  const { t } = useTranslation();
  const [bundles, setBundles] = useState<SessionActivityBundle[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filterTool, setFilterTool] = useState("");
  const [showErrors, setShowErrors] = useState(false);
  const [expandedAudits, setExpandedAudits] = useState<Set<string>>(new Set());
  const [expandedSessions, setExpandedSessions] = useState<Set<string>>(new Set());
  const [clearing, setClearing] = useState(false);
  const [confirmClearOpen, setConfirmClearOpen] = useState(false);
  const [toolFilterOpen, setToolFilterOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await activityApi.list(40);
      setBundles(data);
      setExpandedSessions((prev) => {
        if (prev.size > 0) return prev;
        const next = new Set<string>();
        if (data[0]) next.add(data[0].session_id);
        return next;
      });
    } catch (e) {
      setError(t("audit.failedLoad", { error: String(e) }));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    load();
  }, [load]);

  const handleClearConfirmed = async () => {
    setClearing(true);
    try {
      await auditApi.clear();
      setBundles([]);
      setExpandedAudits(new Set());
      setExpandedSessions(new Set());
    } catch (e) {
      setError(t("audit.failedClear", { error: String(e) }));
    } finally {
      setClearing(false);
      setConfirmClearOpen(false);
    }
  };

  const toggleAudit = (id: string) => {
    setExpandedAudits((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleSession = (sessionId: string) => {
    setExpandedSessions((prev) => {
      const next = new Set(prev);
      if (next.has(sessionId)) next.delete(sessionId);
      else next.add(sessionId);
      return next;
    });
  };

  const allTools = useMemo(() => {
    const names = new Set<string>();
    for (const b of bundles) {
      for (const a of b.audits) names.add(a.tool_name);
    }
    return Array.from(names).sort();
  }, [bundles]);

  const toolFilterItems = useMemo((): AppMenuItem[] => {
    const rows: AppMenuItem[] = [
      { id: "", label: t("audit.allTools"), selected: !filterTool },
    ];
    for (const tool of allTools) {
      rows.push({ id: tool, label: tool, selected: filterTool === tool });
    }
    return rows;
  }, [allTools, filterTool, t]);

  const toolFilterLabel = filterTool || t("audit.allTools");

  const totalAudits = bundles.reduce((n, b) => n + b.audits.length, 0);
  const displayedAudits = bundles.reduce((n, b) => {
    return (
      n +
      b.audits.filter((e) => {
        if (filterTool && e.tool_name !== filterTool) return false;
        if (showErrors && !e.is_error) return false;
        return true;
      }).length
    );
  }, 0);

  return (
    <div className="page">
      <div className="page-header">
        <h1 className="page-title">🔍 {t("audit.title")}</h1>
        <div className="page-header-actions">
          <button type="button" className="btn-header" onClick={load} disabled={loading}>
            ↻ {loading ? t("common.loading") : t("common.refresh")}
          </button>
          <button
            type="button"
            className="btn-header btn-header-danger"
            onClick={() => setConfirmClearOpen(true)}
            disabled={clearing}
          >
            {clearing ? t("audit.clearing") : t("audit.clearLog")}
          </button>
        </div>
      </div>

      {error && (
        <div className="page-banner page-banner--error">
          <span>{error}</span>
          <button type="button" className="page-banner-dismiss" onClick={() => setError(null)}>
            ✕
          </button>
        </div>
      )}

      <div className="page-toolbar">
        <AppDropdown
          menuId="audit-tool-filter"
          triggerLabel={toolFilterLabel}
          items={toolFilterItems}
          open={toolFilterOpen}
          onOpenChange={setToolFilterOpen}
          onSelect={setFilterTool}
          variant="toolbar"
          searchPlaceholder={t("common.search")}
          emptyLabel={t("ide.noResults")}
        />
        <label
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            fontSize: 13,
            color: "var(--text-secondary)",
            cursor: "pointer",
          }}
        >
          <input
            type="checkbox"
            checked={showErrors}
            onChange={(e) => setShowErrors(e.target.checked)}
          />
          {t("audit.errorsOnly")}
        </label>
        <span className="page-toolbar-meta">
          {t("audit.sessionCount", { sessions: bundles.length, tools: displayedAudits, total: totalAudits })}
        </span>
      </div>

      <div className="page-body" style={{ padding: "16px 24px 24px" }}>
        {bundles.length === 0 && !loading && (
          <div style={{ textAlign: "center", padding: "60px 0", color: "var(--text-muted)" }}>
            <div style={{ fontSize: 32, marginBottom: 8 }}>📋</div>
            <div>{t("audit.noRecords")}</div>
            <div style={{ fontSize: 12, marginTop: 4 }}>{t("audit.noRecordsDesc")}</div>
          </div>
        )}

        {bundles.map((bundle) => (
          <SessionBundleCard
            key={bundle.session_id}
            bundle={bundle}
            expanded={expandedAudits}
            sessionExpanded={expandedSessions.has(bundle.session_id)}
            onToggleSession={() => toggleSession(bundle.session_id)}
            onToggleAudit={toggleAudit}
            filterTool={filterTool}
            showErrors={showErrors}
          />
        ))}
      </div>

      <ConfirmDialog
        open={confirmClearOpen}
        title={t("audit.clearLog")}
        message={t("audit.confirmClear")}
        confirmLabel={t("audit.clearLog")}
        cancelLabel={t("common.cancel")}
        loading={clearing}
        onConfirm={handleClearConfirmed}
        onCancel={() => !clearing && setConfirmClearOpen(false)}
      />
    </div>
  );
}
