import type { OpenTab } from "./types";

interface EditorTabsProps {
  tabs: OpenTab[];
  activeTabPath: string | null;
  onTabClick: (path: string) => void;
  onTabClose: (path: string) => void;
}

export default function EditorTabs({
  tabs,
  activeTabPath,
  onTabClick,
  onTabClose,
}: EditorTabsProps) {
  if (tabs.length === 0) return null;

  return (
    <div className="ide-tabs">
      {tabs.map((tab) => (
        <div
          key={tab.path}
          className={`ide-tab ${tab.path === activeTabPath ? "active" : ""}`}
          onClick={() => onTabClick(tab.path)}
        >
          <span className="tab-name" title={tab.path}>
            {tab.name}
          </span>
          {tab.isDirty && <span className="tab-dirty">●</span>}
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
  );
}
