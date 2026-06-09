import { useEffect, useState, useCallback } from "react";
import { useDispatch, useSelector } from "react-redux";
import { useTranslation } from "react-i18next";
import { RootState, skillsActions } from "../../store";
import {
  skillsApi,
  clawHubApi,
  claudePluginsApi,
  skillEvolutionApi,
  parseSkillConfig,
  SkillCatalogItem,
  ClawHubSkill,
  ClaudePluginListItem,
  ClaudePluginDetail,
  SkillCompatibilityCheck,
  CuratorStatus,
  SkillRevision,
} from "../../services/tauri";
import ConfirmDialog from "../ConfirmDialog";
import type { SyncSkillsResult } from "../../services/tauri";

const SOURCE_BADGE: Record<string, { label: string; color: string }> = {
  builtin:   { label: "builtin",   color: "var(--text-muted)" },
  installed: { label: "installed", color: "#28a745" },
  workspace: { label: "workspace", color: "#ffc107" },
  registry:  { label: "registry",  color: "var(--accent)" },
};

export default function Skills() {
  const { t } = useTranslation();
  const dispatch = useDispatch();
  const { skills } = useSelector((s: RootState) => s.skills);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  // Installation state
  const [installUrl, setInstallUrl] = useState("");
  const [installing, setInstalling] = useState(false);
  const [compatCheck, setCompatCheck] = useState<SkillCompatibilityCheck | null>(null);
  const [compatChecking, setCompatChecking] = useState(false);

  // Catalog (detailed skill info from file system)
  const [catalog, setCatalog] = useState<SkillCatalogItem[]>([]);

  // Uninstall confirmation dialog
  const [uninstallTarget, setUninstallTarget] = useState<string | null>(null);
  const [uninstalling, setUninstalling] = useState(false);

  // Sync from disk
  const [syncing, setSyncing] = useState(false);

  // ClawHub marketplace
  const [hubTab, setHubTab] = useState<"local" | "evolution" | "hub" | "official">("local");
  const [hubQuery, setHubQuery] = useState("");
  const [hubResults, setHubResults] = useState<ClawHubSkill[]>([]);
  const [hubSearching, setHubSearching] = useState(false);
  const [hubError, setHubError] = useState<string | null>(null);
  const [hubInstalling, setHubInstalling] = useState<string | null>(null);

  // Anthropic official plugins
  const [officialQuery, setOfficialQuery] = useState("");
  const [officialPlugins, setOfficialPlugins] = useState<ClaudePluginListItem[]>([]);
  const [officialSearching, setOfficialSearching] = useState(false);
  const [officialError, setOfficialError] = useState<string | null>(null);
  const [officialDetail, setOfficialDetail] = useState<ClaudePluginDetail | null>(null);
  const [officialDetailLoading, setOfficialDetailLoading] = useState(false);
  const [officialInstalling, setOfficialInstalling] = useState<string | null>(null);

  // Skill evolution
  const [curatorStatus, setCuratorStatus] = useState<CuratorStatus | null>(null);
  const [curatorRunning, setCuratorRunning] = useState(false);
  const [revisions, setRevisions] = useState<SkillRevision[]>([]);
  const [evolutionBusy, setEvolutionBusy] = useState<string | null>(null);

  const loadSkills = useCallback(() => {
    skillsApi.list().then(({ skills }) => {
      dispatch(skillsActions.setSkills(skills));
    }).catch((e) => setError(t("skills.failedLoad", { error: String(e) })));

    skillsApi.catalog().then(setCatalog).catch(() => {});
  }, [dispatch, t]);

  const loadEvolution = useCallback(() => {
    skillEvolutionApi.curatorStatus().then(setCuratorStatus).catch(() => {});
    skillEvolutionApi.listRevisions({ limit: 20 }).then((r) => setRevisions(r.revisions)).catch(() => {});
  }, []);

  useEffect(() => {
    loadSkills();
    loadEvolution();
  }, [loadSkills, loadEvolution]);

  const handleSyncFromDisk = useCallback(async () => {
    setSyncing(true);
    setError(null);
    setSuccessMsg(null);
    try {
      const result: SyncSkillsResult = await skillsApi.syncFromDisk();
      if (result.synced > 0) {
        setSuccessMsg(t("skills.syncSuccess", { synced: result.synced, already: result.already_registered }));
      } else {
        setSuccessMsg(t("skills.syncNone"));
      }
      if (result.errors.length > 0) {
        setError(result.errors.join("; "));
      }
      loadSkills();
    } catch (e) {
      setError(t("skills.syncFailed", { error: String(e) }));
    } finally {
      setSyncing(false);
    }
  }, [t, loadSkills]);

  const handleToggle = async (id: string, enabled: boolean) => {
    try {
      await skillsApi.toggle(id, enabled);
      dispatch(skillsActions.toggleSkill({ id, enabled }));
    } catch (e) {
      setError(t("skills.failedToggle", { error: String(e) }));
    }
  };

  const handleCheckCompat = useCallback(async (src: string) => {
    if (!src.trim()) { setCompatCheck(null); return; }
    setCompatChecking(true);
    setCompatCheck(null);
    try {
      const result = await skillsApi.checkCompat(src.trim());
      setCompatCheck(result);
    } catch {
      setCompatCheck(null);
    } finally {
      setCompatChecking(false);
    }
  }, []);

  const handleInstall = async () => {
    const src = installUrl.trim();
    if (!src) return;
    setInstalling(true);
    setError(null);
    setSuccessMsg(null);
    try {
      const skill = await skillsApi.install(src);
      setSuccessMsg(t("skills.installSuccess", { name: skill.name }));
      setInstallUrl("");
      setCompatCheck(null);
      loadSkills();
    } catch (e) {
      setError(t("skills.installFailed", { error: String(e) }));
    } finally {
      setInstalling(false);
    }
  };

  const handleUninstall = (skillName: string) => {
    setUninstallTarget(skillName);
  };

  const doUninstall = async () => {
    if (!uninstallTarget) return;
    const skillName = uninstallTarget;
    setUninstalling(true);
    setError(null);
    try {
      await skillsApi.uninstall(skillName);
      setSuccessMsg(t("skills.uninstallSuccess", { name: skillName }));
      loadSkills();
    } catch (e) {
      setError(t("skills.uninstallFailed", { error: String(e) }));
    } finally {
      setUninstalling(false);
      setUninstallTarget(null);
    }
  };

  const handleHubSearch = useCallback(async () => {
    const q = hubQuery.trim();
    setHubSearching(true);
    setHubError(null);
    try {
      const result = await clawHubApi.search(q, 20);
      if (result.items.length === 0) {
        setHubError(t("skills.hubNoResults"));
        setHubResults([]);
        return;
      }
      // Show results immediately, then enrich with compat info in background
      setHubResults(result.items);

      // Fire-and-forget: pre-check compatibility for each skill that has a skill_url
      result.items.forEach(async (skill, idx) => {
        if (!skill.skill_url) return;
        try {
          const compat = await skillsApi.checkCompat(skill.skill_url);
          setHubResults((prev) => {
            const next = [...prev];
            if (next[idx]?.slug === skill.slug) {
              next[idx] = {
                ...next[idx],
                platform: compat.issues.some((i) => i.includes("平台")) ? ["linux/macos"] : next[idx].platform,
                compatible: compat.compatible,
                compat_issues: compat.issues,
              };
            }
            return next;
          });
        } catch {
          // compat check failed silently — don't block the UI
        }
      });
    } catch (e) {
      setHubError(t("skills.hubSearchFailed", { error: String(e) }));
    } finally {
      setHubSearching(false);
    }
  }, [hubQuery, t]);

  const handleOfficialSearch = useCallback(async () => {
    setOfficialSearching(true);
    setOfficialError(null);
    setOfficialDetail(null);
    try {
      const result = await claudePluginsApi.list(officialQuery.trim(), 50);
      setOfficialPlugins(result.items);
      if (result.items.length === 0) {
        setOfficialError(t("skills.officialNoResults"));
      }
    } catch (e) {
      setOfficialError(t("skills.officialSearchFailed", { error: String(e) }));
    } finally {
      setOfficialSearching(false);
    }
  }, [officialQuery, t]);

  useEffect(() => {
    if (hubTab === "official" && officialPlugins.length === 0 && !officialSearching) {
      handleOfficialSearch();
    }
  }, [hubTab, officialPlugins.length, officialSearching, handleOfficialSearch]);

  const handleOfficialSelect = async (plugin: ClaudePluginListItem) => {
    setOfficialDetailLoading(true);
    setOfficialError(null);
    try {
      const detail = await claudePluginsApi.detail(plugin.id);
      setOfficialDetail(detail);
    } catch (e) {
      setOfficialError(t("skills.officialDetailFailed", { error: String(e) }));
    } finally {
      setOfficialDetailLoading(false);
    }
  };

  const handleOfficialInstall = async (pluginId: string, skillDirs?: string[]) => {
    setOfficialInstalling(pluginId);
    setError(null);
    setSuccessMsg(null);
    try {
      const result = await claudePluginsApi.install(pluginId, skillDirs);
      const names = result.installed.map((s) => s.name).join(", ");
      if (names) {
        setSuccessMsg(t("skills.officialInstallSuccess", { names, count: result.installed.length }));
      }
      if (result.errors.length > 0) {
        setError(t("skills.officialInstallPartial", { errors: result.errors.join("; ") }));
      }
      loadSkills();
      if (officialDetail?.plugin.id === pluginId) {
        await handleOfficialSelect(officialDetail.plugin);
      }
    } catch (e) {
      setError(t("skills.installFailed", { error: String(e) }));
    } finally {
      setOfficialInstalling(null);
    }
  };

  const handleHubInstall = async (skill: ClawHubSkill) => {
    // Block install if we already know it's incompatible
    if (skill.compatible === false) {
      setError(t("skills.installFailed", { error: skill.compat_issues.join("; ") }));
      return;
    }
    setHubInstalling(skill.slug);
    setError(null);
    setSuccessMsg(null);
    try {
      const version = skill.version?.trim();
      const installed = await clawHubApi.install(
        skill.slug,
        version && version !== "latest" ? version : undefined,
      );
      setSuccessMsg(t("skills.installSuccess", { name: installed.name }));
      loadSkills();
    } catch (e) {
      setError(t("skills.installFailed", { error: String(e) }));
    } finally {
      setHubInstalling(null);
    }
  };

  const catalogByName = Object.fromEntries(catalog.map((c) => [c.name.toLowerCase(), c]));
  const visibleSkills = skills.filter((skill) => {
    const meta = parseSkillConfig(skill.config);
    if (meta.lifecycle === "builtin") return false;
    const source = catalogByName[skill.name.toLowerCase()]?.source ?? meta.lifecycle ?? "builtin";
    return source !== "builtin";
  });

  const installedSkills = visibleSkills.filter((s) => {
    const m = parseSkillConfig(s.config);
    return !m.lifecycle || m.lifecycle === "installed";
  });
  const draftSkills = visibleSkills.filter((s) => parseSkillConfig(s.config).lifecycle === "draft");
  const learnedSkills = visibleSkills.filter((s) => parseSkillConfig(s.config).lifecycle === "learned");

  const handlePromote = async (skillId: string, name: string) => {
    setEvolutionBusy(skillId);
    try {
      await skillEvolutionApi.promote(skillId);
      setSuccessMsg(t("skills.promoteSuccess", { name }));
      loadSkills();
      loadEvolution();
    } catch (e) {
      setError(t("skills.evolutionFailed", { error: String(e) }));
    } finally {
      setEvolutionBusy(null);
    }
  };

  const handleDiscard = async (skillId: string, name: string) => {
    setEvolutionBusy(skillId);
    try {
      await skillEvolutionApi.discard(skillId);
      setSuccessMsg(t("skills.discardSuccess", { name }));
      loadSkills();
      loadEvolution();
    } catch (e) {
      setError(t("skills.evolutionFailed", { error: String(e) }));
    } finally {
      setEvolutionBusy(null);
    }
  };

  const handleLockToggle = async (skillId: string, locked: boolean) => {
    setEvolutionBusy(skillId);
    try {
      if (locked) await skillEvolutionApi.unlock(skillId);
      else await skillEvolutionApi.lock(skillId);
      loadSkills();
    } catch (e) {
      setError(t("skills.evolutionFailed", { error: String(e) }));
    } finally {
      setEvolutionBusy(null);
    }
  };

  const handlePinToggle = async (skillId: string, pinned: boolean) => {
    setEvolutionBusy(skillId);
    try {
      if (pinned) await skillEvolutionApi.unpin(skillId);
      else await skillEvolutionApi.pin(skillId);
      loadSkills();
    } catch (e) {
      setError(t("skills.evolutionFailed", { error: String(e) }));
    } finally {
      setEvolutionBusy(null);
    }
  };

  const handleCuratorRun = async (dryRun: boolean) => {
    setCuratorRunning(true);
    try {
      const msg = await skillEvolutionApi.curatorRun(dryRun);
      setSuccessMsg(msg);
      loadEvolution();
      loadSkills();
    } catch (e) {
      setError(t("skills.evolutionFailed", { error: String(e) }));
    } finally {
      setCuratorRunning(false);
    }
  };

  return (
    <div className="page">
      <div className="page-header">
        <h1 className="page-title">⚡ {t("skills.title")}</h1>
        <div className="page-header-actions">
          <span className="badge badge-info">
            {t("skills.enabledCount", { enabled: visibleSkills.filter((s) => s.enabled).length, total: visibleSkills.length })}
          </span>
          <button
            type="button"
            className="btn-header"
            onClick={handleSyncFromDisk}
            disabled={syncing}
            title={t("skills.syncBtn")}
          >
            {syncing ? t("skills.syncing") : `↻ ${t("skills.syncBtn")}`}
          </button>
        </div>
      </div>

      <div className="page-body">
        {error && (
          <div style={{ padding: "8px 14px", background: "rgba(220,53,69,0.15)", borderLeft: "3px solid #dc3545", color: "#ff6b6b", fontSize: "0.85rem", marginBottom: 12, display: "flex", justifyContent: "space-between" }}>
            <span>{error}</span>
            <button onClick={() => setError(null)} style={{ background: "none", border: "none", color: "#ff6b6b", cursor: "pointer" }}>✕</button>
          </div>
        )}
        {successMsg && (
          <div style={{ padding: "8px 14px", background: "rgba(40,167,69,0.12)", borderLeft: "3px solid #28a745", color: "#28a745", fontSize: "0.85rem", marginBottom: 12, display: "flex", justifyContent: "space-between" }}>
            <span>{successMsg}</span>
            <button onClick={() => setSuccessMsg(null)} style={{ background: "none", border: "none", color: "#28a745", cursor: "pointer" }}>✕</button>
          </div>
        )}

        <ConfirmDialog
          open={!!uninstallTarget}
          title={t("skills.uninstallConfirmTitle")}
          message={t("skills.uninstallConfirm", { name: uninstallTarget ?? "" })}
          confirmLabel={t("skills.uninstallBtn")}
          cancelLabel={t("common.cancel")}
          loading={uninstalling}
          onConfirm={doUninstall}
          onCancel={() => !uninstalling && setUninstallTarget(null)}
        />

        {/* Tab switcher */}
        <div style={{ display: "flex", gap: 4, marginBottom: 20, borderBottom: "1px solid var(--border)", paddingBottom: 0 }}>
          {(["local", "evolution", "hub", "official"] as const).map((tab) => (
            <button
              key={tab}
              onClick={() => setHubTab(tab)}
              style={{
                padding: "6px 16px",
                background: "none",
                border: "none",
                borderBottom: hubTab === tab ? "2px solid var(--accent)" : "2px solid transparent",
                color: hubTab === tab ? "var(--accent)" : "var(--text-secondary)",
                cursor: "pointer",
                fontWeight: hubTab === tab ? 600 : 400,
                fontSize: 13,
                marginBottom: -1,
              }}
            >
              {tab === "local"
                ? `⚡ ${t("skills.tabLocal")}`
                : tab === "evolution"
                  ? `🧬 ${t("skills.tabEvolution")}`
                  : tab === "hub"
                    ? `🛒 ${t("skills.tabHub")}`
                    : `🏛 ${t("skills.tabOfficial")}`}
            </button>
          ))}
        </div>

        {hubTab === "local" && (
          <>
            {/* Install panel */}
            <div style={{ marginBottom: 24, padding: "14px 16px", border: "1px solid var(--border)", borderRadius: 8, background: "var(--bg-secondary)" }}>
              <div style={{ fontWeight: 600, color: "var(--text-primary)", marginBottom: 8, fontSize: 14 }}>
                ⬇ {t("skills.installTitle")}
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <input
                  className="input"
                  style={{ flex: 1 }}
                  value={installUrl}
                  onChange={(e) => { setInstallUrl(e.target.value); setCompatCheck(null); }}
                  placeholder={t("skills.installPlaceholder")}
                  onKeyDown={(e) => e.key === "Enter" && handleInstall()}
                  disabled={installing}
                />
                <button
                  className="btn btn-secondary"
                  onClick={() => handleCheckCompat(installUrl)}
                  disabled={compatChecking || installing || !installUrl.trim()}
                  style={{ flexShrink: 0 }}
                  title={t("skills.checkCompatTitle")}
                >
                  {compatChecking ? "…" : t("skills.checkCompatBtn")}
                </button>
                <button
                  className="btn btn-primary"
                  onClick={handleInstall}
                  disabled={installing || !installUrl.trim() || compatCheck?.compatible === false}
                  style={{ flexShrink: 0 }}
                >
                  {installing ? t("skills.installing") : t("skills.installBtn")}
                </button>
              </div>
              {/* Compatibility check result */}
              {compatCheck && (
                <div style={{
                  marginTop: 8, padding: "8px 12px", borderRadius: 6, fontSize: 12,
                  background: compatCheck.compatible ? "rgba(40,167,69,0.1)" : "rgba(220,53,69,0.1)",
                  border: `1px solid ${compatCheck.compatible ? "#28a745" : "#dc3545"}`,
                  color: compatCheck.compatible ? "#28a745" : "#ff6b6b",
                }}>
                  {compatCheck.compatible
                    ? `✓ ${t("skills.compatOk")}`
                    : `✗ ${t("skills.compatFail")}`}
                  {compatCheck.issues.map((issue, i) => (
                    <div key={i} style={{ marginTop: 4, color: "#ff6b6b" }}>• {issue}</div>
                  ))}
                  {compatCheck.warnings.map((w, i) => (
                    <div key={i} style={{ marginTop: 4, color: "#ffc107" }}>⚠ {w}</div>
                  ))}
                </div>
              )}
              <p style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 6 }}>
                {t("skills.installHint")}
              </p>
            </div>

            <p style={{ color: "var(--text-secondary)", marginBottom: 16, fontSize: 13 }}>
              {t("skills.description")}
            </p>

            {visibleSkills.length === 0 ? (
              <div className="empty-state" style={{ padding: "28px 16px" }}>
                <div className="empty-state-title">{t("skills.emptyTitle")}</div>
                <div className="empty-state-desc">{t("skills.emptyDesc")}</div>
              </div>
            ) : (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))", gap: 12 }}>
              {visibleSkills.map((skill) => {
                const catalogEntry = catalogByName[skill.name.toLowerCase()];
                const source = catalogEntry?.source ?? "builtin";
                const badge = SOURCE_BADGE[source] ?? SOURCE_BADGE.builtin;
                const canUninstall = source === "installed" || source === "workspace";

                return (
                  <div key={skill.id} className="card skill-card" style={{ opacity: skill.enabled ? 1 : 0.6 }}>
                    <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                          <span style={{ fontSize: 20 }}>{skill.icon}</span>
                          <span style={{ fontWeight: 600, color: "var(--text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{skill.name}</span>
                          <span style={{ fontSize: 10, padding: "1px 6px", borderRadius: 10, background: "var(--bg-tertiary)", color: badge.color, flexShrink: 0, border: `1px solid ${badge.color}` }}>
                            {badge.label}
                          </span>
                        </div>
                        <p style={{ fontSize: 12, color: "var(--text-secondary)", margin: 0 }}>{skill.description}</p>
                        {catalogEntry && catalogEntry.tools.length > 0 && (
                          <p style={{ fontSize: 11, color: "var(--text-muted)", margin: "4px 0 0" }}>
                            {t("skills.toolsBadge", { tools: catalogEntry.tools.join(", ") })}
                          </p>
                        )}
                        {catalogEntry && catalogEntry.permissions.length > 0 && (
                          <p style={{ fontSize: 11, color: "#ffc107", margin: "2px 0 0" }}>
                            ⚠ {t("skills.permissionsBadge", { perms: catalogEntry.permissions.join(", ") })}
                          </p>
                        )}
                        {catalogEntry && catalogEntry.platform.length > 0 && (
                          <p style={{ fontSize: 11, color: "var(--text-muted)", margin: "2px 0 0" }}>
                            🖥 {t("skills.platformBadge", { platform: catalogEntry.platform.join(", ") })}
                          </p>
                        )}
                        {catalogEntry && catalogEntry.dependencies.length > 0 && (
                          <p style={{ fontSize: 11, color: "var(--text-muted)", margin: "2px 0 0" }}>
                            📦 {t("skills.depsBadge", { deps: catalogEntry.dependencies.join(", ") })}
                          </p>
                        )}
                      </div>
                      <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 8, flexShrink: 0 }}>
                        <label className="toggle">
                          <input
                            type="checkbox"
                            checked={skill.enabled}
                            onChange={(e) => handleToggle(skill.id, e.target.checked)}
                          />
                          <span className="toggle-slider" />
                        </label>
                        {canUninstall && (
                          <button
                            onClick={() => handleUninstall(skill.name)}
                            style={{ fontSize: 11, background: "none", border: "1px solid var(--border)", borderRadius: 4, padding: "2px 8px", color: "var(--text-muted)", cursor: "pointer" }}
                          >
                            {t("skills.uninstallBtn")}
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
            )}
          </>
        )}

        {hubTab === "evolution" && (
          <div>
            <div style={{ marginBottom: 20, padding: 14, border: "1px solid var(--border)", borderRadius: 8, background: "var(--bg-secondary)" }}>
              <div style={{ fontWeight: 600, marginBottom: 8 }}>🧹 {t("skills.curator")}</div>
              <div style={{ fontSize: 12, color: "var(--text-secondary)", marginBottom: 10 }}>
                {curatorStatus?.last_run_at
                  ? t("skills.curatorLastRun", { time: new Date(curatorStatus.last_run_at).toLocaleString() })
                  : t("skills.curatorNever")}
                {" · "}
                {t("skills.curatorDrafts", { count: curatorStatus?.draft_count ?? 0 })}
                {" · "}
                {t("skills.curatorLearned", { count: curatorStatus?.learned_count ?? 0 })}
                {" · "}
                {t("skills.curatorArchived", { count: curatorStatus?.archived_count ?? 0 })}
              </div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <button className="btn btn-primary" disabled={curatorRunning} onClick={() => handleCuratorRun(false)}>
                  {curatorRunning ? t("common.loading") : t("skills.curatorRun")}
                </button>
                <button className="btn btn-secondary" disabled={curatorRunning} onClick={() => handleCuratorRun(true)}>
                  {t("skills.curatorDryRun")}
                </button>
                <button
                  className="btn btn-secondary"
                  onClick={async () => {
                    try {
                      await skillEvolutionApi.curatorRollback();
                      setSuccessMsg("Curator rollback OK");
                      loadSkills();
                      loadEvolution();
                    } catch (e) {
                      setError(t("skills.evolutionFailed", { error: String(e) }));
                    }
                  }}
                >
                  {t("skills.curatorRollback")}
                </button>
              </div>
            </div>

            {draftSkills.length > 0 && (
              <div style={{ marginBottom: 20 }}>
                <h3 style={{ fontSize: 14, marginBottom: 8 }}>{t("skills.draft")}</h3>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))", gap: 10 }}>
                  {draftSkills.map((skill) => (
                    <div key={skill.id} className="card" style={{ padding: 12 }}>
                      <div style={{ fontWeight: 600 }}>{skill.name}</div>
                      <p style={{ fontSize: 12, color: "var(--text-secondary)" }}>{skill.description}</p>
                      <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
                        <button className="btn btn-primary" style={{ fontSize: 12 }} disabled={evolutionBusy === skill.id} onClick={() => handlePromote(skill.id, skill.name)}>
                          {t("skills.promote")}
                        </button>
                        <button className="btn btn-secondary" style={{ fontSize: 12 }} disabled={evolutionBusy === skill.id} onClick={() => handleDiscard(skill.id, skill.name)}>
                          {t("skills.discard")}
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div style={{ marginBottom: 20 }}>
              <h3 style={{ fontSize: 14, marginBottom: 8 }}>{t("skills.tabLocal")}</h3>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))", gap: 10 }}>
                {installedSkills.map((skill) => {
                  const meta = parseSkillConfig(skill.config);
                  return (
                    <div key={skill.id} className="card" style={{ padding: 12 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <span style={{ fontWeight: 600 }}>{skill.name}</span>
                        <span style={{ fontSize: 10, color: meta.locked ? "#dc3545" : "#28a745" }}>
                          {meta.locked ? `🔒 ${t("skills.locked")}` : `🔓 ${t("skills.unlocked")}`}
                        </span>
                      </div>
                      <button className="btn btn-secondary" style={{ fontSize: 12, marginTop: 8 }} disabled={evolutionBusy === skill.id} onClick={() => handleLockToggle(skill.id, !!meta.locked)}>
                        {meta.locked ? t("skills.unlockBtn") : t("skills.lockBtn")}
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>

            {learnedSkills.length > 0 && (
              <div style={{ marginBottom: 20 }}>
                <h3 style={{ fontSize: 14, marginBottom: 8 }}>{t("skills.learned")}</h3>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))", gap: 10 }}>
                  {learnedSkills.map((skill) => {
                    const meta = parseSkillConfig(skill.config);
                    return (
                      <div key={skill.id} className="card" style={{ padding: 12 }}>
                        <div style={{ fontWeight: 600 }}>{skill.name}</div>
                        <button className="btn btn-secondary" style={{ fontSize: 12, marginTop: 8 }} disabled={evolutionBusy === skill.id} onClick={() => handlePinToggle(skill.id, !!meta.pinned)}>
                          {meta.pinned ? t("skills.unpinBtn") : t("skills.pinBtn")}
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {revisions.length > 0 && (
              <div>
                <h3 style={{ fontSize: 14, marginBottom: 8 }}>{t("skills.revisionHistory")}</h3>
                <div style={{ border: "1px solid var(--border)", borderRadius: 8, overflow: "hidden" }}>
                  {revisions.map((rev) => (
                    <div key={rev.id} style={{ padding: "8px 12px", borderBottom: "1px solid var(--border)", fontSize: 12 }}>
                      <strong>{rev.skill_id}</strong>
                      {rev.origin && <span style={{ marginLeft: 8, color: "var(--text-muted)" }}>{rev.origin}</span>}
                      {rev.diff_summary && <div style={{ color: "var(--text-secondary)", marginTop: 4 }}>{rev.diff_summary}</div>}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {hubTab === "official" && (
          <div>
            <div style={{ marginBottom: 16 }}>
              <div style={{ fontWeight: 600, color: "var(--text-primary)", marginBottom: 8, fontSize: 14 }}>
                🏛 {t("skills.officialSearch")}
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <input
                  className="input"
                  style={{ flex: 1 }}
                  value={officialQuery}
                  onChange={(e) => setOfficialQuery(e.target.value)}
                  placeholder={t("skills.officialSearchPlaceholder")}
                  onKeyDown={(e) => e.key === "Enter" && handleOfficialSearch()}
                  disabled={officialSearching}
                />
                <button
                  className="btn btn-primary"
                  onClick={handleOfficialSearch}
                  disabled={officialSearching}
                  style={{ flexShrink: 0 }}
                >
                  {officialSearching ? t("common.loading") : t("common.search")}
                </button>
              </div>
              <p style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 6 }}>
                {t("skills.officialHint")}
              </p>
            </div>

            {officialError && (
              <div style={{ padding: "8px 14px", background: "rgba(220,53,69,0.1)", borderLeft: "3px solid #dc3545", color: "#ff6b6b", fontSize: 12, marginBottom: 12 }}>
                {officialError}
              </div>
            )}

            <div style={{ display: "grid", gridTemplateColumns: officialDetail ? "1fr 1.2fr" : "1fr", gap: 16 }}>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 12, alignContent: "start" }}>
                {officialPlugins.length === 0 && !officialSearching && !officialError && (
                  <div className="empty-state" style={{ padding: "28px 16px", gridColumn: "1 / -1" }}>
                    <div className="empty-state-title">{t("skills.officialEmpty")}</div>
                    <div className="empty-state-desc">{t("skills.officialEmptyDesc")}</div>
                  </div>
                )}
                {officialPlugins.map((plugin) => (
                  <div
                    key={plugin.id}
                    className="card"
                    style={{
                      padding: 12,
                      cursor: "pointer",
                      border: officialDetail?.plugin.id === plugin.id ? "1px solid var(--accent)" : undefined,
                    }}
                    onClick={() => handleOfficialSelect(plugin)}
                  >
                    <div style={{ fontWeight: 600, marginBottom: 4 }}>{plugin.name}</div>
                    <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 6 }}>
                      {plugin.category || "plugin"} · {plugin.author}
                    </div>
                    <p style={{ fontSize: 12, color: "var(--text-secondary)", margin: 0, lineHeight: 1.4 }}>
                      {plugin.description || t("skills.noDescription")}
                    </p>
                  </div>
                ))}
              </div>

              {officialDetail && (
                <div className="card" style={{ padding: 14, alignSelf: "start" }}>
                  {officialDetailLoading ? (
                    <div>{t("common.loading")}</div>
                  ) : (
                    <>
                      <div style={{ fontWeight: 600, fontSize: 15, marginBottom: 4 }}>{officialDetail.plugin.name}</div>
                      <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 8 }}>
                        {officialDetail.plugin.source_path}
                        {officialDetail.plugin.homepage && (
                          <> · <a href={officialDetail.plugin.homepage} target="_blank" rel="noreferrer">GitHub</a></>
                        )}
                      </div>
                      <p style={{ fontSize: 12, color: "var(--text-secondary)", marginBottom: 12 }}>
                        {officialDetail.plugin.description}
                      </p>
                      {officialDetail.skills.length === 0 ? (
                        <div style={{ fontSize: 12, color: "var(--text-muted)" }}>{t("skills.officialNoSkills")}</div>
                      ) : (
                        <>
                          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>
                            {t("skills.officialSkillsTitle", { count: officialDetail.skills.length })}
                          </div>
                          <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 12 }}>
                            {officialDetail.skills.map((skill) => (
                              <div key={skill.dir_name} style={{ padding: 8, border: "1px solid var(--border)", borderRadius: 6 }}>
                                <div style={{ fontWeight: 600, fontSize: 13 }}>{skill.name}</div>
                                <div style={{ fontSize: 11, color: "var(--text-muted)" }}>{skill.dir_name}</div>
                                <p style={{ fontSize: 12, margin: "4px 0 0", color: "var(--text-secondary)" }}>
                                  {skill.description || t("skills.noDescription")}
                                </p>
                              </div>
                            ))}
                          </div>
                          <button
                            className="btn btn-primary"
                            disabled={officialInstalling === officialDetail.plugin.id}
                            onClick={() => handleOfficialInstall(officialDetail.plugin.id)}
                          >
                            {officialInstalling === officialDetail.plugin.id
                              ? t("skills.installing")
                              : t("skills.officialInstallAll", { count: officialDetail.skills.length })}
                          </button>
                        </>
                      )}
                    </>
                  )}
                </div>
              )}
            </div>
          </div>
        )}

        {hubTab === "hub" && (
          <div>
            {/* ClawHub search */}
            <div style={{ marginBottom: 16 }}>
              <div style={{ fontWeight: 600, color: "var(--text-primary)", marginBottom: 8, fontSize: 14 }}>
                🔍 {t("skills.hubSearch")}
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <input
                  className="input"
                  style={{ flex: 1 }}
                  value={hubQuery}
                  onChange={(e) => setHubQuery(e.target.value)}
                  placeholder={t("skills.hubSearchPlaceholder")}
                  onKeyDown={(e) => e.key === "Enter" && handleHubSearch()}
                  disabled={hubSearching}
                />
                <button
                  className="btn btn-primary"
                  onClick={handleHubSearch}
                  disabled={hubSearching}
                  style={{ flexShrink: 0 }}
                >
                  {hubSearching ? t("common.loading") : t("common.search")}
                </button>
              </div>
              <p style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 6 }}>
                {t("skills.hubHint")}
              </p>
            </div>

            {hubError && (
              <div style={{ padding: "8px 14px", background: "rgba(220,53,69,0.1)", borderLeft: "3px solid #dc3545", color: "#ff6b6b", fontSize: 12, marginBottom: 12 }}>
                {hubError}
              </div>
            )}

            {hubResults.length === 0 && !hubSearching && !hubError && (
              <div className="empty-state" style={{ padding: "28px 16px" }}>
                <div className="empty-state-title">{t("skills.hubEmpty")}</div>
                <div className="empty-state-desc">{t("skills.hubEmptyDesc")}</div>
              </div>
            )}

            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))", gap: 12 }}>
              {hubResults.map((skill) => {
                const isInstalling = hubInstalling === skill.slug;
                const incompatible = skill.compatible === false;
                return (
                  <div
                    key={skill.slug}
                    className="card"
                    style={{
                      display: "flex", flexDirection: "column", gap: 8,
                      opacity: incompatible ? 0.75 : 1,
                      border: incompatible ? "1px solid rgba(220,53,69,0.4)" : undefined,
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 8 }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
                          <span style={{ fontWeight: 600, color: "var(--text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {skill.name}
                          </span>
                          {skill.version && (
                            <span style={{ fontSize: 10, color: "var(--text-muted)", flexShrink: 0 }}>
                              {/^\d/.test(skill.version) ? `v${skill.version}` : skill.version}
                            </span>
                          )}
                          {/* Compat badge — shown once check completes */}
                          {skill.compatible === true && (
                            <span style={{ fontSize: 10, color: "#28a745", background: "rgba(40,167,69,0.12)", padding: "1px 6px", borderRadius: 8, flexShrink: 0 }}>
                              ✓ {t("skills.compatOk")}
                            </span>
                          )}
                          {incompatible && (
                            <span style={{ fontSize: 10, color: "#ff6b6b", background: "rgba(220,53,69,0.12)", padding: "1px 6px", borderRadius: 8, flexShrink: 0 }}>
                              ✗ {t("skills.compatFail")}
                            </span>
                          )}
                          {skill.compatible === null && skill.skill_url && (
                            <span style={{ fontSize: 10, color: "var(--text-muted)", flexShrink: 0 }}>…</span>
                          )}
                        </div>
                        <p style={{ fontSize: 12, color: "var(--text-secondary)", margin: 0, lineHeight: 1.4 }}>
                          {skill.description || t("skills.noDescription")}
                        </p>
                        {/* Compat issues */}
                        {incompatible && skill.compat_issues.length > 0 && (
                          <div style={{ marginTop: 4, fontSize: 11, color: "#ff6b6b" }}>
                            {skill.compat_issues.map((issue, i) => (
                              <div key={i}>⚠ {issue}</div>
                            ))}
                          </div>
                        )}
                        {/* Platform / deps badges */}
                        {(skill.platform.length > 0 || skill.dependencies.length > 0) && (
                          <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 4 }}>
                            {skill.platform.length > 0 && (
                              <span style={{ fontSize: 10, color: "var(--text-muted)", background: "var(--bg-tertiary)", padding: "1px 6px", borderRadius: 8, border: "1px solid var(--border)" }}>
                                🖥 {skill.platform.join("/")}
                              </span>
                            )}
                            {skill.dependencies.map((dep) => (
                              <span key={dep} style={{ fontSize: 10, color: "var(--text-muted)", background: "var(--bg-tertiary)", padding: "1px 6px", borderRadius: 8, border: "1px solid var(--border)" }}>
                                📦 {dep}
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                      <button
                        className={`btn ${incompatible ? "btn-secondary" : "btn-primary"}`}
                        onClick={() => handleHubInstall(skill)}
                        disabled={isInstalling || incompatible}
                        title={incompatible ? skill.compat_issues.join("; ") : undefined}
                        style={{ flexShrink: 0, fontSize: 12, padding: "4px 12px" }}
                      >
                        {isInstalling ? t("skills.installing") : incompatible ? t("skills.compatFail") : t("skills.installBtn")}
                      </button>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 12, fontSize: 11, color: "var(--text-muted)" }}>
                      <span>👤 {skill.author}</span>
                      <span>⭐ {skill.stars}</span>
                      {skill.tags.slice(0, 3).map((tag) => (
                        <span key={tag} style={{ padding: "1px 6px", background: "var(--bg-tertiary)", borderRadius: 10, border: "1px solid var(--border)" }}>
                          {tag}
                        </span>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      <style>{`
        .toggle { position: relative; display: inline-block; width: 40px; height: 22px; flex-shrink: 0; }
        .toggle input { opacity: 0; width: 0; height: 0; }
        .toggle-slider { position: absolute; cursor: pointer; inset: 0; background: var(--bg-tertiary); border: 1px solid var(--border); border-radius: 100px; transition: 0.2s; }
        .toggle-slider::before { content: ""; position: absolute; width: 16px; height: 16px; left: 2px; top: 2px; background: var(--text-muted); border-radius: 50%; transition: 0.2s; }
        .toggle input:checked + .toggle-slider { background: var(--accent-dim); border-color: var(--accent); }
        .toggle input:checked + .toggle-slider::before { transform: translateX(18px); background: var(--accent); }
      `}</style>
    </div>
  );
}
