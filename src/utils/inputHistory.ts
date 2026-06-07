/** Per-scope arrow-key input history (main chat / pool collab / IDE CLI). */

export interface InputHistoryNavState {
  items: string[];
  index: number;
  draft: string;
}

const stores = new Map<string, InputHistoryNavState>();

const DEFAULT_MAX = 100;

function getStore(scope: string): InputHistoryNavState {
  let store = stores.get(scope);
  if (!store) {
    store = { items: [], index: -1, draft: "" };
    stores.set(scope, store);
  }
  return store;
}

export function pushInputHistory(scope: string, text: string, maxItems = DEFAULT_MAX): void {
  const trimmed = text.trim();
  if (!trimmed) return;
  const store = getStore(scope);
  if (store.items[store.items.length - 1] === trimmed) return;
  store.items.push(trimmed);
  if (store.items.length > maxItems) {
    store.items.splice(0, store.items.length - maxItems);
  }
  store.index = -1;
  store.draft = "";
}

/** Seed history from persisted messages when local store is still empty. */
export function seedInputHistory(scope: string, texts: string[], maxItems = DEFAULT_MAX): void {
  const store = getStore(scope);
  if (store.items.length > 0) return;
  const items: string[] = [];
  for (const raw of texts) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    if (items[items.length - 1] === trimmed) continue;
    items.push(trimmed);
  }
  if (items.length > maxItems) {
    store.items = items.slice(-maxItems);
  } else {
    store.items = items;
  }
}

export function resetInputHistoryNav(scope: string): void {
  const store = getStore(scope);
  store.index = -1;
  store.draft = "";
}

function moveCursorToEnd(ta: HTMLTextAreaElement): void {
  requestAnimationFrame(() => {
    ta.selectionStart = ta.selectionEnd = ta.value.length;
  });
}

function isAtLineStart(value: string, pos: number): boolean {
  return pos === 0 || value[pos - 1] === "\n";
}

function isOnFirstLine(value: string, pos: number): boolean {
  return !value.slice(0, pos).includes("\n");
}

/** Returns true when the key event was consumed. */
export function handleInputHistoryKeyDown(
  e: React.KeyboardEvent<HTMLTextAreaElement>,
  scope: string,
  setValue: (value: string) => void,
): boolean {
  const store = getStore(scope);
  const ta = e.currentTarget;

  if (e.key === "Escape" && store.index >= 0) {
    e.preventDefault();
    store.index = -1;
    setValue(store.draft);
    store.draft = "";
    return true;
  }

  if (e.key !== "ArrowUp" && e.key !== "ArrowDown") {
    if (
      store.index >= 0 &&
      e.key.length === 1 &&
      !e.ctrlKey &&
      !e.metaKey &&
      !e.altKey
    ) {
      store.index = -1;
      store.draft = "";
    }
    return false;
  }

  const { items } = store;
  const value = ta.value;
  const pos = ta.selectionStart ?? 0;
  const end = ta.selectionEnd ?? pos;
  if (pos !== end) return false;

  if (e.key === "ArrowUp") {
    if (items.length === 0) return false;
    if (store.index < 0 && !(isOnFirstLine(value, pos) && isAtLineStart(value, pos))) {
      return false;
    }
    e.preventDefault();
    if (store.index < 0) {
      store.draft = value;
      store.index = items.length - 1;
      setValue(items[store.index] ?? "");
    } else if (store.index > 0) {
      store.index -= 1;
      setValue(items[store.index] ?? "");
    }
    moveCursorToEnd(ta);
    return true;
  }

  // ArrowDown — only while navigating history
  if (store.index < 0) return false;
  e.preventDefault();
  if (store.index < items.length - 1) {
    store.index += 1;
    setValue(items[store.index] ?? "");
  } else {
    store.index = -1;
    setValue(store.draft);
    store.draft = "";
  }
  moveCursorToEnd(ta);
  return true;
}
