/**
 * KoiTimeline — video-editor-style timeline of Koi work in one pool.
 *
 * One lane per pool member; coloured segments show working / waiting-user /
 * waiting-peer / idle / not-member intervals rebuilt by `buildLanes`.
 * Supports wheel zoom, drag pan, a full-range minimap, a live "now" line,
 * and click-to-jump into the chat transcript.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { listen } from "@tauri-apps/api/event";
import { timelineApi, type KoiTimelineData } from "../../../services/tauri/pool";
import { buildTimelineLanes, parseTs, type Lane, type LaneState, type Segment } from "./buildLanes";
import "./Timeline.css";

const STATE_COLORS: Record<LaneState, string> = {
  working: "#22c55e",
  waiting_user: "#f59e0b",
  waiting_peer: "#3b82f6",
  idle: "#4b5563",
  not_member: "#374151",
};

const MIN_VIEW_MS = 30_000;          // 30 s at max zoom
const DEFAULT_VIEW_MS = 3_600_000;   // 1 h initial window

interface Props {
  poolId: string | null;
  onJumpToMessage?: (messageId: number) => void;
  /** Open the Koi Observer focused on this todo's task session
   *  (`koi_task_{koiId}_{todoId前8位}`) — the Koi's iteration transcript. */
  onOpenTask?: (koiId: string, todoId: string) => void;
}

function fmtClock(t: number): string {
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${s % 60 ? ` ${s % 60}s` : ""}`;
  const h = Math.floor(m / 60);
  return `${h}h${m % 60 ? ` ${m % 60}m` : ""}`;
}

/** Choose a tick step that yields ~6-10 labels for the visible span. */
function tickStep(viewMs: number): number {
  const steps = [
    10_000, 30_000, 60_000, 5 * 60_000, 15 * 60_000, 30 * 60_000,
    3_600_000, 3 * 3_600_000, 6 * 3_600_000, 12 * 3_600_000, 24 * 3_600_000,
  ];
  const target = viewMs / 8;
  return steps.find((s) => s >= target) ?? steps[steps.length - 1];
}

export default function KoiTimeline({ poolId, onJumpToMessage, onOpenTask }: Props) {
  const { t } = useTranslation();
  const [data, setData] = useState<KoiTimelineData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  // Visible window: [viewEnd - viewMs, viewEnd]. viewEnd=null → follow now.
  const [viewMs, setViewMs] = useState(DEFAULT_VIEW_MS);
  const [viewEnd, setViewEnd] = useState<number | null>(null);
  const [trackW, setTrackW] = useState(800);
  const [tooltip, setTooltip] = useState<{ seg: Segment; x: number; y: number } | null>(null);

  const trackRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ startX: number; startEnd: number } | null>(null);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Minimap frame drag: move the whole window, or resize from an edge.
  const miniDragRef = useRef<{
    mode: "move" | "left" | "right";
    startX: number;
    startViewStart: number;
    startViewMs: number;
    miniW: number;
  } | null>(null);

  // ── data loading ──────────────────────────────────────────────────
  const load = useCallback(async () => {
    if (!poolId) return;
    setLoading(true);
    try {
      const d = await timelineApi.get(poolId);
      setData(d);
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [poolId]);

  useEffect(() => { setData(null); setViewEnd(null); load(); }, [load]);

  // Debounced refresh on any pool activity (same pattern as Board).
  useEffect(() => {
    if (!poolId) return;
    const unsubs: Array<() => void> = [];
    const schedule = () => {
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
      refreshTimer.current = setTimeout(load, 500);
    };
    listen("koi_todo_updated", schedule).then((fn) => unsubs.push(fn));
    listen("koi_status_changed", schedule).then((fn) => unsubs.push(fn));
    listen(`pool_message_${poolId}`, schedule).then((fn) => unsubs.push(fn));
    return () => {
      unsubs.forEach((fn) => fn());
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
    };
  }, [poolId, load]);

  // 1 s ticker: advance "now" so in-progress segments grow.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  // Track width measurement.
  useEffect(() => {
    const el = trackRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setTrackW(el.clientWidth));
    ro.observe(el);
    setTrackW(el.clientWidth);
    return () => ro.disconnect();
  }, [data]);

  // ── derived geometry ──────────────────────────────────────────────
  const fullStart = useMemo(() => {
    if (!data) return now - DEFAULT_VIEW_MS;
    const joins = data.members.map((m) => parseTs(m.joined_at) ?? now);
    const created = data.todos.map((td) => parseTs(td.created_at) ?? now);
    const all = [...joins, ...created];
    return all.length ? Math.min(...all) : now - DEFAULT_VIEW_MS;
  }, [data, now]);

  const effectiveEnd = viewEnd ?? now;
  const viewStart = effectiveEnd - viewMs;
  const fullSpan = Math.max(now - fullStart, MIN_VIEW_MS);

  const lanes: Lane[] = useMemo(
    () => (data ? buildTimelineLanes(data, now, fullStart) : []),
    [data, now, fullStart],
  );

  const xOf = useCallback(
    (t: number) => ((t - viewStart) / viewMs) * trackW,
    [viewStart, viewMs, trackW],
  );

  const ticks = useMemo(() => {
    const step = tickStep(viewMs);
    const first = Math.ceil(viewStart / step) * step;
    const out: number[] = [];
    for (let t = first; t <= effectiveEnd; t += step) out.push(t);
    return out;
  }, [viewStart, viewMs, effectiveEnd]);

  // ── interactions ──────────────────────────────────────────────────
  const clampView = useCallback((end: number, span: number) => {
    const maxSpan = Math.max(fullSpan * 1.2, DEFAULT_VIEW_MS);
    const s = Math.min(Math.max(span, MIN_VIEW_MS), maxSpan);
    const e = Math.min(Math.max(end, fullStart + s), now + s * 0.05);
    return { end: e, span: s };
  }, [fullStart, fullSpan, now]);

  const onWheel = useCallback((e: React.WheelEvent) => {
    if (!trackRef.current) return;
    const rect = trackRef.current.getBoundingClientRect();
    const frac = Math.min(Math.max((e.clientX - rect.left) / rect.width, 0), 1);
    const anchor = viewStart + frac * viewMs;
    const factor = e.deltaY > 0 ? 1.25 : 0.8;
    const next = clampView(anchor + (1 - frac) * viewMs * factor, viewMs * factor);
    setViewMs(next.span);
    setViewEnd(next.end >= now - 1000 ? null : next.end);
  }, [viewStart, viewMs, clampView, now]);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest(".koi-tl-seg")) return;
    dragRef.current = { startX: e.clientX, startEnd: effectiveEnd };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }, [effectiveEnd]);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag || !trackRef.current) return;
    const dx = e.clientX - drag.startX;
    const dt = (dx / trackRef.current.clientWidth) * viewMs;
    const next = clampView(drag.startEnd - dt, viewMs);
    setViewEnd(next.end >= now - 1000 ? null : next.end);
  }, [viewMs, clampView, now]);

  const onPointerUp = useCallback(() => { dragRef.current = null; }, []);

  const zoomBy = useCallback((factor: number) => {
    const next = clampView(effectiveEnd, viewMs * factor);
    setViewMs(next.span);
    setViewEnd(next.end >= now - 1000 ? null : next.end);
  }, [effectiveEnd, viewMs, clampView, now]);

  const onMinimapClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    // Ignore clicks that originated on the frame (drag handles it).
    if ((e.target as HTMLElement).closest(".koi-tl-mini-view")) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const frac = (e.clientX - rect.left) / rect.width;
    const center = fullStart + frac * fullSpan;
    const next = clampView(center + viewMs / 2, viewMs);
    setViewEnd(next.end >= now - 1000 ? null : next.end);
  }, [fullStart, fullSpan, viewMs, clampView, now]);

  // ── minimap frame drag (move / edge-resize) ───────────────────────
  const applyMiniView = useCallback((start: number, span: number) => {
    const next = clampView(start + span, span);
    setViewMs(next.span);
    setViewEnd(next.end >= now - 1000 ? null : next.end);
  }, [clampView, now]);

  const onMiniFramePointerDown = useCallback((e: React.PointerEvent, mode: "move" | "left" | "right") => {
    e.stopPropagation();
    const mini = (e.currentTarget as HTMLElement).closest(".koi-tl-minimap") as HTMLElement | null;
    if (!mini) return;
    miniDragRef.current = {
      mode,
      startX: e.clientX,
      startViewStart: viewStart,
      startViewMs: viewMs,
      miniW: mini.getBoundingClientRect().width || 1,
    };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }, [viewStart, viewMs]);

  const onMiniFramePointerMove = useCallback((e: React.PointerEvent) => {
    const drag = miniDragRef.current;
    if (!drag) return;
    e.stopPropagation();
    const dt = ((e.clientX - drag.startX) / drag.miniW) * fullSpan;
    if (drag.mode === "move") {
      applyMiniView(drag.startViewStart + dt, drag.startViewMs);
    } else if (drag.mode === "right") {
      applyMiniView(drag.startViewStart, Math.max(drag.startViewMs + dt, MIN_VIEW_MS));
    } else {
      // Left edge: keep the right edge fixed while moving the left one.
      const right = drag.startViewStart + drag.startViewMs;
      const newStart = Math.min(drag.startViewStart + dt, right - MIN_VIEW_MS);
      applyMiniView(newStart, right - newStart);
    }
  }, [fullSpan, applyMiniView]);

  const onMiniFramePointerUp = useCallback((e: React.PointerEvent) => {
    e.stopPropagation();
    miniDragRef.current = null;
  }, []);

  const stateLabel = (s: LaneState): string =>
    t(`pond.timeline.state_${s}`) || s;

  // ── render ────────────────────────────────────────────────────────
  if (!poolId) {
    return <div className="koi-tl-empty">{t("pond.timeline.noPool") || "Select a project to see its timeline"}</div>;
  }
  if (error) {
    return <div className="koi-tl-empty koi-tl-error">{error} <button onClick={load}>{t("common.retry") || "Retry"}</button></div>;
  }
  if (!data) {
    return <div className="koi-tl-empty">{t("common.loading") || "Loading..."}</div>;
  }
  if (lanes.length === 0) {
    return <div className="koi-tl-empty">{t("pond.timeline.noMembers") || "No Koi members in this project yet"}</div>;
  }

  const nowX = xOf(now);
  const miniViewLeft = ((viewStart - fullStart) / fullSpan) * 100;
  const miniViewW = Math.min((viewMs / fullSpan) * 100, 100);

  return (
    <div className="koi-tl">
      {/* Header: title, legend, zoom controls */}
      <div className="koi-tl-header">
        <span className="koi-tl-title">🕒 {t("pond.timeline.title") || "Koi Timeline"}</span>
        <div className="koi-tl-legend">
          {(Object.keys(STATE_COLORS) as LaneState[]).map((s) => (
            <span key={s} className="koi-tl-legend-item">
              <i style={{ background: STATE_COLORS[s] }} />
              {stateLabel(s)}
            </span>
          ))}
          <span className="koi-tl-legend-note">{t("pond.timeline.inferredNote") || "dashed = inferred"}</span>
        </div>
        <div className="koi-tl-controls">
          <button onClick={() => zoomBy(0.5)} title={t("pond.timeline.zoomIn") || "Zoom in"}>＋</button>
          <span className="koi-tl-zoom-label">{fmtDuration(viewMs)}</span>
          <button onClick={() => zoomBy(2)} title={t("pond.timeline.zoomOut") || "Zoom out"}>－</button>
          <button onClick={() => { setViewEnd(null); setViewMs(DEFAULT_VIEW_MS); }} title={t("pond.timeline.followNow") || "Follow now"}>⏱</button>
          <button onClick={load} disabled={loading} title={t("common.refresh") || "Refresh"}>↻</button>
        </div>
      </div>

      {/* Ruler */}
      <div className="koi-tl-ruler-row">
        <div className="koi-tl-lane-label koi-tl-ruler-corner" />
        <div className="koi-tl-ruler">
          {ticks.map((tk) => (
            <span key={tk} className="koi-tl-tick" style={{ left: xOf(tk) }}>{fmtClock(tk)}</span>
          ))}
        </div>
      </div>

      {/* Lanes */}
      <div className="koi-tl-body">
        {lanes.map((lane) => (
          <div key={lane.koi.id} className="koi-tl-lane">
            <div className="koi-tl-lane-label">
              <span className="koi-tl-lane-icon">{lane.koi.icon}</span>
              <span className="koi-tl-lane-name" style={{ color: lane.koi.color }}>{lane.koi.name}</span>
              <span className={`koi-tl-lane-status koi-tl-lane-status--${lane.koi.status}`}>
                {t(`pond.timeline.koi_${lane.koi.status}`) || lane.koi.status}
              </span>
            </div>
            <div
              className="koi-tl-track"
              ref={lane === lanes[0] ? trackRef : undefined}
              onWheel={onWheel}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
            >
              {lane.segments.map((seg, i) => {
                const left = xOf(seg.start);
                const w = Math.max(xOf(seg.end) - left, 2);
                if (left + w < 0 || left > trackW) return null;
                return (
                  <div
                    key={`${seg.todoId ?? seg.state}-${i}`}
                    className={`koi-tl-seg koi-tl-seg--${seg.state}${seg.inferred ? " koi-tl-seg--inferred" : ""}`}
                    style={{ left, width: w, background: STATE_COLORS[seg.state] }}
                    onClick={() => {
                      // Task segments open the Koi's iteration transcript
                      // (Observer); only non-task anchors fall back to chat.
                      if (seg.todoId && onOpenTask) {
                        onOpenTask(lane.koi.id, seg.todoId);
                      } else if (seg.anchorMessageId != null) {
                        onJumpToMessage?.(seg.anchorMessageId);
                      }
                    }}
                    onMouseEnter={(e) => setTooltip({ seg, x: e.clientX, y: e.clientY })}
                    onMouseMove={(e) => setTooltip({ seg, x: e.clientX, y: e.clientY })}
                    onMouseLeave={() => setTooltip(null)}
                  >
                    {w > 60 && seg.title && <span className="koi-tl-seg-title">{seg.title}</span>}
                  </div>
                );
              })}
              {nowX >= 0 && nowX <= trackW && <div className="koi-tl-nowline" style={{ left: nowX }} />}
            </div>
          </div>
        ))}
      </div>

      {/* Minimap: full range + viewport box */}
      <div className="koi-tl-minimap-row">
        <div className="koi-tl-lane-label koi-tl-minimap-label">{t("pond.timeline.overview") || "Overview"}</div>
        <div className="koi-tl-minimap" onClick={onMinimapClick}>
          {lanes.map((lane) => (
            <div key={lane.koi.id} className="koi-tl-mini-lane">
              {lane.segments.filter((s) => s.state !== "idle" && s.state !== "not_member").map((seg, i) => (
                <div
                  key={i}
                  className="koi-tl-mini-seg"
                  style={{
                    left: `${((seg.start - fullStart) / fullSpan) * 100}%`,
                    width: `${Math.max(((seg.end - seg.start) / fullSpan) * 100, 0.3)}%`,
                    background: STATE_COLORS[seg.state],
                  }}
                />
              ))}
            </div>
          ))}
          <div
            className="koi-tl-mini-view koi-tl-mini-view--draggable"
            style={{ left: `${Math.max(miniViewLeft, 0)}%`, width: `${miniViewW}%` }}
            title={t("pond.timeline.dragToNavigate") || "Drag to navigate · edges resize"}
            onPointerDown={(e) => onMiniFramePointerDown(e, "move")}
            onPointerMove={onMiniFramePointerMove}
            onPointerUp={onMiniFramePointerUp}
            onClick={(e) => e.stopPropagation()}
          >
            <div
              className="koi-tl-mini-handle koi-tl-mini-handle--left"
              onPointerDown={(e) => onMiniFramePointerDown(e, "left")}
              onPointerMove={onMiniFramePointerMove}
              onPointerUp={onMiniFramePointerUp}
            />
            <div
              className="koi-tl-mini-handle koi-tl-mini-handle--right"
              onPointerDown={(e) => onMiniFramePointerDown(e, "right")}
              onPointerMove={onMiniFramePointerMove}
              onPointerUp={onMiniFramePointerUp}
            />
          </div>
        </div>
      </div>

      {/* Tooltip */}
      {tooltip && (
        <div className="koi-tl-tooltip" style={{ left: tooltip.x + 12, top: tooltip.y + 12 }}>
          <div className="koi-tl-tooltip-title">{tooltip.seg.title || stateLabel(tooltip.seg.state)}</div>
          <div>{stateLabel(tooltip.seg.state)}{tooltip.seg.inferred ? ` · ${t("pond.timeline.inferred") || "inferred"}` : ""}</div>
          <div>{fmtClock(tooltip.seg.start)} – {fmtClock(tooltip.seg.end)} · {fmtDuration(tooltip.seg.end - tooltip.seg.start)}</div>
          {tooltip.seg.todoId && onOpenTask ? (
            <div className="koi-tl-tooltip-hint">{t("pond.timeline.clickToOpenTask") || "Click to open the Koi's task iterations"}</div>
          ) : tooltip.seg.anchorMessageId != null ? (
            <div className="koi-tl-tooltip-hint">{t("pond.timeline.clickToJump") || "Click to jump to chat"}</div>
          ) : null}
        </div>
      )}
    </div>
  );
}