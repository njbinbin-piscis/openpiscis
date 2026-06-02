/**
 * Toaster — Main-window toast host.
 *
 * Listens for backend `piscis_toast` events (emitted by `app_control.notify_user`
 * and by heartbeat safety nets for `EscalateToHuman` states) and stacks them in
 * the top-right of the main window.
 *
 * Levels:
 *   info     — default, soft neutral
 *   warning  — amber
 *   error    — red
 *   critical — red + persistent (duration_ms=0) until the user dismisses
 */

import { useEffect, useState, useCallback } from "react";
import { listen } from "@tauri-apps/api/event";
import "./Toaster.css";

type ToastLevel = "info" | "warning" | "error" | "critical";

interface ToastPayload {
  id: string;
  title?: string;
  message: string;
  level?: ToastLevel;
  pool_id?: string;
  duration_ms?: number;
  source?: string;
  ts?: number;
}

interface Toast {
  id: string;
  title: string;
  message: string;
  level: ToastLevel;
  poolId?: string;
  durationMs: number;
}

const LEVEL_ICONS: Record<ToastLevel, string> = {
  info: "ℹ️",
  warning: "⚠️",
  error: "❌",
  critical: "🚨",
};

function normalizeLevel(raw?: string): ToastLevel {
  switch (raw) {
    case "warning":
    case "warn":
      return "warning";
    case "error":
      return "error";
    case "critical":
      return "critical";
    default:
      return "info";
  }
}

export default function Toaster() {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const dismiss = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    listen<ToastPayload>("piscis_toast", (event) => {
      const p = event.payload;
      if (!p || !p.message) return;
      const level = normalizeLevel(p.level);
      const defaultDuration =
        level === "critical" ? 0 :
        level === "error"    ? 12000 :
        level === "warning"  ? 8000  : 5000;
      const durationMs =
        typeof p.duration_ms === "number" ? p.duration_ms : defaultDuration;

      const toast: Toast = {
        id: p.id || `toast_${Date.now()}_${Math.random()}`,
        title: p.title?.trim() || "Piscis",
        message: p.message,
        level,
        poolId: p.pool_id,
        durationMs,
      };

      setToasts((prev) => {
        // Dedupe by id to avoid stacking repeated auto-emissions.
        const filtered = prev.filter((t) => t.id !== toast.id);
        // Keep at most 5 toasts on screen.
        const trimmed = filtered.slice(-4);
        return [...trimmed, toast];
      });

      if (durationMs > 0) {
        setTimeout(() => {
          setToasts((prev) => prev.filter((t) => t.id !== toast.id));
        }, durationMs);
      }
    }).then((fn) => { unlisten = fn; });
    return () => { unlisten?.(); };
  }, []);

  if (toasts.length === 0) return null;

  return (
    <div className="piscis-toaster" role="region" aria-label="Piscis notifications">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`piscis-toast piscis-toast-${t.level}`}
          role={t.level === "critical" || t.level === "error" ? "alert" : "status"}
        >
          <div className="piscis-toast-icon">{LEVEL_ICONS[t.level]}</div>
          <div className="piscis-toast-body">
            <div className="piscis-toast-title">{t.title}</div>
            <div className="piscis-toast-message">{t.message}</div>
            {t.poolId && (
              <div className="piscis-toast-meta">pool: {t.poolId}</div>
            )}
          </div>
          <button
            className="piscis-toast-close"
            onClick={() => dismiss(t.id)}
            aria-label="Dismiss"
            title="Dismiss"
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}
