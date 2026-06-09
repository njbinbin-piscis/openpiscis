import { useEffect, useState, useCallback } from "react";
import { useDispatch, useSelector } from "react-redux";
import { useTranslation } from "react-i18next";
import { RootState, memoryActions } from "../../store";
import { memoryApi, schedulerApi, ScheduledTask } from "../../services/tauri";
import ConfirmDialog from "../ConfirmDialog";

const MEMORY_CONSOLIDATION_NAME = "Memory Consolidation";

const KIND_LABELS: Record<string, string> = {
  fact: "memory.kindFact",
  decision: "memory.kindDecision",
  preference: "memory.kindPreference",
  error_learned: "memory.kindErrorLearned",
  open_item: "memory.kindOpenItem",
};

function formatTs(iso?: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString();
}

export default function Memory() {
  const { t } = useTranslation();
  const dispatch = useDispatch();
  const { memories } = useSelector((s: RootState) => s.memory);
  const [newContent, setNewContent] = useState("");
  const [newCategory, setNewCategory] = useState("general");
  const [adding, setAdding] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmClearOpen, setConfirmClearOpen] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [dreamTask, setDreamTask] = useState<ScheduledTask | null>(null);
  const [consolidating, setConsolidating] = useState(false);
  const [dreamMsg, setDreamMsg] = useState<string | null>(null);

  const loadDreamStatus = useCallback(async () => {
    try {
      const { tasks } = await schedulerApi.list();
      const found =
        tasks.find((task) => task.name === MEMORY_CONSOLIDATION_NAME) ?? null;
      setDreamTask(found);
    } catch {
      setDreamTask(null);
    }
  }, []);

  useEffect(() => {
    memoryApi
      .list()
      .then(({ memories: list }) => {
        dispatch(memoryActions.setMemories(list));
      })
      .catch((e) => setError(t("memory.failedLoad", { error: String(e) })));
    loadDreamStatus();
  }, [dispatch, t, loadDreamStatus]);

  const handleAdd = async () => {
    if (!newContent.trim()) return;
    setAdding(true);
    setError(null);
    try {
      const memory = await memoryApi.add(newContent.trim(), newCategory);
      dispatch(memoryActions.addMemory(memory));
      setNewContent("");
      setShowAdd(false);
    } catch (e) {
      setError(t("memory.failedAdd", { error: String(e) }));
    } finally {
      setAdding(false);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await memoryApi.delete(id);
      dispatch(memoryActions.removeMemory(id));
    } catch (e) {
      setError(t("memory.failedDelete", { error: String(e) }));
    }
  };

  const handleClearConfirmed = async () => {
    setClearing(true);
    try {
      await memoryApi.clear();
      dispatch(memoryActions.setMemories([]));
    } catch (e) {
      setError(t("memory.failedClear", { error: String(e) }));
    } finally {
      setClearing(false);
      setConfirmClearOpen(false);
    }
  };

  const handleRunDream = async () => {
    setConsolidating(true);
    setDreamMsg(null);
    setError(null);
    try {
      await memoryApi.runConsolidationNow();
      setDreamMsg(t("memory.dreamStarted"));
      await loadDreamStatus();
    } catch (e) {
      setError(t("memory.dreamFailed", { error: String(e) }));
    } finally {
      setConsolidating(false);
    }
  };

  return (
    <div className="page">
      <div className="page-header">
        <h1 className="page-title">💡 {t("memory.title")}</h1>
        <div className="page-header-actions">
          {memories.length > 0 && (
            <button
              type="button"
              className="btn-header btn-header-danger"
              onClick={() => setConfirmClearOpen(true)}
            >
              {t("memory.clearAll")}
            </button>
          )}
          <button
            type="button"
            className="btn-header btn-header-primary"
            onClick={() => setShowAdd(!showAdd)}
          >
            + {t("memory.addMemory")}
          </button>
        </div>
      </div>

      <div className="page-body">
        <div
          className="card"
          style={{
            marginBottom: 20,
            borderLeft: "3px solid #9b59b6",
            background: "rgba(155, 89, 182, 0.06)",
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start" }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 6 }}>
                🌙 {t("memory.dreamTitle")}
              </div>
              <p style={{ fontSize: 13, color: "var(--text-secondary)", margin: 0, lineHeight: 1.5 }}>
                {t("memory.dreamDesc")}
              </p>
              <div style={{ marginTop: 10, fontSize: 12, color: "var(--text-muted)", display: "flex", flexWrap: "wrap", gap: 12 }}>
                <span>
                  {t("memory.dreamSchedule")}: {dreamTask?.cron_expression ?? "0 4 * * *"}
                </span>
                <span>
                  {t("memory.dreamLastRun")}: {formatTs(dreamTask?.last_run_at)}
                </span>
                <span>
                  {t("memory.dreamRunCount")}: {dreamTask?.run_count ?? 0}
                </span>
                {dreamTask?.last_run_status && (
                  <span>
                    {t("memory.dreamLastStatus")}: {dreamTask.last_run_status}
                  </span>
                )}
              </div>
              {dreamMsg && (
                <div style={{ marginTop: 8, fontSize: 12, color: "#28a745" }}>{dreamMsg}</div>
              )}
            </div>
            <button
              type="button"
              className="btn-header btn-header-primary"
              onClick={handleRunDream}
              disabled={consolidating}
            >
              {consolidating ? t("memory.dreamRunning") : t("memory.dreamRunNow")}
            </button>
          </div>
        </div>

        {error && (
          <div
            style={{
              padding: "8px 14px",
              background: "rgba(220,53,69,0.15)",
              borderLeft: "3px solid #dc3545",
              color: "#ff6b6b",
              fontSize: "0.85rem",
              marginBottom: 12,
              display: "flex",
              justifyContent: "space-between",
            }}
          >
            <span>{error}</span>
            <button
              onClick={() => setError(null)}
              style={{ background: "none", border: "none", color: "#ff6b6b", cursor: "pointer" }}
            >
              ✕
            </button>
          </div>
        )}
        {showAdd && (
          <div className="card" style={{ marginBottom: 20 }}>
            <div className="form-group">
              <label className="label">{t("memory.content")}</label>
              <textarea
                className="input"
                value={newContent}
                onChange={(e) => setNewContent(e.target.value)}
                placeholder={t("memory.contentPlaceholder")}
                rows={3}
              />
            </div>
            <div className="form-group">
              <label className="label">{t("memory.category")}</label>
              <input
                className="input"
                value={newCategory}
                onChange={(e) => setNewCategory(e.target.value)}
                placeholder={t("memory.categoryPlaceholder")}
              />
            </div>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button className="btn btn-secondary" onClick={() => setShowAdd(false)}>
                {t("common.cancel")}
              </button>
              <button className="btn btn-primary" onClick={handleAdd} disabled={adding}>
                {adding ? t("common.saving") : t("common.save")}
              </button>
            </div>
          </div>
        )}

        {memories.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state-icon">💡</div>
            <div className="empty-state-title">{t("memory.noMemories")}</div>
            <div className="empty-state-desc">{t("memory.noMemoriesDesc")}</div>
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {memories.map((m) => {
              const kindKey = KIND_LABELS[m.kind ?? "fact"] ?? "memory.kindFact";
              return (
                <div key={m.id} className="card memory-item">
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "flex-start",
                      gap: 12,
                    }}
                  >
                    <div style={{ flex: 1 }}>
                      <p style={{ color: "var(--text-primary)", marginBottom: 8 }}>{m.content}</p>
                      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                        <span className="badge badge-info">{m.category}</span>
                        <span className="badge" style={{ background: "rgba(155,89,182,0.15)", color: "#9b59b6" }}>
                          {t(kindKey)}
                        </span>
                        <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
                          {t("memory.confidence", { value: Math.round(m.confidence * 100) })}
                        </span>
                        <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
                          {t("memory.updated")}: {new Date(m.updated_at).toLocaleDateString()}
                        </span>
                        {m.last_seen_at && (
                          <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
                            {t("memory.lastSeen")}: {formatTs(m.last_seen_at)}
                          </span>
                        )}
                        {(m.source_session_id || m.evidence_session_id) && (
                          <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
                            {t("memory.sourceSession")}:{" "}
                            {(m.evidence_session_id ?? m.source_session_id ?? "").slice(0, 8)}…
                          </span>
                        )}
                      </div>
                    </div>
                    <button
                      type="button"
                      className="btn-header btn-header-danger"
                      onClick={() => handleDelete(m.id)}
                    >
                      {t("common.delete")}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <ConfirmDialog
        open={confirmClearOpen}
        title={t("memory.clearAll")}
        message={t("memory.confirmClear")}
        confirmLabel={t("memory.clearAll")}
        cancelLabel={t("common.cancel")}
        loading={clearing}
        onConfirm={handleClearConfirmed}
        onCancel={() => !clearing && setConfirmClearOpen(false)}
      />
    </div>
  );
}
