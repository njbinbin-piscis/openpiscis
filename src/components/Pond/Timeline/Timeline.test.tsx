import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import KoiTimeline from "./index";
import type { KoiTimelineData } from "../../../services/tauri/pool";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (_key: string) => "" }),
}));

const mockInvoke = vi.mocked(invoke);

const NOW_ISO = new Date().toISOString();
const HOUR_AGO = new Date(Date.now() - 3_600_000).toISOString();

function fixture(): KoiTimelineData {
  return {
    pool_id: "p1",
    server_now: NOW_ISO,
    members: [
      {
        koi: {
          id: "k1", name: "Coder", role: "dev", icon: "🐟", color: "#22c55e",
          system_prompt: "", description: "", status: "busy",
          created_at: HOUR_AGO, updated_at: HOUR_AGO, max_iterations: 0, task_timeout_secs: 0,
        },
        joined_at: HOUR_AGO,
      },
      {
        koi: {
          id: "k2", name: "Reviewer", role: "review", icon: "🐠", color: "#3b82f6",
          system_prompt: "", description: "", status: "idle",
          created_at: HOUR_AGO, updated_at: HOUR_AGO, max_iterations: 0, task_timeout_secs: 0,
        },
        joined_at: HOUR_AGO,
      },
    ],
    todos: [],
    events: [],
  };
}

beforeEach(() => {
  mockInvoke.mockReset();
});

describe("KoiTimeline", () => {
  it("shows empty hint when no pool selected", () => {
    render(<KoiTimeline poolId={null} />);
    expect(screen.getByText(/Select a project/i)).toBeTruthy();
  });

  it("renders one lane per member with legend and minimap", async () => {
    mockInvoke.mockResolvedValueOnce(fixture());
    const { container } = render(<KoiTimeline poolId="p1" />);
    await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith("get_koi_timeline", { poolId: "p1" }));
    await waitFor(() => {
      expect(container.querySelectorAll(".koi-tl-lane")).toHaveLength(2);
    });
    expect(screen.getByText("Coder")).toBeTruthy();
    expect(screen.getByText("Reviewer")).toBeTruthy();
    // five-state legend
    expect(container.querySelectorAll(".koi-tl-legend-item")).toHaveLength(5);
    // minimap present with viewport box
    expect(container.querySelector(".koi-tl-minimap")).toBeTruthy();
    expect(container.querySelector(".koi-tl-mini-view")).toBeTruthy();
  });

  it("shows no-members hint for an empty pool", async () => {
    mockInvoke.mockResolvedValueOnce({ ...fixture(), members: [] });
    render(<KoiTimeline poolId="p1" />);
    await waitFor(() => expect(screen.getByText(/No Koi members/i)).toBeTruthy());
  });

  it("shows error state with retry on IPC failure", async () => {
    mockInvoke.mockRejectedValueOnce("boom");
    render(<KoiTimeline poolId="p1" />);
    await waitFor(() => expect(screen.getByText(/boom/)).toBeTruthy());
    expect(screen.getByText(/Retry/i)).toBeTruthy();
  });

  it("minimap frame has drag handles and reflects the zoomed window width", async () => {
    // Join 4 h ago → fullSpan ≈ 4 h; default view 1 h → frame ≈ 25 % wide.
    const fourHAgo = new Date(Date.now() - 4 * 3_600_000).toISOString();
    const f = fixture();
    f.members = f.members.map((m) => ({ ...m, joined_at: fourHAgo }));
    mockInvoke.mockResolvedValueOnce(f);
    const { container } = render(<KoiTimeline poolId="p1" />);
    await waitFor(() => expect(container.querySelector(".koi-tl-mini-view")).toBeTruthy());
    const frame = container.querySelector(".koi-tl-mini-view") as HTMLElement;
    // Zoomed-in window must be narrower than the full range.
    const w = parseFloat(frame.style.width);
    expect(w).toBeGreaterThan(5);
    expect(w).toBeLessThan(90);
    // Draggable affordances: body + two edge resize handles.
    expect(frame.classList.contains("koi-tl-mini-view--draggable")).toBe(true);
    expect(frame.querySelector(".koi-tl-mini-handle--left")).toBeTruthy();
    expect(frame.querySelector(".koi-tl-mini-handle--right")).toBeTruthy();
  });
});