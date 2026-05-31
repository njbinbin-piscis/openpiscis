import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { UiBlock } from "./protocol";
import { CUSTOM_OPTION_VALUE } from "./protocol";

type ChoiceMode = "radio" | "checkbox" | "select";

interface ChoiceFieldProps {
  block: UiBlock;
  mode: ChoiceMode;
  value: string | string[];
  onChange: (v: string | string[]) => void;
  disabled: boolean;
  error?: string;
}

export function ChoiceField({ block, mode, value, onChange, disabled, error }: ChoiceFieldProps) {
  const { t } = useTranslation();
  const allowCustom = !!block.allow_custom;
  const customLabel = block.custom_label || t("chat.interactiveOther", { defaultValue: "Other" });

  const stringValue = mode === "checkbox" ? "" : (value as string) ?? "";
  const arrayValue = mode === "checkbox" ? ((value as string[]) ?? []) : [];

  const usingCustom =
    mode === "checkbox"
      ? arrayValue.includes(CUSTOM_OPTION_VALUE)
      : stringValue === CUSTOM_OPTION_VALUE;

  const [customText, setCustomText] = useState("");

  const resolvedCustomText =
    mode === "checkbox"
      ? arrayValue.find((v) => v !== CUSTOM_OPTION_VALUE && !block.options?.some((o) => o.value === v)) ?? customText
      : stringValue !== CUSTOM_OPTION_VALUE && stringValue && !block.options?.some((o) => o.value === stringValue)
        ? stringValue
        : customText;

  const toggleCheckbox = (optValue: string) => {
    const next = arrayValue.includes(optValue)
      ? arrayValue.filter((x) => x !== optValue)
      : [...arrayValue, optValue];
    onChange(next);
  };

  const pickRadioOrSelect = (optValue: string) => {
    onChange(optValue);
  };

  const applyCustomText = (text: string) => {
    const trimmed = text.trim();
    if (mode === "checkbox") {
      const base = arrayValue.filter((v) => v !== CUSTOM_OPTION_VALUE && block.options?.some((o) => o.value === v));
      onChange(trimmed ? [...base, trimmed] : base);
    } else {
      onChange(trimmed || CUSTOM_OPTION_VALUE);
    }
  };

  const options = block.options ?? [];

  return (
    <div className={`ic-field${error ? " ic-field-error" : ""}`}>
      {block.label && <label className="ic-label">{block.label}</label>}
      {block.description && <p className="ic-field-hint">{block.description}</p>}

      {mode === "select" ? (
        <select
          className="ic-select"
          value={usingCustom ? CUSTOM_OPTION_VALUE : stringValue}
          onChange={(e) => {
            const v = e.target.value;
            if (v === CUSTOM_OPTION_VALUE) onChange(CUSTOM_OPTION_VALUE);
            else onChange(v);
          }}
          disabled={disabled}
        >
          <option value="">{block.placeholder || t("chat.interactiveSelectPlaceholder", { defaultValue: "— Select —" })}</option>
          {options.map((opt) => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
          {allowCustom && <option value={CUSTOM_OPTION_VALUE}>{customLabel}</option>}
        </select>
      ) : (
        <div className={mode === "radio" ? "ic-radio-group" : "ic-checkbox-group"}>
          {options.map((opt) => {
            const selected =
              mode === "radio" ? stringValue === opt.value : arrayValue.includes(opt.value);
            return (
              <label
                key={opt.value}
                className={`${mode === "radio" ? "ic-radio-item" : "ic-checkbox-item"}${selected ? " ic-selected" : ""}`}
              >
                <input
                  type={mode}
                  name={block.id}
                  checked={selected}
                  onChange={() =>
                    mode === "radio" ? pickRadioOrSelect(opt.value) : toggleCheckbox(opt.value)
                  }
                  disabled={disabled}
                />
                <span className={mode === "radio" ? "ic-radio-label" : "ic-checkbox-label"}>{opt.label}</span>
                {opt.description && (
                  <span className={mode === "radio" ? "ic-radio-desc" : "ic-checkbox-desc"}>{opt.description}</span>
                )}
              </label>
            );
          })}
          {allowCustom && (
            <label
              className={`${mode === "radio" ? "ic-radio-item" : "ic-checkbox-item"}${usingCustom ? " ic-selected" : ""}`}
            >
              <input
                type={mode}
                name={block.id}
                checked={usingCustom}
                onChange={() => {
                  if (mode === "radio") pickRadioOrSelect(CUSTOM_OPTION_VALUE);
                  else toggleCheckbox(CUSTOM_OPTION_VALUE);
                }}
                disabled={disabled}
              />
              <span className={`ic-${mode}-label`}>{customLabel}</span>
            </label>
          )}
        </div>
      )}

      {allowCustom && usingCustom && (
        <input
          type="text"
          className="ic-input ic-custom-input"
          value={resolvedCustomText}
          placeholder={t("chat.interactiveCustomPlaceholder", { defaultValue: "Type your answer…" })}
          onChange={(e) => {
            setCustomText(e.target.value);
            applyCustomText(e.target.value);
          }}
          disabled={disabled}
        />
      )}

      {error && <span className="ic-error">{error}</span>}
    </div>
  );
}
