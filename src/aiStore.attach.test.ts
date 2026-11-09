// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runAi = vi.hoisted(() => vi.fn());
vi.mock("./ai", async (orig) => ({ ...(await orig<typeof import("./ai")>()), runAi }));

import { api, type AiProvider, type TreeNode } from "./api";
import { useApp } from "./store";
import { useAi } from "./aiStore";

const n = (path: string, kind: TreeNode["kind"], children?: TreeNode[]): TreeNode => ({ name: path.split("/").pop()!, path, kind, mtime: 0, children });
const tree = [
  n("회의.md", "note"),
  n("일기.md", "note"),
  n("프로젝트", "folder", [n("프로젝트/계획.md", "note"), n("프로젝트/비밀.md", "note")]),
  n("비공개만", "folder", [n("비공개만/비밀2.md", "note")]),
];
const claude = { id: "claude", name: "Claude Code", available: true, logged_in: true } as AiProvider;

/** The note paths runAi was given on its last call. */
const sentPaths = () => runAi.mock.calls[runAi.mock.calls.length - 1]?.[3] as string[];

describe("notes dropped on the AI box", () => {
  const initialApp = useApp.getState();
  const initialAi = useAi.getState();
  beforeEach(() => {
    vi.spyOn(api, "aiPrivateNotes").mockImplementation(async (paths: string[]) => paths.filter((p) => p.includes("비밀")));
    vi.spyOn(api, "readNote").mockResolvedValue("본문");
    vi.spyOn(api, "listTemplates").mockResolvedValue([]);
    runAi.mockReturnValue({ done: Promise.resolve({ text: "답" }), cancel() {} });
    useApp.setState({ vault: { root: "D:/v", name: "v" } as never, tree, flushEditor: async () => {} });
    useAi.setState({ enabled: true, providers: [claude], providerId: "claude" });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    runAi.mockReset();
    useApp.setState(initialApp, true);
    useAi.setState(initialAi, true);
  });
  const attached = () => useAi.getState().attached.map((a) => [a.path, a.notes, a.privateCount]);

  it("a dropped note or folder becomes a chip with the notes it sends, private ones left out", async () => {
    await useAi.getState().attach("회의.md");
    await useAi.getState().attach("프로젝트");
    expect(attached()).toEqual([
      ["회의.md", ["회의.md"], 0],
      ["프로젝트", ["프로젝트/계획.md"], 1],
    ]);
  });

  it("the same entry twice is one chip", async () => {
    await useAi.getState().attach("회의.md");
    await useAi.getState().attach("회의.md");
    expect(attached()).toHaveLength(1);
  });

  it("a folder with nothing to send is not added, and says why", async () => {
    await useAi.getState().attach("비공개만");
    expect(attached()).toEqual([]);
    expect(useApp.getState().toasts.length).toBe(1);
  });

  it("detach removes a chip, a new chat removes them all", async () => {
    await useAi.getState().attach("회의.md");
    await useAi.getState().attach("일기.md");
    useAi.getState().detach("회의.md");
    expect(attached().map((a) => a[0])).toEqual(["일기.md"]);
    useAi.getState().newChat();
    expect(attached()).toEqual([]);
  });

  it("asking sends only the dropped notes, without the send dialog, and keeps the chips", async () => {
    const context = vi.spyOn(api, "aiContext");
    await useAi.getState().attach("프로젝트");
    await useAi.getState().attach("회의.md");
    await useAi.getState().ask("이 계획에서 빠진 것 알려 줘");
    expect(useAi.getState().send).toBeNull();
    expect(context).not.toHaveBeenCalled();
    expect(sentPaths()).toEqual(["프로젝트/계획.md", "회의.md"]);
    expect(attached()).toHaveLength(2);
  });

  it("asking with nothing dropped sends no notes and shows no dialog", async () => {
    const context = vi.spyOn(api, "aiContext");
    useApp.setState({ openPath: "일기.md" });
    await useAi.getState().ask("지난주 회의 내용 정리");
    expect(useAi.getState().send).toBeNull();
    expect(context).not.toHaveBeenCalled();
    expect(sentPaths()).toEqual([]);
  });

  it("a request to write in the open note sends the open note too", async () => {
    useApp.setState({ openPath: "일기.md" });
    await useAi.getState().attach("회의.md");
    await useAi.getState().ask("회의 내용을 여기에 추가해 줘");
    expect(sentPaths()).toEqual(["회의.md", "일기.md"]);
  });

  it("the note folder's answer instructions go with every question", async () => {
    useApp.setState({ config: { ...useApp.getState().config, ai_instructions: "결론부터 세 줄로" } });
    await useAi.getState().ask("요즘 어때");
    const system = runAi.mock.calls[runAi.mock.calls.length - 1]?.[1] as string;
    expect(system).toContain("<사용자 지침>\n결론부터 세 줄로\n</사용자 지침>");
  });

  it("each note folder keeps its own chips", () => {
    useAi.setState({ attached: [{ path: "회의.md", notes: ["회의.md"], privateCount: 0 }] });
    const kept = useAi.getState().snapshot();
    useAi.getState().restore(undefined);
    expect(attached()).toEqual([]);
    useAi.getState().restore(kept);
    expect(attached()).toEqual([["회의.md", ["회의.md"], 0]]);
  });
});
