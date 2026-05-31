import type { UiBlock } from "./protocol";
import { isValueBlock } from "./protocol";

function fieldMatches(
  fieldVal: unknown,
  equals?: string | number | boolean,
  one_of?: (string | number | boolean)[],
  not_equals?: string | number | boolean,
): boolean {
  if (not_equals !== undefined && fieldVal === not_equals) return false;
  if (equals !== undefined) {
    if (Array.isArray(fieldVal)) return fieldVal.includes(String(equals));
    return fieldVal === equals || String(fieldVal) === String(equals);
  }
  if (one_of !== undefined && one_of.length > 0) {
    if (Array.isArray(fieldVal)) {
      return fieldVal.some((v) => one_of.some((o) => String(o) === String(v)));
    }
    return one_of.some((o) => o === fieldVal || String(o) === String(fieldVal));
  }
  return true;
}

export function isBlockVisible(block: UiBlock, values: Record<string, unknown>): boolean {
  const sw = block.show_when;
  if (!sw?.field) return true;
  const fieldVal = values[sw.field];
  return fieldMatches(fieldVal, sw.equals, sw.one_of, sw.not_equals);
}

export function visibleValueBlocks(
  blocks: UiBlock[],
  values: Record<string, unknown>,
): UiBlock[] {
  return blocks.filter((b) => isBlockVisible(b, values) && isValueBlock(b));
}
