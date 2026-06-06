import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useSelector } from "react-redux";
import { poolApi } from "../../../services/tauri";
import { RootState } from "../../../store";
import "./PoolMemberPicker.css";

interface PoolMemberPickerProps {
  poolId: string;
  /** Ids of Koi already in the project (drives the "already in project" state). */
  memberKoiIds: string[];
  onClose: () => void;
  /** Open the global Koi manager so the user can create new Koi. */
  onManageKois: () => void;
}

/**
 * Modal that lists every globally-registered Koi and lets the user add the
 * ones that have not yet joined the current project. Removal happens from the
 * participant row's × button, not here.
 */
export default function PoolMemberPicker({
  poolId,
  memberKoiIds,
  onClose,
  onManageKois,
}: PoolMemberPickerProps) {
  const { t } = useTranslation();
  const kois = useSelector((s: RootState) => s.koi.kois);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState("");

  const members = new Set(memberKoiIds);

  const handleAdd = async (koiId: string) => {
    setPendingId(koiId);
    setError("");
    try {
      await poolApi.addMember(poolId, koiId);
    } catch (e) {
      setError(String(e));
    } finally {
      setPendingId(null);
    }
  };

  return (
    <div className="koi-modal-overlay" onClick={onClose}>
      <div className="member-picker" onClick={(e) => e.stopPropagation()}>
        <div className="member-picker-header">
          <span className="member-picker-title">{t("pool.memberPickerTitle")}</span>
          <button className="member-picker-close" onClick={onClose} aria-label={t("common.close") || "Close"}>
            ×
          </button>
        </div>
        <div className="member-picker-hint">{t("pool.memberPickerHint")}</div>

        <div className="member-picker-list">
          {kois.length === 0 ? (
            <div className="member-picker-empty">{t("pool.noAvailableKois")}</div>
          ) : (
            kois.map((koi) => {
              const isMember = members.has(koi.id);
              return (
                <div key={koi.id} className="member-picker-row">
                  <span className="member-picker-icon">{koi.icon || "🐡"}</span>
                  <span className="member-picker-info">
                    <span className="member-picker-name" style={{ color: koi.color }}>
                      {koi.name}
                    </span>
                    {(koi.role || koi.description) && (
                      <span className="member-picker-role">{koi.role || koi.description}</span>
                    )}
                  </span>
                  {isMember ? (
                    <span className="member-picker-tag">{t("pool.alreadyMember")}</span>
                  ) : (
                    <button
                      className="member-picker-add"
                      disabled={pendingId === koi.id}
                      onClick={() => handleAdd(koi.id)}
                    >
                      {t("pool.addMember")}
                    </button>
                  )}
                </div>
              );
            })
          )}
        </div>

        {error && <div className="member-picker-error">{error}</div>}

        <div className="member-picker-footer">
          <button className="member-picker-manage" onClick={onManageKois}>
            {t("pool.manageKois")}
          </button>
        </div>
      </div>
    </div>
  );
}
