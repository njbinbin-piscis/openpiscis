import { useEffect, useMemo, useRef, useState } from "react";
import "./AppDropdown.css";

export type AppMenuItem = {
  id: string;
  label: string;
  icon?: string;
  selected?: boolean;
  action?: boolean;
  /** Non-interactive row (e.g. current path). */
  disabled?: boolean;
};

export type AppDropdownProps = {
  menuId: string;
  triggerLabel: string;
  triggerTitle?: string;
  items: AppMenuItem[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (id: string) => void;
  disabled?: boolean;
  icon?: string;
  searchPlaceholder?: string;
  emptyLabel?: string;
  closeOnSelect?: boolean;
  variant?: "default" | "wide" | "toolbar" | "form";
  /** Panel opens above trigger (composer) or below (toolbars). */
  placement?: "above" | "below";
};

export default function AppDropdown({
  menuId,
  icon,
  triggerLabel,
  triggerTitle,
  items,
  open,
  onOpenChange,
  onSelect,
  disabled = false,
  searchPlaceholder,
  emptyLabel,
  closeOnSelect = true,
  variant = "default",
  placement = "below",
}: AppDropdownProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");

  useEffect(() => {
    if (!open) {
      setQuery("");
      return;
    }
    if (searchPlaceholder || items.length >= 6) {
      searchRef.current?.focus();
    }
  }, [open, searchPlaceholder, items.length]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        onOpenChange(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onOpenChange(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, onOpenChange]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter((item) => item.label.toLowerCase().includes(q));
  }, [items, query]);

  const showSearch = items.length >= 6 || Boolean(searchPlaceholder);
  const panelPlacementClass =
    placement === "above" ? "app-dropdown-panel-above" : "app-dropdown-panel-below";

  return (
    <div
      ref={rootRef}
      className={`app-dropdown app-dropdown-${variant}${open ? " app-dropdown-open" : ""}`}
      data-menu={menuId}
    >
      <button
        type="button"
        className="app-dropdown-trigger select-control"
        disabled={disabled}
        aria-expanded={open}
        aria-haspopup="listbox"
        onClick={() => onOpenChange(!open)}
      >
        {icon && (
          <span className="app-dropdown-trigger-icon" aria-hidden>
            {icon}
          </span>
        )}
        <span className="app-dropdown-trigger-label" title={triggerTitle ?? triggerLabel}>
          {triggerLabel}
        </span>
      </button>
      {open && (
        <div className={`app-dropdown-panel ${panelPlacementClass}`} role="listbox">
          {showSearch && (
            <div className="app-dropdown-header">
              <input
                ref={searchRef}
                type="search"
                className="app-dropdown-search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={searchPlaceholder}
                onKeyDown={(e) => e.stopPropagation()}
              />
            </div>
          )}
          <div className="app-dropdown-list">
            {filtered.length === 0 ? (
              <div className="app-dropdown-empty">{emptyLabel ?? "—"}</div>
            ) : (
              filtered.map((item) => {
                const rowClass = `app-dropdown-item${item.selected ? " selected" : ""}${item.action ? " action" : ""}${item.disabled ? " info" : ""}`;
                if (item.disabled) {
                  return (
                    <div key={item.id} role="presentation" className={rowClass} title={item.label}>
                      {item.icon && (
                        <span className="app-dropdown-item-icon" aria-hidden>
                          {item.icon}
                        </span>
                      )}
                      <span className="app-dropdown-item-label">{item.label}</span>
                    </div>
                  );
                }
                return (
                  <button
                    key={item.id}
                    type="button"
                    role="option"
                    aria-selected={item.selected}
                    className={rowClass}
                    onClick={() => {
                      onSelect(item.id);
                      if (closeOnSelect) onOpenChange(false);
                    }}
                  >
                    {item.icon && (
                      <span className="app-dropdown-item-icon" aria-hidden>
                        {item.icon}
                      </span>
                    )}
                    <span className="app-dropdown-item-label">{item.label}</span>
                    {item.selected && <span className="app-dropdown-item-check">✓</span>}
                  </button>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}
