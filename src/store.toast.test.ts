// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

import { useApp } from "./store";

describe("toasts", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useApp.setState({ toasts: [] });
  });
  afterEach(() => vi.useRealTimers());

  const messages = () => useApp.getState().toasts.map((t) => t.message);

  it("info goes after 4 seconds, an error after 10", () => {
    useApp.getState().toast("저장했습니다");
    useApp.getState().toast("실패했습니다", "error");
    vi.advanceTimersByTime(4000);
    expect(messages()).toEqual(["실패했습니다"]);
    vi.advanceTimersByTime(5999);
    expect(messages()).toEqual(["실패했습니다"]);
    vi.advanceTimersByTime(1);
    expect(messages()).toEqual([]);
  });

  it("closing one by hand first is fine", () => {
    useApp.getState().toast("실패했습니다", "error");
    useApp.getState().dismissToast(useApp.getState().toasts[0].id);
    vi.advanceTimersByTime(10000);
    expect(messages()).toEqual([]);
  });
});
