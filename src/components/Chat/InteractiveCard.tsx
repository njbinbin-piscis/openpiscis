import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { interactiveApi } from "../../services/tauri";
import {
  ActionsBlock,
  DateTimeBlock,
  KoiPickerBlock,
  NumberInputBlock,
  ProjectPickerBlock,
  SectionBlock,
  SwitchBlock,
  TagsBlock,
  TextBlock,
  TextInputBlock,
} from "./interactiveUi/Blocks";
import { ChoiceField } from "./interactiveUi/ChoiceField";
import { buildInitialValues, normalizeSubmittedValues } from "./interactiveUi/initValues";
import {
  ACTION_BLOCK_TYPES,
  CHAT_UI_PROTOCOL_VERSION,
  type UiBlock,
  type UiButton,
  type UiDefinition,
  VALUE_BLOCK_TYPES,
} from "./interactiveUi/protocol";
import { validateInteractiveForm, type FieldErrors } from "./interactiveUi/validate";
import { isBlockVisible } from "./interactiveUi/visibility";
import "./InteractiveCard.css";

interface InteractiveCardProps {
  requestId: string;
  uiDefinition: UiDefinition;
  submittedValues?: Record<string, unknown> | null;
  onSubmitted?: () => void;
}

function buildSubmitPayload(
  requestId: string,
  values: Record<string, unknown>,
  block: UiBlock,
  button: UiButton,
): Record<string, unknown> {
  const actionValue = button.value ?? button.id ?? button.label;
  return {
    ...values,
    __action__: actionValue,
    __button__: { id: button.id, label: button.label, value: actionValue },
    __meta__: {
      protocol_version: CHAT_UI_PROTOCOL_VERSION,
      request_id: requestId,
      submitted_at: new Date().toISOString(),
    },
    ...(block.id ? { [block.id]: actionValue } : {}),
  };
}

export default function InteractiveCard({
  requestId,
  uiDefinition,
  submittedValues,
  onSubmitted,
}: InteractiveCardProps) {
  const { t } = useTranslation();
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [errors, setErrors] = useState<FieldErrors>({});
  const [submitted, setSubmitted] = useState(!!submittedValues);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  useEffect(() => {
    if (submittedValues) {
      setValues(normalizeSubmittedValues(uiDefinition, submittedValues));
      return;
    }
    setValues(buildInitialValues(uiDefinition.blocks));
    setErrors({});
  }, [uiDefinition, submittedValues]);

  const updateValue = (id: string, val: unknown) => {
    setValues((prev) => {
      const next = { ...prev, [id]: val };
      setErrors(validateInteractiveForm(uiDefinition.blocks, next, t));
      return next;
    });
  };

  const handleAction = async (block: UiBlock, button: UiButton) => {
    if (submitted || submitting) return;
    const nextErrors = validateInteractiveForm(uiDefinition.blocks, values, t);
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) {
      setSubmitError(t("chat.interactiveFixErrors", { defaultValue: "Fix the highlighted fields before continuing." }));
      return;
    }
    setSubmitError(null);
    setSubmitting(true);
    try {
      const payload = buildSubmitPayload(requestId, values, block, button);
      await interactiveApi.respond(requestId, payload);
      setSubmitted(true);
      onSubmitted?.();
    } catch (e) {
      console.error("[InteractiveCard] respond error:", e);
      setSubmitError(
        String(e).includes("not found")
          ? t("chat.interactiveExpired", { defaultValue: "This form has expired. Send a new message to continue." })
          : t("chat.interactiveSubmitFailed", { defaultValue: "Submit failed. Try again." }),
      );
    } finally {
      setSubmitting(false);
    }
  };

  const disabled = submitted || submitting;

  const hasActionBlock = uiDefinition.blocks.some((b) => ACTION_BLOCK_TYPES.has(b.type));
  const hasInputBlock = uiDefinition.blocks.some((b) => b.id && VALUE_BLOCK_TYPES.has(b.type));
  const showDefaultSubmit = !submitted && !hasActionBlock && hasInputBlock;

  const defaultSubmitBlock: UiBlock = useMemo(
    () => ({
      type: "actions",
      id: "__submit__",
      buttons: [
        {
          id: "submit",
          label: uiDefinition.submit_label || t("chat.interactiveSubmit", { defaultValue: "Submit" }),
          value: "submit",
          style: "primary",
        },
      ],
    }),
    [uiDefinition.submit_label, t],
  );

  const renderBlock = (block: UiBlock, index: number) => {
    if (!isBlockVisible(block, values)) return null;
    const key = block.id || `block-${index}`;
    const fieldError = block.id ? errors[block.id] : undefined;

    switch (block.type) {
      case "text":
        return <TextBlock key={key} block={block} />;
      case "section":
        return <SectionBlock key={key} block={block} />;
      case "divider":
        return <hr key={key} className="ic-divider" />;
      case "radio":
        return (
          <ChoiceField
            key={key}
            block={block}
            mode="radio"
            value={(values[block.id!] as string) ?? ""}
            onChange={(v) => updateValue(block.id!, v)}
            disabled={disabled || !!block.disabled}
            error={fieldError}
          />
        );
      case "checkbox":
        return (
          <ChoiceField
            key={key}
            block={block}
            mode="checkbox"
            value={(values[block.id!] as string[]) ?? []}
            onChange={(v) => updateValue(block.id!, v)}
            disabled={disabled || !!block.disabled}
            error={fieldError}
          />
        );
      case "select":
        return (
          <ChoiceField
            key={key}
            block={block}
            mode="select"
            value={(values[block.id!] as string) ?? ""}
            onChange={(v) => updateValue(block.id!, v)}
            disabled={disabled || !!block.disabled}
            error={fieldError}
          />
        );
      case "text_input":
        return (
          <TextInputBlock
            key={key}
            block={block}
            value={(values[block.id!] as string) ?? ""}
            onChange={(v) => updateValue(block.id!, v)}
            disabled={disabled || !!block.disabled}
            error={fieldError}
          />
        );
      case "number_input":
        return (
          <NumberInputBlock
            key={key}
            block={block}
            value={Number(values[block.id!]) || 0}
            onChange={(v) => updateValue(block.id!, v)}
            disabled={disabled || !!block.disabled}
            error={fieldError}
          />
        );
      case "slider":
        return (
          <NumberInputBlock
            key={key}
            block={block}
            value={Number(values[block.id!]) || 0}
            onChange={(v) => updateValue(block.id!, v)}
            disabled={disabled || !!block.disabled}
            error={fieldError}
            asSlider
          />
        );
      case "switch":
        return (
          <SwitchBlock
            key={key}
            block={block}
            value={!!values[block.id!]}
            onChange={(v) => updateValue(block.id!, v)}
            disabled={disabled || !!block.disabled}
          />
        );
      case "date":
      case "time":
      case "datetime":
        return (
          <DateTimeBlock
            key={key}
            block={block}
            value={(values[block.id!] as string) ?? ""}
            onChange={(v) => updateValue(block.id!, v)}
            disabled={disabled || !!block.disabled}
            error={fieldError}
          />
        );
      case "tags":
        return (
          <TagsBlock
            key={key}
            block={block}
            value={(values[block.id!] as string[]) ?? []}
            onChange={(v) => updateValue(block.id!, v)}
            disabled={disabled || !!block.disabled}
            error={fieldError}
          />
        );
      case "koi_picker":
        return (
          <KoiPickerBlock
            key={key}
            block={block}
            value={(values[block.id!] as string[]) ?? []}
            onChange={(v) => updateValue(block.id!, v)}
            disabled={disabled || !!block.disabled}
            error={fieldError}
          />
        );
      case "project_picker":
        return (
          <ProjectPickerBlock
            key={key}
            block={block}
            value={(values[block.id!] as string) ?? ""}
            onChange={(v) => updateValue(block.id!, v)}
            disabled={disabled || !!block.disabled}
            error={fieldError}
          />
        );
      case "confirm":
      case "actions":
        return (
          <ActionsBlock
            key={key}
            block={block}
            onAction={handleAction}
            disabled={disabled}
            submitting={submitting}
          />
        );
      default:
        return null;
    }
  };

  return (
    <div className={`interactive-card${submitted ? " ic-submitted" : ""}`}>
      {uiDefinition.title && <div className="ic-title">{uiDefinition.title}</div>}
      {uiDefinition.description && <p className="ic-description">{uiDefinition.description}</p>}

      <div className="ic-blocks">
        {uiDefinition.blocks.map(renderBlock)}
        {showDefaultSubmit && (
          <ActionsBlock
            key="__default_submit__"
            block={defaultSubmitBlock}
            onAction={handleAction}
            disabled={disabled}
            submitting={submitting}
          />
        )}
      </div>

      {submitError && !submitted && <div className="ic-form-error">{submitError}</div>}
      {submitted && (
        <div className="ic-submitted-badge">{t("chat.interactiveSubmitted", { defaultValue: "Submitted" })}</div>
      )}
    </div>
  );
}
