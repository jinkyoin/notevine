// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LockMode } from "../api";
import { availableCommands } from "../commands";

const mocks = vi.hoisted(() => ({ lockChange: vi.fn(), lockNow: vi.fn() }));
vi.mock("../api", () => ({ api: mocks, errorMessage: (e: unknown) => String(e) }));
// What the other commands' conditions read: no folder open, nothing on screen.
vi.mock("../store", () => ({
  useApp: { getState: () => ({ vault: null, openPath: null, tabs: [], closedTabs: [], rail: [], config: {} }) },
}));
vi.mock("../aiStore", () => ({ useAi: { getState: () => ({}) } }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

import { LockSettings } from "./LockSettings";
import { useLock } from "./lockStore";
import { registerAppCommands } from "../appCommands";

const MESSAGE = "Notevine 잠금 설정 변경";
let root: Root;
let host: HTMLElement;

function lockIs(mode: LockMode) {
  useLock.setState({ status: { mode, locked: false, reason: null, epoch: 0, away: false, idle_minutes: 5 } });
}

async function show(mode: LockMode) {
  lockIs(mode);
  await act(async () => root.render(<LockSettings />));
}

const selects = () => [...host.querySelectorAll("select")];
const input = (label: string) => host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
const button = (text: string) => [...host.querySelectorAll("button")].find((b) => b.textContent === text);

/** Sets a value the way a user would, so React hears it. */
async function put(el: HTMLInputElement | HTMLSelectElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value")!.set!.call(el, value);
    el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
  });
}
const click = (text: string) => act(async () => button(text)!.click());

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  mocks.lockChange.mockResolvedValue({ status: "ok" });
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe("app lock settings", () => {
  it("refuses a short or mismatched password without calling the app", async () => {
    await show("off");
    await put(selects()[0], "password");
    expect(input("현재 비밀번호")).toBeNull();
    await put(input("새 비밀번호")!, "abc");
    await put(input("비밀번호 확인")!, "abc");
    await click("확인");
    expect(host.textContent).toContain("4자 이상으로 정하세요.");
    await put(input("새 비밀번호")!, "abcd");
    await put(input("비밀번호 확인")!, "abce");
    await click("확인");
    expect(host.textContent).toContain("두 번 입력한 비밀번호가 같지 않습니다.");
    expect(mocks.lockChange).not.toHaveBeenCalled();
  });

  it("turns on the password lock", async () => {
    await show("off");
    await put(selects()[0], "password");
    await put(input("새 비밀번호")!, "abcd");
    await put(input("비밀번호 확인")!, "abcd");
    await click("확인");
    expect(mocks.lockChange).toHaveBeenCalledExactlyOnceWith({ mode: "password", password: "abcd" }, null, MESSAGE);
    expect(input("새 비밀번호")).toBeNull();
  });

  it("asks the current password before any change in password mode", async () => {
    await show("password");
    await put(selects()[1], "10");
    expect(mocks.lockChange).not.toHaveBeenCalled();
    mocks.lockChange.mockResolvedValueOnce({ status: "wrong" });
    await put(input("현재 비밀번호")!, "zzzz");
    await click("확인");
    expect(host.textContent).toContain("비밀번호가 맞지 않습니다.");
    await put(input("현재 비밀번호")!, "abcd");
    await click("확인");
    expect(mocks.lockChange).toHaveBeenLastCalledWith({ idle_minutes: 10 }, "abcd", MESSAGE);
  });

  it("changes the password with the current one", async () => {
    await show("password");
    await click("비밀번호 바꾸기");
    await put(input("현재 비밀번호")!, "abcd");
    await put(input("새 비밀번호")!, "efgh");
    await put(input("비밀번호 확인")!, "efgh");
    await click("확인");
    expect(mocks.lockChange).toHaveBeenCalledExactlyOnceWith({ mode: "password", password: "efgh" }, "abcd", MESSAGE);
  });

  it("shows how long to wait", async () => {
    await show("password");
    await put(selects()[0], "off");
    mocks.lockChange.mockResolvedValueOnce({ status: "wait", seconds: 12 });
    await put(input("현재 비밀번호")!, "abcd");
    await click("확인");
    expect(host.textContent).toContain("너무 많이 틀렸습니다. 12초 뒤에 다시 입력하세요.");
  });

  it("keeps the old value when Hello is cancelled or missing", async () => {
    await show("off");
    mocks.lockChange.mockResolvedValueOnce({ status: "cancelled" });
    await put(selects()[0], "hello");
    expect(mocks.lockChange).toHaveBeenCalledWith({ mode: "hello" }, null, MESSAGE);
    expect(selects()[0].value).toBe("off");
    expect(host.querySelector(".lock-error")).toBeNull();
    mocks.lockChange.mockResolvedValueOnce({ status: "unavailable" });
    await put(selects()[0], "hello");
    expect(selects()[0].value).toBe("off");
    expect(host.textContent).toContain("Windows 설정에서 Windows Hello(PIN·지문·얼굴)를 먼저 설정하세요.");
  });

  it("offers the lock's own settings only while it is on", async () => {
    await show("off");
    expect(selects()).toHaveLength(1);
    expect(button("지금 잠그기")).toBeUndefined();
    await act(async () => lockIs("hello"));
    expect(selects()).toHaveLength(2);
    expect(button("비밀번호 바꾸기")).toBeUndefined();
    await click("지금 잠그기");
    expect(mocks.lockNow).toHaveBeenCalledOnce();
  });

  it("lists lock-now only while a lock is on", () => {
    const off = registerAppCommands();
    const has = () => availableCommands().some((c) => c.id === "app.lock" && c.keys === "Ctrl+Alt+L");
    lockIs("off");
    expect(has()).toBe(false);
    lockIs("password");
    expect(has()).toBe(true);
    off();
  });
});
