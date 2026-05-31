import type { UiBlock, UiDefinition } from "./protocol";
import { CUSTOM_OPTION_VALUE } from "./protocol";

function defaultForBlock(block: UiBlock): unknown | undefined {
  if (block.default !== undefined) return block.default;
  switch (block.type) {
    case "checkbox":
    case "tags":
    case "koi_picker":
      return block.suggestions ? [...block.suggestions] : [];
    case "switch":
      return false;
    case "number_input":
    case "slider":
      if (typeof block.min === "number") return block.min;
      return 0;
    default:
      return undefined;
  }
}

/** Resolve initial form state from definition (not submitted snapshot). */
export function buildInitialValues(blocks: UiBlock[]): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const block of blocks) {
    if (!block.id) continue;
    const d = defaultForBlock(block);
    if (d !== undefined) values[block.id] = d;
  }
  return values;
}

/** When loading submitted snapshot, normalize custom-option sentinel to stored string. */
export function normalizeSubmittedValues(
  def: UiDefinition,
  submitted: Record<string, unknown>,
): Record<string, unknown> {
  const out = { ...submitted };
  for (const block of def.blocks) {
    if (!block.id || !block.allow_custom) continue;
    const v = out[block.id];
    if (v === CUSTOM_OPTION_VALUE) out[block.id] = "";
  }
  return out;
}
