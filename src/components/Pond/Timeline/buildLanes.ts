/**
 * Rebuild per-Koi state segments ("lanes") for the timeline view from the
 * raw material returned by `get_koi_timeline`.
 *
 * Pure function — no IPC, no clock reads (caller passes `now`), so every
 * boundary case is unit-testable. All timestamps are epoch milliseconds.
 *
 * State model (five states, matching the design mock):
 *   working      — todo claimed and running (exact: claim → terminal event)
 *   waiting_user — todo blocked / needs_review (heuristic, inferred=true)
 *   waiting_peer — todo pending with an unfinished depends_on (inferred=true)
 *   idle         — member of the pool but none of the above
 *   not_member   — before pool_members.joined_at
 */
import type {
  KoiDefinition, KoiTimelineData, KoiTodo, TimelineEvent,
} from "../../../services/tauri/pool";

export type LaneState = "working" | "waiting_user" | "waiting_peer" | "idle" | "not_member";

export interface Segment {
  state: LaneState;
  start: number;
  end: number;
  todoId?: string;
  title?: string;
  /** pool_messages row id to jump to in chat (segment's opening event). */
  anchorMessageId?: number;
  /** True when the state is a heuristic guess rather than recorded data. */
  inferred: boolean;
}

export interface Lane {
  koi: KoiDefinition;
  joinedAt: number;
  segments: Segment[];
}

/** Lenient timestamp parse: RFC3339 (with/without zone) and SQLite
 *  `datetime('now')` shapes, all treated as UTC when no zone is present. */
export function parseTs(s: string | undefined | null): number | null {
  if (!s) return null;
  let iso = s.trim();
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(iso)) {
    iso = iso.replace(" ", "T") + "Z";
  } else if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?$/.test(iso)) {
    iso += "Z";
  }
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

const TERMINAL_EVENTS = new Set([
  "task_completed", "task_failed", "task_blocked", "task_cancelled", "auto_retry",
]);
const START_EVENTS = new Set(["task_claimed", "task_resumed"]);

interface Interval {
  state: LaneState;
  start: number;
  end: number;
  todoId?: string;
  title?: string;
  anchorMessageId?: number;
  inferred: boolean;
  /** Higher wins when intervals overlap. */
  priority: number;
}

const STATE_PRIORITY: Record<LaneState, number> = {
  working: 4, waiting_user: 3, waiting_peer: 2, idle: 1, not_member: 0,
};

/** Split a todo's lifecycle into working intervals using its event stream.
 *  Falls back to claimed_at → updated_at when events are missing. */
function workingIntervals(todo: KoiTodo, events: TimelineEvent[], now: number): Interval[] {
  const evs = events
    .filter((e) => e.todo_id === todo.id && e.event_type)
    .map((e) => ({ ...e, t: parseTs(e.created_at) }))
    .filter((e): e is TimelineEvent & { t: number } => e.t !== null)
    .sort((a, b) => a.t - b.t);

  const out: Interval[] = [];
  let open: { start: number; anchor?: number } | null = null;

  const close = (end: number) => {
    if (open && end > open.start) {
      out.push({
        state: "working", start: open.start, end,
        todoId: todo.id, title: todo.title, anchorMessageId: open.anchor,
        inferred: false, priority: STATE_PRIORITY.working,
      });
    }
    open = null;
  };

  for (const e of evs) {
    if (START_EVENTS.has(e.event_type!)) {
      close(e.t); // defensive: a new start closes any dangling interval
      open = { start: e.t, anchor: e.id };
    } else if (TERMINAL_EVENTS.has(e.event_type!)) {
      close(e.t);
    }
    // task_progress / status_update etc. keep the interval open.
  }

  if (open) {
    // Still running (in_progress) → grow to now; otherwise the todo's last
    // update is the best available end bound.
    const end = todo.status === "in_progress" ? now : Math.max(open.start, parseTs(todo.updated_at) ?? now);
    close(Math.min(end, now));
  }

  if (out.length === 0) {
    // No usable events: degrade to the todo row's own timestamps.
    const start = parseTs(todo.claimed_at);
    if (start !== null) {
      const end = todo.status === "in_progress"
        ? now
        : Math.min(parseTs(todo.updated_at) ?? now, now);
      if (end > start) {
        out.push({
          state: "working", start, end,
          todoId: todo.id, title: todo.title,
          inferred: false, priority: STATE_PRIORITY.working,
        });
      }
    }
  }
  return out;
}

/** Heuristic waiting intervals derived from the todo's *current* status.
 *  These are guesses (no historical status log exists) → inferred=true. */
function waitingIntervals(
  todo: KoiTodo,
  allTodos: KoiTodo[],
  events: TimelineEvent[],
  workEnd: number | null,
  now: number,
): Interval[] {
  const todoEvents = events.filter((e) => e.todo_id === todo.id);
  const out: Interval[] = [];

  // A todo that ever ran (claim recorded or claim/resume event present)
  // also waited on its dependency between creation and first claim.
  const claimed = parseTs(todo.claimed_at);
  const firstStartEv = events
    .filter((e) => e.todo_id === todo.id && e.event_type && START_EVENTS.has(e.event_type))
    .map((e) => parseTs(e.created_at))
    .filter((t): t is number => t !== null)
    .sort((a, b) => a - b)[0];
  const runStart = claimed ?? firstStartEv ?? null;

  if (todo.depends_on && runStart !== null) {
    const created = parseTs(todo.created_at);
    if (created !== null && runStart > created) {
      out.push({
        state: "waiting_peer", start: created, end: Math.min(runStart, now),
        todoId: todo.id, title: todo.title,
        inferred: true, priority: STATE_PRIORITY.waiting_peer,
      });
    }
  }

  if (todo.status === "blocked" || todo.status === "needs_review") {
    const blockEv = todoEvents
      .filter((e) => e.event_type === "task_blocked" || e.event_type === "task_status_changed")
      .map((e) => ({ e, t: parseTs(e.created_at) }))
      .filter((x): x is { e: TimelineEvent; t: number } => x.t !== null)
      .sort((a, b) => b.t - a.t)[0];
    const start = blockEv?.t ?? workEnd ?? parseTs(todo.updated_at) ?? parseTs(todo.created_at);
    if (start !== null && now > start) {
      out.push({
        state: "waiting_user", start, end: now,
        todoId: todo.id, title: todo.title,
        anchorMessageId: blockEv?.e.id,
        inferred: true, priority: STATE_PRIORITY.waiting_user,
      });
    }
    return out;
  }

  if (todo.status === "todo" && todo.depends_on) {
    const upstream = allTodos.find((t) => t.id === todo.depends_on);
    const created = parseTs(todo.created_at);
    if (created === null) return out;
    if (upstream && upstream.status !== "done" && upstream.status !== "cancelled") {
      // Dependency still unfinished → waiting from creation until now.
      if (now > created) {
        out.push({
          state: "waiting_peer", start: created, end: now,
          todoId: todo.id, title: todo.title,
          inferred: true, priority: STATE_PRIORITY.waiting_peer,
        });
      }
    } else if (upstream) {
      // Dependency satisfied later: waiting ended when upstream finished.
      const upDoneEvents = events
        .filter((e) => e.todo_id === upstream.id && e.event_type === "task_completed")
        .map((e) => parseTs(e.created_at))
        .filter((t): t is number => t !== null);
      const upDone = upDoneEvents.length
        ? Math.max(...upDoneEvents)
        : parseTs(upstream.updated_at);
      const claimed2 = parseTs(todo.claimed_at);
      const end = Math.min(claimed2 ?? upDone ?? now, upDone ?? now, now);
      if (end > created) {
        out.push({
          state: "waiting_peer", start: created, end,
          todoId: todo.id, title: todo.title,
          inferred: true, priority: STATE_PRIORITY.waiting_peer,
        });
      }
    }
  }
  return out;
}

/** Merge overlapping intervals of the same state; higher-priority states
 *  win overlaps. Returns sorted, non-overlapping intervals. */
function resolveOverlaps(intervals: Interval[]): Interval[] {
  const sorted = [...intervals].sort(
    (a, b) => a.start - b.start || b.priority - a.priority,
  );
  const out: Interval[] = [];
  for (const iv of sorted) {
    const last = out[out.length - 1];
    if (!last || iv.start >= last.end) {
      out.push({ ...iv });
      continue;
    }
    if (iv.priority > last.priority) {
      // Higher priority splits/truncates the previous interval.
      if (iv.start > last.start) {
        const tail = { ...last, end: iv.start };
        out[out.length - 1] = tail;
        out.push({ ...iv });
      } else {
        out[out.length - 1] = { ...iv };
      }
      // Re-check: the new interval may also cover earlier ones — rare, skip.
    } else if (iv.end > last.end) {
      // Same/lower priority extends only the uncovered tail.
      out.push({ ...iv, start: last.end });
    }
    // fully covered lower-priority interval: dropped
  }
  // Merge adjacent same-state intervals (e.g. overlapping working union
  // across two todos). Keep the earlier segment's todo/anchor metadata.
  const merged: Interval[] = [];
  for (const iv of out) {
    const last = merged[merged.length - 1];
    if (
      last && last.state === iv.state && last.end === iv.start &&
      last.inferred === iv.inferred
    ) {
      last.end = iv.end;
    } else {
      merged.push(iv);
    }
  }
  return merged;
}

/**
 * Build one lane per pool member. `windowStart` clips the left edge
 * (usually pool creation time); `now` is the right edge.
 */
export function buildTimelineLanes(
  data: KoiTimelineData,
  now: number,
  windowStart?: number,
): Lane[] {
  const lanes: Lane[] = [];
  const fallbackStart = windowStart ?? Math.min(
    ...data.members.map((m) => parseTs(m.joined_at) ?? now),
    now,
  );

  for (const member of data.members) {
    const joinedAt = parseTs(member.joined_at) ?? fallbackStart;
    const left = Math.max(windowStart ?? joinedAt, Math.min(joinedAt, now));
    const myTodos = data.todos.filter((t) => t.owner_id === member.koi.id);

    const intervals: Interval[] = [];
    for (const todo of myTodos) {
      const work = workingIntervals(todo, data.events, now);
      intervals.push(...work);
      const workEnd = work.length ? Math.max(...work.map((w) => w.end)) : null;
      intervals.push(...waitingIntervals(todo, data.todos, data.events, workEnd, now));
    }

    const resolved = resolveOverlaps(
      intervals
        .map((iv) => ({ ...iv, start: Math.max(iv.start, left), end: Math.min(iv.end, now) }))
        .filter((iv) => iv.end > iv.start),
    );

    // Fill gaps: not_member before join, idle elsewhere.
    const segments: Segment[] = [];
    let cursor = windowStart ?? left;
    const push = (state: LaneState, start: number, end: number, extra?: Partial<Segment>) => {
      if (end > start) {
        segments.push({ state, start, end, inferred: state === "waiting_user" || state === "waiting_peer", ...extra });
      }
    };
    if (joinedAt > cursor) {
      push("not_member", cursor, Math.min(joinedAt, now));
      cursor = Math.min(joinedAt, now);
    }
    for (const iv of resolved) {
      push("idle", cursor, iv.start);
      segments.push({
        state: iv.state, start: iv.start, end: iv.end,
        todoId: iv.todoId, title: iv.title, anchorMessageId: iv.anchorMessageId,
        inferred: iv.inferred,
      });
      cursor = iv.end;
    }
    push("idle", cursor, now);

    lanes.push({ koi: member.koi, joinedAt, segments });
  }
  return lanes;
}