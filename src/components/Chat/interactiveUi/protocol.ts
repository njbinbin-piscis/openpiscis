/** Chat UI Protocol v1 — shared types (see docs/chat-ui-protocol.md). */

export const CHAT_UI_PROTOCOL_VERSION = "1";

export const CUSTOM_OPTION_VALUE = "__custom__";

export type UiButtonStyle = "primary" | "danger" | "default";

export interface UiOption {
  value: string;
  label: string;
  description?: string;
}

export interface UiButton {
  id?: string;
  label: string;
  value?: unknown;
  style?: UiButtonStyle;
}

export interface ShowWhen {
  field: string;
  equals?: string | number | boolean;
  one_of?: (string | number | boolean)[];
  not_equals?: string | number | boolean;
}

export type UiBlockType =
  | "text"
  | "divider"
  | "section"
  | "text_input"
  | "number_input"
  | "slider"
  | "switch"
  | "date"
  | "time"
  | "datetime"
  | "select"
  | "radio"
  | "checkbox"
  | "tags"
  | "koi_picker"
  | "project_picker"
  | "confirm"
  | "actions";

export interface UiBlock {
  type: UiBlockType | string;
  id?: string;
  label?: string;
  description?: string;
  content?: string;
  value?: unknown;
  options?: UiOption[];
  default?: unknown;
  placeholder?: string;
  show_when?: ShowWhen;
  suggestions?: string[];
  allow_new?: boolean;
  allow_custom?: boolean;
  custom_label?: string;
  required?: boolean;
  disabled?: boolean;
  min?: number | string;
  max?: number | string;
  step?: number;
  min_length?: number;
  max_length?: number;
  pattern?: string;
  multiline?: boolean;
  rows?: number;
  input_mode?: "text" | "email" | "url" | "password";
  buttons?: UiButton[];
}

export interface UiDefinition {
  protocol_version?: string;
  title?: string;
  description?: string;
  submit_label?: string;
  blocks: UiBlock[];
}

export const VALUE_BLOCK_TYPES = new Set<string>([
  "text_input",
  "number_input",
  "slider",
  "switch",
  "date",
  "time",
  "datetime",
  "select",
  "radio",
  "checkbox",
  "tags",
  "koi_picker",
  "project_picker",
]);

export const ACTION_BLOCK_TYPES = new Set<string>(["actions", "confirm"]);

export function isValueBlock(block: UiBlock): boolean {
  return !!block.id && VALUE_BLOCK_TYPES.has(block.type);
}

export function isActionBlock(block: UiBlock): boolean {
  return ACTION_BLOCK_TYPES.has(block.type);
}
