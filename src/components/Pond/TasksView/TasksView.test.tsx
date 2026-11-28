import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { Provider } from "react-redux";
import { configureStore } from "@reduxjs/toolkit";
import { boardSlice, koiSlice, poolSlice } from "../../../store/slices/pool";
import TasksView from "./index";

vi.mock("../../../services/tauri", () => ({
  boardApi: { listTodos: vi.fn().mockResolvedValue([]), onTodoUpdated: vi.fn().mockResolvedValue(() => {}) },
  koiApi: { list: vi.fn().mockResolvedValue([]) },
  poolApi: { listSessions: vi.fn().mockResolvedValue([]) },
}));
vi.mock("../../../services/tauri/pool", () => ({
  timelineApi: { get: vi.fn().mockResolvedValue({ members: [], todos: [], events: [] }) },
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

function makeStore() {
  return configureStore({
    reducer: { board: boardSlice.reducer, koi: koiSlice.reducer, pool: poolSlice.reducer },
  });
}

describe("TasksView", () => {
  beforeEach(() => vi.clearAllMocks());

  it("renders Board/Timeline sub-tabs and shared filters", () => {
    render(
      <Provider store={makeStore()}>
        <TasksView poolId="p1" />
      </Provider>,
    );
    expect(screen.getByRole("tab", { name: /pond.tabBoard/ })).toBeTruthy();
    expect(screen.getByRole("tab", { name: /pond.tabTimeline/ })).toBeTruthy();
    // shared filter dropdowns present
    expect(screen.getByText(/board.filterByKoi/)).toBeTruthy();
    expect(screen.getByText(/board.filterByPriority/)).toBeTruthy();
  });

  it("switches to Timeline sub-tab on click", async () => {
    render(
      <Provider store={makeStore()}>
        <TasksView poolId="p1" />
      </Provider>,
    );
    const tlTab = screen.getByRole("tab", { name: /pond.tabTimeline/ });
    fireEvent.click(tlTab);
    expect(tlTab.getAttribute("aria-selected")).toBe("true");
    // timeline loads async then shows empty state (no members)
    await waitFor(() => expect(screen.getByText(/pond.timeline.noMembers/)).toBeTruthy());
  });
});