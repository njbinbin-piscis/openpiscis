import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useSelector } from "react-redux";
import KoiManager from "./KoiManager";
import ChatPool from "./ChatPool";
import Board from "./Board";
import PisciInbox from "./PisciInbox";
import IDE from "./IDE";
import type { RootState } from "../../store";
import "./Pond.css";

type PondSubTab = "kois" | "pool" | "board" | "inbox" | "koiObserver" | "ide";

export default function Pond() {
  const { t } = useTranslation();
  const [subTab, setSubTab] = useState<PondSubTab>("kois");

  // Pool session for IDE project_dir
  const poolSessions = useSelector((s: RootState) => s.pool.sessions);
  const activePoolId = useSelector((s: RootState) => s.pool.activeSessionId);
  const projectDir = poolSessions.find(s => s.id === activePoolId)?.project_dir ?? null;

  const tabs: { id: PondSubTab; label: string; icon: string }[] = [
    { id: "kois", label: t("pond.tabKois"), icon: "🐡" },
    { id: "pool", label: t("pond.tabPool"), icon: "💬" },
    { id: "board", label: t("pond.tabBoard"), icon: "📋" },
    { id: "inbox", label: t("pond.tabInbox"), icon: "📬" },
    { id: "koiObserver", label: t("pond.tabKoiObserver"), icon: "🔎" },
    { id: "ide", label: t("pond.tabIde"), icon: "💻" },
  ];

  return (
    <div className="pond">
      <div className="pond-header">
        <h2 className="pond-title">🏊 {t("pond.title")}</h2>
        <div className="pond-tabs">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              className={`pond-tab ${subTab === tab.id ? "active" : ""}`}
              onClick={() => setSubTab(tab.id)}
            >
              <span className="pond-tab-icon">{tab.icon}</span>
              <span>{tab.label}</span>
            </button>
          ))}
        </div>
      </div>
      <div className="pond-content">
        {subTab === "kois" && <KoiManager />}
        {subTab === "pool" && <ChatPool />}
        {subTab === "board" && <Board />}
        {subTab === "inbox" && <PisciInbox mode="coordination" />}
        {subTab === "koiObserver" && <PisciInbox mode="koiObserver" />}
        {subTab === "ide" && <IDE projectDir={projectDir} poolSessionId={activePoolId} />}
      </div>
    </div>
  );
}
