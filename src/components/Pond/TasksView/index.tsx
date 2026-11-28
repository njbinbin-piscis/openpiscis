/**
 * TasksView — merged Board + Timeline under one "Tasks" tab.
 *
 * Top: shared Koi / priority filters (Redux board slice, same state the
 * standalone Board uses) plus Board/Timeline sub-tabs. Bottom: the active
 * sub-view. Both views honour the same filters:
 *   - Board already reads filterOwnerId / filterPriority from the store.
 *   - Timeline receives them as props and filters lanes/segments.
 */
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useSelector, useDispatch } from "react-redux";
import { RootState, boardActions } from "../../../store";
import AppDropdown, { type AppMenuItem } from "../../ui/AppDropdown";
import Board from "../Board";
import KoiTimeline from "../Timeline";
import "./TasksView.css";

const PRIORITIES = ["low", "medium", "high", "urgent"] as const;

type SubTab = "board" | "timeline";

interface Props {
  poolId: string | null;
  onJumpToMessage?: (messageId: number) => void;
  onOpenTask?: (koiId: string, todoId: string) => void;
}

export default function TasksView({ poolId, onJumpToMessage, onOpenTask }: Props) {
  const { t } = useTranslation();
  const dispatch = useDispatch();
  const [subTab, setSubTab] = useState<SubTab>("board");
  const [filterMenuOpen, setFilterMenuOpen] = useState<null | "koi" | "priority">(null);

  const kois = useSelector((s: RootState) => s.koi.kois);
  const filterOwnerId = useSelector((s: RootState) => s.board.filterOwnerId);
  const filterPriority = useSelector((s: RootState) => s.board.filterPriority);

  const koiFilterItems = useMemo((): AppMenuItem[] => {
    const rows: AppMenuItem[] = [
      { id: "", label: `${t("board.filterByKoi")}: ${t("board.filterAll")}`, selected: !filterOwnerId },
    ];
    for (const k of kois) {
      rows.push({ id: k.id, label: `${k.icon} ${k.name}`, selected: filterOwnerId === k.id });
    }
    return rows;
  }, [kois, filterOwnerId, t]);

  const koiFilterLabel = useMemo(() => {
    if (!filterOwnerId) return `${t("board.filterByKoi")}: ${t("board.filterAll")}`;
    const k = kois.find((x) => x.id === filterOwnerId);
    return k ? `${k.icon} ${k.name}` : filterOwnerId;
  }, [filterOwnerId, kois, t]);

  const priorityFilterItems = useMemo((): AppMenuItem[] => {
    const rows: AppMenuItem[] = [
      { id: "", label: `${t("board.filterByPriority")}: ${t("board.filterAll")}`, selected: !filterPriority },
    ];
    for (const p of PRIORITIES) {
      rows.push({
        id: p,
        label: t(`board.priority${p.charAt(0).toUpperCase() + p.slice(1)}`),
        selected: filterPriority === p,
      });
    }
    return rows;
  }, [filterPriority, t]);

  const priorityFilterLabel = useMemo(() => {
    if (!filterPriority) return `${t("board.filterByPriority")}: ${t("board.filterAll")}`;
    return t(`board.priority${filterPriority.charAt(0).toUpperCase() + filterPriority.slice(1)}`);
  }, [filterPriority, t]);

  return (
    <div className="tasks-view">
      <div className="tasks-toolbar">
        <div className="tasks-subtabs" role="tablist">
          <button
            role="tab"
            aria-selected={subTab === "board"}
            className={`tasks-subtab${subTab === "board" ? " active" : ""}`}
            onClick={() => setSubTab("board")}
          >
            📋 {t("pond.tabBoard") || "Board"}
          </button>
          <button
            role="tab"
            aria-selected={subTab === "timeline"}
            className={`tasks-subtab${subTab === "timeline" ? " active" : ""}`}
            onClick={() => setSubTab("timeline")}
          >
            🕒 {t("pond.tabTimeline") || "Timeline"}
          </button>
        </div>
        <div className="tasks-filters">
          <AppDropdown
            menuId="tasks-koi-filter"
            triggerLabel={koiFilterLabel}
            items={koiFilterItems}
            open={filterMenuOpen === "koi"}
            onOpenChange={(open) => setFilterMenuOpen(open ? "koi" : null)}
            onSelect={(id) => dispatch(boardActions.setFilterOwnerId(id || null))}
            variant="toolbar"
            searchPlaceholder={t("common.search")}
            emptyLabel={t("ide.noResults")}
          />
          <AppDropdown
            menuId="tasks-priority-filter"
            triggerLabel={priorityFilterLabel}
            items={priorityFilterItems}
            open={filterMenuOpen === "priority"}
            onOpenChange={(open) => setFilterMenuOpen(open ? "priority" : null)}
            onSelect={(id) => dispatch(boardActions.setFilterPriority(id || null))}
            variant="toolbar"
          />
        </div>
      </div>

      <div className="tasks-body">
        {subTab === "board" ? (
          <Board hideToolbar />
        ) : (
          <KoiTimeline
            poolId={poolId}
            onJumpToMessage={onJumpToMessage}
            onOpenTask={onOpenTask}
            filterOwnerId={filterOwnerId}
            filterPriority={filterPriority}
          />
        )}
      </div>
    </div>
  );
}