// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LockStatus } from "../api";

const mocks = vi.hoisted(() => ({
  lockStatus: vi.fn(),
  lockUnlockPassword: vi.fn(),
  lockUnlockHello: vi.fn(),
  lockPainted: vi.fn(),
  focused: true,
}));
vi.mock("../api", () => ({ api: mocks }));
vi.mock("../store", () => ({ useApp: { getState: () => ({ flushEditor: async () => true }) } }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ isFocused: async () => mocks.focused, onFocusChanged: async () => () => {} }),
}));

const status = (over: Partial<LockStatus> = {}): LockStatus => ({
  mode: "password",
  locked: true,
  reason: "manual",
  epoch: 1,
  away: false,
  idle_minutes: 5,
  ...over,
});

let root: Root;
let host: HTMLElement;
let lock: typeof import("./lockStore");

const screen = () => document.querySelector<HTMLElement>(".lock-screen");
const button = (text: string) => [...screen()!.querySelectorAll("button")].find((b) => b.textContent === text)!;

async function show(first: LockStatus) {
  mocks.lockStatus.mockResolvedValue(first);
  const { default: LockGate } = await import("./LockGate");
  lock = await import("./lockStore");
  await act(async () =>
    root.render(
      <LockGate>
        <p id="note">비밀 노트</p>
      </LockGate>,
    ),
  );
}

async function typePassword(value: string) {
  const input = screen()!.querySelector("input")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => button("열기").click());
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.resetModules();
  vi.clearAllMocks();
  mocks.focused = true;
  mocks.lockPainted.mockResolvedValue(undefined);
  mocks.lockUnlockHello.mockResolvedValue("cancelled");
  document.body.className = "";
  document.body.innerHTML = "";
  host = document.body.appendChild(document.createElement("div"));
  host.id = "root";
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  vi.unstubAllGlobals();
});

describe("lock screen", () => {
  it("draws no children before the status is known", async () => {
    mocks.lockStatus.mockReturnValue(new Promise(() => {}));
    const { default: LockGate } = await import("./LockGate");
    await act(async () =>
      root.render(
        <LockGate>
          <p id="note">비밀 노트</p>
        </LockGate>,
      ),
    );
    expect(document.querySelector("#note")).toBeNull();
    expect(screen()).not.toBeNull();
  });

  it("covers the app, outside the app's own element, and goes away on unlock", async () => {
    await show(status());
    expect(screen()!.parentElement).toBe(document.body);
    expect(screen()!.textContent).not.toContain("비밀 노트");
    expect(document.querySelector("#note")).not.toBeNull();
    await act(async () => lock.applyLockStatus(status({ locked: false, reason: null })));
    expect(screen()).toBeNull();
  });

  it("submits the password and shows what is wrong", async () => {
    await show(status());
    mocks.lockUnlockPassword.mockResolvedValueOnce(-1).mockResolvedValueOnce(30);
    await typePassword("zzzz");
    expect(mocks.lockUnlockPassword).toHaveBeenCalledWith("zzzz");
    expect(screen()!.textContent).toContain("비밀번호가 맞지 않습니다.");
    expect(screen()!.querySelector("input")!.value).toBe("");
    await typePassword("abcd");
    expect(screen()!.textContent).toContain("너무 많이 틀렸습니다. 30초 뒤에 다시 입력하세요.");
  });

  it("tells the app once it has painted the lock", async () => {
    await show(status());
    await vi.waitFor(() => expect(mocks.lockPainted).toHaveBeenCalled());
  });

  it("asks Windows Hello by itself for a start lock", async () => {
    await show(status({ mode: "hello", reason: "start" }));
    expect(mocks.lockUnlockHello).toHaveBeenCalledExactlyOnceWith("Notevine 잠금 해제");
  });

  it("waits for the button after lock-now", async () => {
    await show(status({ mode: "hello", reason: "manual" }));
    expect(mocks.lockUnlockHello).not.toHaveBeenCalled();
    mocks.lockUnlockHello.mockResolvedValue("unavailable");
    await act(async () => button("잠금 해제").click());
    expect(screen()!.textContent).toContain("Windows Hello를 다시 설정하세요");
  });

  it("opens only one Hello prompt however often the button is pressed", async () => {
    mocks.lockUnlockHello.mockReturnValue(new Promise(() => {}));
    await show(status({ mode: "hello", reason: "manual" }));
    await act(async () => button("잠금 해제").click());
    await act(async () => button("잠금 해제").click());
    expect(mocks.lockUnlockHello).toHaveBeenCalledOnce();
  });

  it("explains a damaged settings file and offers nothing to press", async () => {
    await show(status({ mode: "broken", reason: "start" }));
    expect(screen()!.textContent).toContain("잠금 설정을 읽지 못했습니다. 사용자 매뉴얼을 보세요");
    expect(screen()!.querySelector("button")).toBeNull();
  });

  it("shows the held-quit message", async () => {
    await show(status());
    await act(async () => lock.useLock.setState({ quitHeld: true }));
    expect(screen()!.textContent).toContain("저장하지 못한 편집이 있어 종료하지 않았습니다. 잠금을 풀어 확인하세요");
  });
});
