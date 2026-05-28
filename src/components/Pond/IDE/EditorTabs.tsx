import { useTranslation } from "react-i18next";
import type { OpenTab } from "./types";

interface TabContextMenu {
  x: number;
  y: number;
  targetPath: string;
}

interface EditorTabsProps {
  tabs: OpenTab[];
  activeTabPath: string | null;
  onTabClick: (path: string) => void;
  onTabClose: (path: string) => void;
  onSave?: (path: string) => void;
  onTabContextMenu?: (e: React.MouseEvent, path: string) => void;
  onCloseAll?: () => void;
  onCloseUnsaved?: () => void;
  onCloseOther?: (path: string) => void;
  contextMenu: TabContextMenu | null;
}

export default function EditorTabs({
  tabs,
  activeTabPath,
  onTabClick,
  onTabClose,
  onSave,
  onTabContextMenu,
  onCloseAll,
  onCloseUnsaved,
  onCloseOther,
  contextMenu,
}: EditorTabsProps) {
  const { t } = useTranslation();

  if (tabs.length === 0) return null;

  const ctxTarget = contextMenu
    ? tabs.find((t) => t.path === contextMenu.targetPath)
    : null;

  return (
    <>
      <div className="ide-tabs">
        {tabs.map((tab) => (
          <div
            key={tab.path}
            className={`ide-tab ${tab.path === activeTabPath ? "active" : ""}`}
            onClick={() => onTabClick(tab.path)}
            onContextMenu={(e) => onTabContextMenu?.(e, tab.path)}
          >
            <span className="tab-name" title={tab.path}>
              {tab.name}
              {tab.isDirty && <span className="tab-dirty">●</span>}
            </span>
            <span
              className="tab-close"
              onClick={(e) => {
                e.stopPropagation();
                onTabClose(tab.path);
              }}
            >
              ×
            </span>
          </div>
        ))}
      </div>

      {contextMenu && (
        <div
          className="ide-tab-context-menu"
          style={{
            position: "fixed",
            left: contextMenu.x,
            top: contextMenu.y,
            zIndex: 1000,
          }}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            onClick={() => {
              if (ctxTarget) onTabClose(ctxTarget.path);
            }}
          >
            {t("ide.closeCurrent") || "Close"}
          </button>
          {onCloseOther && (
            <button
              type="button"
              onClick={() => {
                if (ctxTarget) onCloseOther(ctxTarget.path);
              }}
            >
              {t("ide.closeOther") || "Close Others"}
            </button>
          )}
          <button
            type="button"
            onClick={() => onCloseAll?.()}
          >
            {t("ide.closeAll") || "Close All"}
          </button>
          <div className="ide-tab-context-separator" />
          <button
            type="button"
            onClick={() => {
              if (ctxTarget) onSave?.(ctxTarget.path);
            }}
            disabled={!ctxTarget?.isDirty}
          >
            {t("ide.saveFile") || "Save"}
          </button>
          <div className="ide-tab-context-separator" />
          <button
            type="button"
            onClick={() => onCloseUnsaved?.()}
          >
            {t("ide.closeUnsaved") || "Close Unsaved"}
          </button>
        </div>
      )}
    </>
  );
}
