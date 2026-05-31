import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { koiApi, poolApi } from "../../../services/tauri";
import type { KoiDefinition, PoolSession } from "../../../services/tauri";
import type { UiBlock, UiButton } from "./protocol";

export function TextBlock({ block }: { block: UiBlock }) {
  return <p className="ic-text">{block.content || ""}</p>;
}

export function SectionBlock({ block }: { block: UiBlock }) {
  return (
    <div className="ic-section">
      {block.label && <div className="ic-section-title">{block.label}</div>}
      {block.description && <p className="ic-section-desc">{block.description}</p>}
    </div>
  );
}

export function TextInputBlock({
  block,
  value,
  onChange,
  disabled,
  error,
}: {
  block: UiBlock;
  value: string;
  onChange: (v: string) => void;
  disabled: boolean;
  error?: string;
}) {
  const inputType =
    block.input_mode === "password"
      ? "password"
      : block.input_mode === "email"
        ? "email"
        : block.input_mode === "url"
          ? "url"
          : "text";

  return (
    <div className={`ic-field${error ? " ic-field-error" : ""}`}>
      {block.label && <label className="ic-label">{block.label}</label>}
      {block.description && <p className="ic-field-hint">{block.description}</p>}
      {block.multiline ? (
        <textarea
          className="ic-textarea"
          value={value}
          rows={block.rows ?? 3}
          placeholder={block.placeholder || ""}
          minLength={block.min_length}
          maxLength={block.max_length}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
        />
      ) : (
        <input
          type={inputType}
          className="ic-input"
          value={value}
          placeholder={block.placeholder || ""}
          minLength={block.min_length}
          maxLength={block.max_length}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
        />
      )}
      {error && <span className="ic-error">{error}</span>}
    </div>
  );
}

export function NumberInputBlock({
  block,
  value,
  onChange,
  disabled,
  error,
  asSlider,
}: {
  block: UiBlock;
  value: number;
  onChange: (v: number) => void;
  disabled: boolean;
  error?: string;
  asSlider?: boolean;
}) {
  const min = typeof block.min === "number" ? block.min : undefined;
  const max = typeof block.max === "number" ? block.max : undefined;
  const step = block.step ?? 1;

  if (asSlider) {
    return (
      <div className={`ic-field${error ? " ic-field-error" : ""}`}>
        {block.label && (
          <label className="ic-label">
            {block.label}
            <span className="ic-slider-value">{Number.isFinite(value) ? value : "—"}</span>
          </label>
        )}
        <input
          type="range"
          className="ic-slider"
          value={Number.isFinite(value) ? value : 0}
          min={min}
          max={max}
          step={step}
          onChange={(e) => onChange(Number(e.target.value))}
          disabled={disabled}
        />
        {error && <span className="ic-error">{error}</span>}
      </div>
    );
  }

  return (
    <div className={`ic-field${error ? " ic-field-error" : ""}`}>
      {block.label && <label className="ic-label">{block.label}</label>}
      <input
        type="number"
        className="ic-input"
        value={Number.isFinite(value) ? value : ""}
        min={min}
        max={max}
        step={step}
        placeholder={block.placeholder || ""}
        onChange={(e) => {
          const next = e.target.value === "" ? NaN : Number(e.target.value);
          onChange(Number.isFinite(next) ? next : 0);
        }}
        disabled={disabled}
      />
      {error && <span className="ic-error">{error}</span>}
    </div>
  );
}

export function SwitchBlock({
  block,
  value,
  onChange,
  disabled,
}: {
  block: UiBlock;
  value: boolean;
  onChange: (v: boolean) => void;
  disabled: boolean;
}) {
  return (
    <label className="ic-switch-row">
      <input
        type="checkbox"
        className="ic-switch-input"
        checked={!!value}
        onChange={(e) => onChange(e.target.checked)}
        disabled={disabled}
      />
      <span className="ic-switch-track" aria-hidden />
      <span className="ic-switch-label">{block.label || block.id}</span>
      {block.description && <span className="ic-switch-desc">{block.description}</span>}
    </label>
  );
}

export function DateTimeBlock({
  block,
  value,
  onChange,
  disabled,
  error,
}: {
  block: UiBlock;
  value: string;
  onChange: (v: string) => void;
  disabled: boolean;
  error?: string;
}) {
  const inputType =
    block.type === "time" ? "time" : block.type === "datetime" ? "datetime-local" : "date";

  return (
    <div className={`ic-field${error ? " ic-field-error" : ""}`}>
      {block.label && <label className="ic-label">{block.label}</label>}
      <input
        type={inputType}
        className="ic-input"
        value={value}
        min={typeof block.min === "string" ? block.min : undefined}
        max={typeof block.max === "string" ? block.max : undefined}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
      />
      {error && <span className="ic-error">{error}</span>}
    </div>
  );
}

export function TagsBlock({
  block,
  value,
  onChange,
  disabled,
  error,
}: {
  block: UiBlock;
  value: string[];
  onChange: (v: string[]) => void;
  disabled: boolean;
  error?: string;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState("");
  const suggestions = new Set(block.options?.map((o) => o.value) ?? []);

  const addTag = (raw: string) => {
    const tag = raw.trim();
    if (!tag || value.includes(tag)) return;
    if (typeof block.max === "number" && value.length >= block.max) return;
    onChange([...value, tag]);
    setDraft("");
  };

  const removeTag = (tag: string) => onChange(value.filter((x) => x !== tag));

  return (
    <div className={`ic-field${error ? " ic-field-error" : ""}`}>
      {block.label && <label className="ic-label">{block.label}</label>}
      <div className="ic-tags">
        {value.map((tag) => (
          <span key={tag} className="ic-tag">
            {tag}
            {!disabled && (
              <button type="button" className="ic-tag-remove" onClick={() => removeTag(tag)} aria-label="remove">
                ×
              </button>
            )}
          </span>
        ))}
      </div>
      {!disabled && (block.allow_custom !== false) && (
        <div className="ic-tags-input-row">
          <input
            type="text"
            className="ic-input"
            value={draft}
            placeholder={block.placeholder || t("chat.interactiveTagPlaceholder", { defaultValue: "Add and press Enter" })}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addTag(draft);
              }
            }}
            list={block.id ? `ic-tags-${block.id}` : undefined}
          />
          <button type="button" className="ic-btn ic-btn-default" onClick={() => addTag(draft)}>
            {t("chat.interactiveTagAdd", { defaultValue: "Add" })}
          </button>
        </div>
      )}
      {suggestions.size > 0 && (
        <datalist id={block.id ? `ic-tags-${block.id}` : undefined}>
          {[...suggestions].map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
      )}
      {block.options && block.options.length > 0 && (
        <div className="ic-tag-suggestions">
          {block.options.map((opt) => (
            <button
              key={opt.value}
              type="button"
              className="ic-tag-suggestion"
              disabled={disabled || value.includes(opt.value)}
              onClick={() => addTag(opt.value)}
            >
              {opt.label}
            </button>
          ))}
        </div>
      )}
      {error && <span className="ic-error">{error}</span>}
    </div>
  );
}

export function KoiPickerBlock({
  block,
  value,
  onChange,
  disabled,
  error,
}: {
  block: UiBlock;
  value: string[];
  onChange: (v: string[]) => void;
  disabled: boolean;
  error?: string;
}) {
  const [kois, setKois] = useState<KoiDefinition[]>([]);
  useEffect(() => {
    koiApi.list().then(setKois).catch(() => {});
  }, []);

  const suggested = new Set(block.suggestions || []);
  const sorted = useMemo(
    () =>
      [...kois].sort((a, b) => {
        const aS = suggested.has(a.id) ? 0 : 1;
        const bS = suggested.has(b.id) ? 0 : 1;
        return aS - bS;
      }),
    [kois, suggested],
  );

  const toggle = (id: string) => {
    const has = value.includes(id);
    if (has) onChange(value.filter((x) => x !== id));
    else {
      if (typeof block.max === "number" && value.length >= block.max) return;
      onChange([...value, id]);
    }
  };

  return (
    <fieldset className={`ic-fieldset${error ? " ic-field-error" : ""}`}>
      {block.label && <legend className="ic-legend">{block.label}</legend>}
      <div className="ic-koi-grid">
        {sorted.map((k) => (
          <button
            key={k.id}
            type="button"
            className={`ic-koi-card${value.includes(k.id) ? " ic-koi-selected" : ""}`}
            onClick={() => !disabled && toggle(k.id)}
            disabled={disabled}
            style={{ borderColor: value.includes(k.id) ? k.color : undefined }}
          >
            <span className="ic-koi-icon" style={{ background: k.color }}>{k.icon}</span>
            <span className="ic-koi-name">{k.name}</span>
            <span className="ic-koi-desc">
              {k.description.slice(0, 40)}
              {k.description.length > 40 ? "..." : ""}
            </span>
            {suggested.has(k.id) && <span className="ic-koi-badge">Recommended</span>}
          </button>
        ))}
        {kois.length === 0 && <span className="ic-muted">No Koi available</span>}
      </div>
      {error && <span className="ic-error">{error}</span>}
    </fieldset>
  );
}

export function ProjectPickerBlock({
  block,
  value,
  onChange,
  disabled,
  error,
}: {
  block: UiBlock;
  value: string;
  onChange: (v: string) => void;
  disabled: boolean;
  error?: string;
}) {
  const [projects, setProjects] = useState<PoolSession[]>([]);
  useEffect(() => {
    poolApi.listSessions().then(setProjects).catch(() => {});
  }, []);

  const statusIcon = (s: string) => (s === "active" ? "🟢" : s === "paused" ? "🟡" : "⚪");

  return (
    <div className={`ic-field${error ? " ic-field-error" : ""}`}>
      {block.label && <label className="ic-label">{block.label}</label>}
      <select className="ic-select" value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled}>
        <option value="">—</option>
        {block.allow_new && <option value="__new__">+ New project</option>}
        {projects.map((p) => (
          <option key={p.id} value={p.id}>
            {statusIcon(p.status)} {p.name} [{p.status}]
          </option>
        ))}
      </select>
      {error && <span className="ic-error">{error}</span>}
    </div>
  );
}

export function ActionsBlock({
  block,
  onAction,
  disabled,
  submitting,
}: {
  block: UiBlock;
  onAction: (block: UiBlock, button: UiButton) => void;
  disabled: boolean;
  submitting: boolean;
}) {
  const buttons = block.buttons?.length
    ? block.buttons
    : [
        {
          id: block.id,
          label: block.label || "Submit",
          value: block.value ?? block.id ?? block.label ?? "submit",
          style: "primary" as const,
        },
      ];

  return (
    <div className="ic-actions">
      {buttons.map((btn, index) => (
        <button
          key={btn.id || `${String(btn.value ?? btn.label)}-${index}`}
          type="button"
          className={`ic-btn ic-btn-${btn.style || "default"}`}
          onClick={() => onAction(block, btn)}
          disabled={disabled || submitting}
        >
          {btn.label}
        </button>
      ))}
    </div>
  );
}
