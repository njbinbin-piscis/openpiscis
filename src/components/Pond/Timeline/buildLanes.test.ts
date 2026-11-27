import { describe, it, expect } from "vitest";
import { buildTimelineLanes, parseTs, type LaneState } from "./buildLanes";
import type { KoiTimelineData, KoiTodo, TimelineEvent, TimelineMember } from "../../../services/tauri/pool";

// ─── fixtures ────────────────────────────────────────────────────────────────

const T0 = "2026-11-27T08:00:00+00:00"; // pool created / window start
const NOW = "2026-11-27T12:00:00+00:00";

function koi(id: string, name = id): TimelineMember["koi"] {
  return {
    id, name, role: "dev", icon: "🐟", color: "#22c55e",
    system_prompt: "", description: "", status: "idle",
    created_at: T0, updated_at: T0, max_iterations: 0, task_timeout_secs: 0,
  };
}

function member(id: string, joinedAt: string): TimelineMember {
  return { koi: koi(id), joined_at: joinedAt };
}

function todo(over: Partial<KoiTodo> & { id: string; owner_id: string }): KoiTodo {
  return {
    title: `task ${over.id}`, description: "", status: "todo", priority: "medium",
    assigned_by: "user", pool_session_id: "p1", source_type: "user",
    task_timeout_secs: 0, created_at: T0, updated_at: T0,
    ...over,
  };
}

function ev(id: number, sender: string, todoId: string, eventType: string, at: string): TimelineEvent {
  return { id, sender_id: sender, todo_id: todoId, event_type: eventType, msg_type: eventType, created_at: at };
}

function data(over: Partial<KoiTimelineData>): KoiTimelineData {
  return { pool_id: "p1", server_now: NOW, members: [], todos: [], events: [], ...over };
}

const ts = (s: string) => new Date(s).getTime();
const statesOf = (segs: { state: LaneState }[]) => segs.map((s) => s.state);

// ─── parseTs ─────────────────────────────────────────────────────────────────

describe("parseTs", () => {
  it("parses RFC3339 with and without zone", () => {
    expect(parseTs("2026-11-27T10:00:00+00:00")).toBe(ts("2026-11-27T10:00:00Z"));
    expect(parseTs("2026-11-27T10:00:00Z")).toBe(ts("2026-11-27T10:00:00Z"));
    expect(parseTs("2026-11-27T10:00:00")).toBe(ts("2026-11-27T10:00:00Z"));
  });
  it("parses SQLite datetime('now') shape as UTC", () => {
    expect(parseTs("2026-11-27 10:00:00")).toBe(ts("2026-11-27T10:00:00Z"));
  });
  it("returns null for garbage", () => {
    expect(parseTs("nope")).toBeNull();
    expect(parseTs(undefined)).toBeNull();
  });
});

// ─── buildTimelineLanes ──────────────────────────────────────────────────────

describe("buildTimelineLanes", () => {
  it("empty data yields no lanes", () => {
    const lanes = buildTimelineLanes(data({}), ts(NOW));
    expect(lanes).toEqual([]);
  });

  it("member with no work is idle from join to now, not_member before join", () => {
    const lanes = buildTimelineLanes(
      data({ members: [member("k1", "2026-11-27T10:00:00+00:00")] }),
      ts(NOW),
      ts(T0),
    );
    expect(lanes).toHaveLength(1);
    const segs = lanes[0].segments;
    expect(statesOf(segs)).toEqual(["not_member", "idle"]);
    expect(segs[0].end).toBe(ts("2026-11-27T10:00:00Z"));
    expect(segs[1].start).toBe(ts("2026-11-27T10:00:00Z"));
    expect(segs[1].end).toBe(ts(NOW));
  });

  it("completed todo produces a working segment bounded by claim and completion events", () => {
    const d = data({
      members: [member("k1", T0)],
      todos: [todo({ id: "t1", owner_id: "k1", status: "done", claimed_at: "2026-11-27T09:00:00+00:00", updated_at: "2026-11-27T09:30:00+00:00" })],
      events: [
        ev(1, "k1", "t1", "task_claimed", "2026-11-27T09:00:00+00:00"),
        ev(2, "k1", "t1", "task_completed", "2026-11-27T09:30:00+00:00"),
      ],
    });
    const segs = buildTimelineLanes(d, ts(NOW), ts(T0))[0].segments;
    const work = segs.filter((s) => s.state === "working");
    expect(work).toHaveLength(1);
    expect(work[0].start).toBe(ts("2026-11-27T09:00:00Z"));
    expect(work[0].end).toBe(ts("2026-11-27T09:30:00Z"));
    expect(work[0].todoId).toBe("t1");
    expect(work[0].anchorMessageId).toBe(1);
    expect(work[0].inferred).toBe(false);
    // idle fills the rest (join 08:00 → work 09:00 is idle)
    expect(statesOf(segs)).toEqual(["idle", "working", "idle"]);
  });

  it("completion time prefers task_completed event over polluted updated_at", () => {
    const d = data({
      members: [member("k1", T0)],
      todos: [todo({ id: "t1", owner_id: "k1", status: "done", claimed_at: "2026-11-27T09:00:00+00:00", updated_at: "2026-11-27T11:00:00+00:00" })],
      events: [
        ev(1, "k1", "t1", "task_claimed", "2026-11-27T09:00:00+00:00"),
        ev(2, "k1", "t1", "task_completed", "2026-11-27T09:30:00+00:00"),
      ],
    });
    const work = buildTimelineLanes(d, ts(NOW), ts(T0))[0].segments.find((s) => s.state === "working")!;
    expect(work.end).toBe(ts("2026-11-27T09:30:00Z"));
  });

  it("in-progress todo grows to now", () => {
    const d = data({
      members: [member("k1", T0)],
      todos: [todo({ id: "t1", owner_id: "k1", status: "in_progress", claimed_at: "2026-11-27T11:00:00+00:00", updated_at: "2026-11-27T11:00:00+00:00" })],
      events: [ev(1, "k1", "t1", "task_claimed", "2026-11-27T11:00:00+00:00")],
    });
    const segs = buildTimelineLanes(d, ts(NOW), ts(T0))[0].segments;
    const work = segs.find((s) => s.state === "working")!;
    expect(work.start).toBe(ts("2026-11-27T11:00:00Z"));
    expect(work.end).toBe(ts(NOW));
  });

  it("retry splits working segments: claimed → auto_retry gap → resumed → completed", () => {
    const d = data({
      members: [member("k1", T0)],
      todos: [todo({ id: "t1", owner_id: "k1", status: "done", claimed_at: "2026-11-27T10:00:00+00:00", updated_at: "2026-11-27T10:40:00+00:00" })],
      events: [
        ev(1, "k1", "t1", "task_claimed", "2026-11-27T09:00:00+00:00"),
        ev(2, "k1", "t1", "auto_retry", "2026-11-27T09:20:00+00:00"),
        ev(3, "k1", "t1", "task_resumed", "2026-11-27T10:00:00+00:00"),
        ev(4, "k1", "t1", "task_completed", "2026-11-27T10:40:00+00:00"),
      ],
    });
    const segs = buildTimelineLanes(d, ts(NOW), ts(T0))[0].segments;
    const work = segs.filter((s) => s.state === "working");
    expect(work).toHaveLength(2);
    expect(work[0].start).toBe(ts("2026-11-27T09:00:00Z"));
    expect(work[0].end).toBe(ts("2026-11-27T09:20:00Z"));
    expect(work[1].start).toBe(ts("2026-11-27T10:00:00Z"));
    expect(work[1].end).toBe(ts("2026-11-27T10:40:00Z"));
    // backoff gap is idle; leading idle from join 08:00 to first claim 09:00
    expect(statesOf(segs)).toEqual(["idle", "working", "idle", "working", "idle"]);
  });

  it("blocked / needs_review todo yields inferred waiting_user after work ends", () => {
    const d = data({
      members: [member("k1", T0)],
      todos: [todo({ id: "t1", owner_id: "k1", status: "blocked", claimed_at: "2026-11-27T09:00:00+00:00", updated_at: "2026-11-27T09:30:00+00:00", blocked_reason: "need user decision" })],
      events: [
        ev(1, "k1", "t1", "task_claimed", "2026-11-27T09:00:00+00:00"),
        ev(2, "k1", "t1", "task_blocked", "2026-11-27T09:30:00+00:00"),
      ],
    });
    const segs = buildTimelineLanes(d, ts(NOW), ts(T0))[0].segments;
    expect(statesOf(segs)).toEqual(["idle", "working", "waiting_user"]);
    const wait = segs[2];
    expect(wait.inferred).toBe(true);
    expect(wait.start).toBe(ts("2026-11-27T09:30:00Z"));
    expect(wait.end).toBe(ts(NOW));
    expect(wait.anchorMessageId).toBe(2);
  });

  it("pending todo with unfinished depends_on yields inferred waiting_peer", () => {
    const d = data({
      members: [member("k1", T0), member("k2", T0)],
      todos: [
        todo({ id: "up", owner_id: "k2", status: "in_progress", claimed_at: "2026-11-27T09:00:00+00:00", updated_at: "2026-11-27T09:00:00+00:00" }),
        todo({ id: "down", owner_id: "k1", status: "todo", depends_on: "up", created_at: "2026-11-27T09:00:00+00:00", updated_at: "2026-11-27T09:00:00+00:00" }),
      ],
      events: [ev(1, "k2", "up", "task_claimed", "2026-11-27T09:00:00+00:00")],
    });
    const lanes = buildTimelineLanes(d, ts(NOW), ts(T0));
    const k1 = lanes.find((l) => l.koi.id === "k1")!;
    const wait = k1.segments.find((s) => s.state === "waiting_peer")!;
    expect(wait.inferred).toBe(true);
    expect(wait.todoId).toBe("down");
    expect(wait.start).toBe(ts("2026-11-27T09:00:00Z"));
    expect(wait.end).toBe(ts(NOW));
  });

  it("waiting_peer ends when the upstream todo completes", () => {
    const d = data({
      members: [member("k1", T0), member("k2", T0)],
      todos: [
        todo({ id: "up", owner_id: "k2", status: "done", claimed_at: "2026-11-27T09:00:00+00:00", updated_at: "2026-11-27T09:30:00+00:00" }),
        todo({ id: "down", owner_id: "k1", status: "done", depends_on: "up", created_at: "2026-11-27T09:00:00+00:00", claimed_at: "2026-11-27T09:30:00+00:00", updated_at: "2026-11-27T10:00:00+00:00" }),
      ],
      events: [
        ev(1, "k2", "up", "task_claimed", "2026-11-27T09:00:00+00:00"),
        ev(2, "k2", "up", "task_completed", "2026-11-27T09:30:00+00:00"),
        ev(3, "k1", "down", "task_claimed", "2026-11-27T09:30:00+00:00"),
        ev(4, "k1", "down", "task_completed", "2026-11-27T10:00:00+00:00"),
      ],
    });
    const k1 = buildTimelineLanes(d, ts(NOW), ts(T0)).find((l) => l.koi.id === "k1")!;
    const wait = k1.segments.find((s) => s.state === "waiting_peer")!;
    expect(wait.start).toBe(ts("2026-11-27T09:00:00Z"));
    expect(wait.end).toBe(ts("2026-11-27T09:30:00Z"));
    expect(statesOf(k1.segments)).toEqual(["idle", "waiting_peer", "working", "idle"]);
  });

  it("todo without any events falls back to claimed_at → updated_at", () => {
    const d = data({
      members: [member("k1", T0)],
      todos: [todo({ id: "t1", owner_id: "k1", status: "done", claimed_at: "2026-11-27T09:00:00+00:00", updated_at: "2026-11-27T09:30:00+00:00" })],
      events: [],
    });
    const work = buildTimelineLanes(d, ts(NOW), ts(T0))[0].segments.find((s) => s.state === "working")!;
    expect(work.start).toBe(ts("2026-11-27T09:00:00Z"));
    expect(work.end).toBe(ts("2026-11-27T09:30:00Z"));
    expect(work.anchorMessageId).toBeUndefined();
  });

  it("mixed timestamp formats are normalised before ordering", () => {
    const d = data({
      members: [member("k1", "2026-11-27 08:00:00")],
      todos: [todo({ id: "t1", owner_id: "k1", status: "done", claimed_at: "2026-11-27 09:00:00", updated_at: "2026-11-27 09:30:00" })],
      events: [
        ev(1, "k1", "t1", "task_claimed", "2026-11-27 09:00:00"),
        ev(2, "k1", "t1", "task_completed", "2026-11-27T09:30:00+00:00"),
      ],
    });
    const segs = buildTimelineLanes(d, ts(NOW), ts(T0))[0].segments;
    expect(statesOf(segs)).toEqual(["idle", "working", "idle"]);
    expect(segs[1].start).toBe(ts("2026-11-27T09:00:00Z"));
    expect(segs[1].end).toBe(ts("2026-11-27T09:30:00Z"));
  });

  it("overlapping todos on one koi do not double-count working time", () => {
    const d = data({
      members: [member("k1", T0)],
      todos: [
        todo({ id: "a", owner_id: "k1", status: "done", claimed_at: "2026-11-27T09:00:00+00:00", updated_at: "2026-11-27T10:00:00+00:00" }),
        todo({ id: "b", owner_id: "k1", status: "done", claimed_at: "2026-11-27T09:30:00+00:00", updated_at: "2026-11-27T10:30:00+00:00" }),
      ],
      events: [],
    });
    const segs = buildTimelineLanes(d, ts(NOW), ts(T0))[0].segments;
    const work = segs.filter((s) => s.state === "working");
    // merged union 09:00–10:30, no overlap
    expect(work).toHaveLength(1);
    expect(work[0].start).toBe(ts("2026-11-27T09:00:00Z"));
    expect(work[0].end).toBe(ts("2026-11-27T10:30:00Z"));
  });

  it("segments are contiguous, sorted, and clipped to [windowStart, now]", () => {
    const d = data({
      members: [member("k1", "2026-11-27T07:00:00+00:00")], // joined before window
      todos: [todo({ id: "t1", owner_id: "k1", status: "in_progress", claimed_at: "2026-11-27T11:00:00+00:00", updated_at: "2026-11-27T11:00:00+00:00" })],
      events: [ev(1, "k1", "t1", "task_claimed", "2026-11-27T11:00:00+00:00")],
    });
    const segs = buildTimelineLanes(d, ts(NOW), ts(T0))[0].segments;
    expect(segs[0].start).toBe(ts(T0)); // clipped, no not_member inside window
    for (let i = 1; i < segs.length; i++) {
      expect(segs[i].start).toBe(segs[i - 1].end);
    }
    expect(segs[segs.length - 1].end).toBe(ts(NOW));
  });
});