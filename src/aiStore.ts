// AI 화면 상태와 흐름: 질문(SCR-18), 전송 확인(SCR-19), 작성 결과 미리보기(SCR-20).
import { create } from "zustand";
import { api, errorMessage, type AiProvider, type ContextNote } from "./api";
import {
  aiPrefs,
  chatPrompt,
  journalNotesInRange,
  needsLogin,
  pickProvider,
  qaSystem,
  REVIEW_SYSTEM,
  reviewPrompt,
  runAi,
  weekRange,
  WRITE_LABEL,
  WRITE_SYSTEM,
  writePrompt,
  type RunHandle,
  type WriteTask,
} from "./ai";
import { useApp } from "./store";
import { findNode, noteTitle } from "./lib/tree";
import { appendText, applyChanges, editSystem, parseEdits, planEdit, type Planned } from "./lib/aiEdits";
import { day } from "./lib/folderTable";
import type { TreeNode } from "./api";

export interface ChatMessage {
  role: "user" | "ai";
  text: string;
  /** Notes sent with the question (paths). */
  sources?: string[];
  /** Model that answered, when the CLI reports it. */
  model?: string;
  /** Web steps while answering ("웹 검색: …", "페이지 읽기: …"). */
  progress?: string[];
  /** AI that answered (for the login button after a login error). */
  provider?: string;
  error?: string;
  streaming?: boolean;
  question?: string;
}

export interface SendRequest {
  provider: AiProvider;
  title: string;
  notes: ContextNote[];
  /** Pre-checked note paths. */
  checked: string[];
  /** Text sent besides notes (e.g. the selection), shown for transparency. */
  extra?: { label: string; text: string };
  /** Relevant notes left out because they are tagged #비공개. */
  privateExcluded?: number;
  /** Offer the "also search the web" choice (a question, not a writing task). */
  web?: boolean;
  resolve: (paths: string[] | null) => void;
}

export interface Preview {
  title: string;
  /** "edit" applies to the selection; "note" saves as a new note. */
  mode: "edit" | "note";
  original: string;
  result: string;
  streaming: boolean;
  error: string | null;
  from: number;
  to: number;
  noteName?: string;
  noteDir?: string;
  handle?: RunHandle;
}

/** One proposed note change in the review dialog. */
export interface EditItem extends Planned {
  checked: boolean;
}

/** AI note work (create/append/edit proposals) waiting for the user's review. */
export interface EditProposal {
  request: string;
  /** The AI's answer so far, while it streams. */
  raw: string;
  streaming: boolean;
  error: string | null;
  /** The AI's explanation outside the blocks. */
  message: string;
  items: EditItem[];
  /** Notes sent with the request: the only ones it may change. */
  sources: string[];
  applying: boolean;
  handle?: RunHandle;
}

interface AiState {
  enabled: boolean;
  providers: AiProvider[] | null;
  providerId: string;
  /** Chosen model per provider ("" = CLI default). */
  models: Record<string, string>;
  chat: ChatMessage[];
  running: RunHandle | null;
  send: SendRequest | null;
  preview: Preview | null;
  /** Provider whose login window is open. */
  loggingIn: string | null;
  /** What the panel's box does: ask a question, or have the AI propose note changes. */
  mode: "ask" | "edit";
  setMode(mode: "ask" | "edit"): void;
  edits: EditProposal | null;
  /** Sends a request for note changes; the proposals open in the review dialog. */
  proposeEdits(request: string): Promise<void>;
  toggleEdit(index: number, on: boolean): void;
  /** Applies the checked proposals (through the editor or the save path, so history keeps them). */
  applyEdits(): Promise<void>;
  closeEdits(): void;
  /** Questions may also search the web (choice in the send dialog, remembered). */
  webSearch: boolean;
  setWebSearch(on: boolean): void;

  /** `refresh` probes the CLIs again now. */
  detect(refresh?: boolean): Promise<void>;
  /** Opens the CLI's own login window and re-checks when it closes. */
  login(provider: string): Promise<void>;
  setEnabled(on: boolean): void;
  setProvider(id: string): void;
  setModel(provider: string, model: string): void;
  current(): AiProvider | undefined;
  /** Shows SCR-19; resolves to the note paths to send, or null when cancelled. */
  confirmSend(req: Omit<SendRequest, "resolve">): Promise<string[] | null>;
  ask(question: string): Promise<void>;
  stop(): void;
  newChat(): void;
  saveAnswer(index: number): Promise<void>;
  write(task: WriteTask): Promise<void>;
  weeklyReview(): Promise<void>;
  closePreview(): void;
  applyPreview(how: "replace" | "below" | "note", text: string): Promise<void>;
}

const app = () => useApp.getState();

/** Folders of the vault (two levels deep), for telling the AI where new notes can go. */
function folderPaths(tree: TreeNode[], depth = 0): string[] {
  return tree.flatMap((n) => (n.kind === "folder" ? [n.path, ...(depth < 1 ? folderPaths(n.children ?? [], depth + 1) : [])] : []));
}

/** Makes `dir` and the folders above it when they are missing. */
async function ensureFolder(dir: string) {
  const parts = dir.split("/").filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    const path = parts.slice(0, i + 1).join("/");
    if (findNode(app().tree, path)) continue;
    await api.createFolder(parts.slice(0, i).join("/"), parts[i]).catch((e) => {
      if ((e as { code?: string })?.code !== "already_exists") throw e;
    });
  }
}

function stamp(d = new Date()) {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}${p(d.getMinutes())}`;
}

export const useAi = create<AiState>((set, get) => {
  /** Common gate: AI on and a usable CLI found; otherwise explain and point to settings. */
  async function ready(): Promise<AiProvider | null> {
    if (!get().enabled) {
      app().toast("AI 도우미가 꺼져 있습니다. 설정 → AI에서 켜 주세요", "error", {
        label: "설정 열기",
        run: () => app().setModal("settings"),
      });
      return null;
    }
    if (!get().providers) await get().detect();
    const p = get().current();
    if (!p) {
      const loggedOut = (get().providers ?? []).find(needsLogin);
      if (loggedOut) {
        app().toast(`${loggedOut.name}에 로그인되어 있지 않습니다`, "error", {
          label: "로그인",
          run: () => void get().login(loggedOut.id),
        });
      } else {
        app().toast("사용할 수 있는 AI가 없습니다. Claude Code나 Codex CLI를 설치하고 로그인해 주세요", "error", {
          label: "설정 열기",
          run: () => app().setModal("settings"),
        });
      }
      return null;
    }
    return p;
  }

  /**
   * Notes related to `q` to offer for sending: search hits (pre-checked) plus the
   * open note (unchecked). Private notes are never offered, only counted.
   */
  async function relatedNotes(q: string): Promise<{ notes: ContextNote[]; checked: string[]; privateExcluded: number }> {
    const ctx = await api.aiContext(q, 8).catch(() => ({ notes: [] as ContextNote[], private_excluded: [] as string[] }));
    const found = ctx.notes;
    const excluded = new Set(ctx.private_excluded);
    const open = app().openPath;
    const notes = [...found];
    if (open && !notes.some((n) => n.path === open)) {
      const isPrivate = (await api.aiPrivateNotes([open]).catch(() => [open])).length > 0;
      if (isPrivate) excluded.add(open);
      else {
        const text = await api.readNote(open).catch(() => "");
        notes.push({ path: open, title: noteTitle(open), snippet: "(지금 열려 있는 노트)", chars: [...text].length });
      }
    }
    return { notes, checked: found.map((n) => n.path), privateExcluded: excluded.size };
  }

  return {
    enabled: aiPrefs.enabled(),
    providers: null,
    providerId: aiPrefs.provider(),
    models: { claude: aiPrefs.model("claude"), codex: aiPrefs.model("codex") },
    chat: [],
    running: null,
    send: null,
    preview: null,
    loggingIn: null,
    webSearch: aiPrefs.web(),
    mode: "ask",
    edits: null,

    setMode(mode) {
      set({ mode });
    },

    async proposeEdits(request) {
      const q = request.trim();
      if (!q || get().running) return;
      const provider = await ready();
      if (!provider) return;
      const related = await relatedNotes(q);
      // The open note is usually the one to work on: offer it checked.
      const open = app().openPath;
      const checked = open && related.notes.some((n) => n.path === open) ? [...new Set([...related.checked, open])] : related.checked;
      const paths = await get().confirmSend({ provider, title: "노트 작업 보내기", ...related, checked, extra: { label: "요청", text: q } });
      if (paths === null) return;
      await app().flushEditor();
      const cfg = app().config;
      const system = editSystem({ folders: folderPaths(app().tree), newNoteDir: cfg.preset_enabled ? cfg.inbox_folder : "", today: day(Date.now()) });
      const update = (patch: Partial<EditProposal>) => {
        const cur = get().edits;
        if (cur?.handle === handle) set({ edits: { ...cur, ...patch } });
      };
      const handle = runAi(provider.id, system, `요청: ${q}`, paths, (raw) => update({ raw }));
      set({
        running: handle,
        edits: { request: q, raw: "", streaming: true, error: null, message: "", items: [], sources: paths, applying: false, handle },
      });
      try {
        const { text } = await handle.done;
        const { message, edits } = parseEdits(text);
        const byLower = new Map(app().notes.map((n) => [n.path.toLowerCase(), n.path]));
        const actual = (p: string) => byLower.get(p.toLowerCase()) ?? p;
        const sent = new Set(paths);
        const items = await Promise.all(
          edits.map(async (e) => {
            const plan = await planEdit(
              { ...e, path: actual(e.path) },
              {
                sent,
                exists: (p) => byLower.has(p.toLowerCase()) || !!findNode(app().tree, p),
                read: (p) => api.readNote(actual(p)),
              },
            );
            return { ...plan, path: actual(plan.path), checked: !plan.error };
          }),
        );
        update({ raw: text, streaming: false, message: message || (edits.length ? "" : text.trim()), items });
      } catch (e) {
        update({ streaming: false, error: errorMessage(e) });
      } finally {
        set({ running: null });
      }
    },

    toggleEdit(index, on) {
      const p = get().edits;
      if (!p) return;
      set({ edits: { ...p, items: p.items.map((it, i) => (i === index && !it.error ? { ...it, checked: on } : it)) } });
    },

    async applyEdits() {
      const p = get().edits;
      if (!p || p.streaming || p.applying) return;
      const todo = p.items.filter((it) => it.checked && !it.error);
      if (!todo.length) return;
      set({ edits: { ...p, applying: true } });
      let done = 0;
      let created: string | null = null;
      const failed: string[] = [];
      for (const it of todo) {
        const e = it.edit;
        if (e.kind === "create") {
          const slash = it.path.lastIndexOf("/");
          const dir = slash < 0 ? "" : it.path.slice(0, slash);
          try {
            await ensureFolder(dir);
            const path = await api.createNote(dir, it.path.slice(slash + 1), it.after);
            created ??= path;
            done++;
          } catch (err) {
            failed.push(`${it.path}: ${errorMessage(err)}`);
          }
          continue;
        }
        // Worked out again from the note as it is now, in case it changed since the preview.
        const ok = await app().editNote(
          it.path,
          (t) => {
            if (e.kind === "append") return appendText(t, e.content);
            const r = applyChanges(t, e.changes);
            return "error" in r ? null : r.text;
          },
          `${it.path}: 그사이 노트가 바뀌어 적용하지 못했습니다`,
        );
        if (ok) done++;
        else failed.push(it.path);
      }
      await app().refreshTree();
      app().noteSaved();
      set({ edits: null });
      if (done) {
        const open = created;
        app().toast(
          `노트 ${done}개에 적용했습니다 · 히스토리에서 되돌릴 수 있습니다`,
          "info",
          open ? { label: "새 노트 열기", run: () => app().openNote(open) } : undefined,
        );
      }
      if (failed.length) app().toast(`적용하지 못한 것: ${failed.join(", ")}`, "error");
    },

    closeEdits() {
      const p = get().edits;
      if (p?.applying) return;
      if (p?.streaming) p.handle?.cancel();
      set({ edits: null });
    },

    setWebSearch(on) {
      aiPrefs.setWeb(on);
      set({ webSearch: on });
    },

    async detect(refresh = false) {
      const providers = await api.aiProviders(refresh).catch(() => [] as AiProvider[]);
      set({ providers });
    },

    async login(id) {
      if (get().loggingIn) return app().toast("이미 로그인 창이 열려 있습니다. 그 창에서 로그인을 마쳐 주세요", "error");
      const name = get().providers?.find((p) => p.id === id)?.name ?? id;
      set({ loggingIn: id });
      app().toast(`${name} 로그인 창을 열었습니다. 브라우저에서 로그인을 마치면 자동으로 연결됩니다`);
      try {
        const p = await api.aiLogin(id);
        set({ providers: (get().providers ?? []).map((x) => (x.id === p.id ? p : x)) });
        if (p.logged_in === false) {
          app().toast(`${name} 로그인이 끝나지 않았습니다. 다시 시도해 주세요`, "error", {
            label: "다시 로그인",
            run: () => void get().login(id),
          });
        } else {
          if (get().current()?.id !== id) get().setProvider(id);
          // The "not logged in" notices no longer apply.
          app()
            .toasts.filter((t) => t.message.includes("로그인되어 있지 않습니다"))
            .forEach((t) => app().dismissToast(t.id));
          app().toast(`${name}에 연결했습니다`);
        }
      } catch (e) {
        app().toast(errorMessage(e), "error");
      } finally {
        set({ loggingIn: null });
      }
    },

    setEnabled(on) {
      aiPrefs.setEnabled(on);
      set({ enabled: on });
      if (on && !get().providers) void get().detect();
    },

    setProvider(id) {
      aiPrefs.setProvider(id);
      set({ providerId: id });
    },

    setModel(provider, model) {
      aiPrefs.setModel(provider, model);
      set({ models: { ...get().models, [provider]: model.trim() } });
    },

    current() {
      return pickProvider(get().providers ?? [], get().providerId);
    },

    confirmSend(req) {
      return new Promise((resolve) => set({ send: { ...req, resolve } }));
    },

    async ask(question) {
      const q = question.trim();
      if (!q || get().running) return;
      const provider = await ready();
      if (!provider) return;
      const related = await relatedNotes(q);
      const paths = await get().confirmSend({
        provider,
        title: "질문 보내기",
        ...related,
        extra: { label: "질문", text: q },
        web: true,
      });
      if (paths === null) return;
      const web = get().webSearch;
      const history = get()
        .chat.filter((m) => !m.error && !m.streaming)
        .map((m) => ({ role: m.role, text: m.text }));
      const idx = get().chat.length + 1;
      set({ chat: [...get().chat, { role: "user", text: q, sources: paths }, { role: "ai", text: "", streaming: true, question: q, sources: paths, provider: provider.id }] });
      const update = (patch: Partial<ChatMessage>) =>
        set({ chat: get().chat.map((m, i) => (i === idx ? { ...m, ...patch } : m)) });
      const handle = runAi(
        provider.id,
        qaSystem(web),
        chatPrompt(history, q),
        paths,
        (text) => update({ text }),
        (m) => app().toast(m),
        (model) => update({ model }),
        {
          web,
          onProgress: (m) => update({ progress: [...(get().chat[idx]?.progress ?? []), ...m.split("\n")] }),
        },
      );
      set({ running: handle });
      try {
        const { text } = await handle.done;
        update({ text, streaming: false });
      } catch (e) {
        update({ streaming: false, error: errorMessage(e) });
      } finally {
        set({ running: null });
      }
    },

    stop() {
      get().running?.cancel();
    },

    newChat() {
      if (get().running) return;
      set({ chat: [] });
    },

    async saveAnswer(index) {
      const m = get().chat[index];
      if (!m || m.role !== "ai" || !m.text) return;
      const cfg = app().config;
      // An answer researched on the web goes with the research notes.
      const usedWeb = (m.progress?.length ?? 0) > 0;
      const dir = cfg.preset_enabled ? (usedWeb ? cfg.research_folder : cfg.inbox_folder) : "";
      const sources = (m.sources ?? []).map((p) => `- [[${noteTitle(p)}]]`).join("\n") || "- (없음)";
      const body = `# 질문\n\n${m.question ?? ""}\n\n# 답변\n\n${m.text}\n\n## 참고한 노트\n\n${sources}\n`;
      try {
        const path = await api.createNote(dir, `AI 답변 ${stamp()}`, body);
        await app().refreshTree();
        app().toast("답변을 노트로 저장했습니다", "info", { label: "열기", run: () => app().openNote(path) });
      } catch (e) {
        app().toast(`저장하지 못했습니다: ${errorMessage(e)}`, "error");
      }
    },

    async write(task) {
      const editor = app().editorApi;
      const path = app().openPath;
      if (!editor || !path) return app().toast("먼저 노트를 열고 글을 선택하세요", "error");
      // Private first: the open note may carry the tag in text not saved yet, so check the editor text too.
      const privateNow = /(^|\s)#비공개(\/|\s|$)/m.test(app().docText ?? "");
      const privateSaved = (await api.aiPrivateNotes([path]).catch(() => [path])).length > 0;
      if (privateNow || privateSaved) return app().toast("#비공개 태그가 있는 노트라 AI로 보내지 않습니다", "error");
      const sel = editor.selection();
      if (!sel.text.trim()) return app().toast("AI에 보낼 글이 없습니다. 글을 선택하거나 문단 안에 커서를 두세요", "error");
      const provider = await ready();
      if (!provider) return;
      const title = noteTitle(path);
      const ok = await get().confirmSend({
        provider,
        title: `AI ${WRITE_LABEL[task]}`,
        notes: [],
        checked: [],
        extra: { label: sel.whole ? "현재 문단" : "선택한 글", text: sel.text },
      });
      if (ok === null) return;
      const handle = runAi(provider.id, WRITE_SYSTEM, writePrompt(task, title, sel.text), [], (text) =>
        set({ preview: get().preview && { ...get().preview!, result: text } }),
      );
      set({
        preview: {
          title: `AI ${WRITE_LABEL[task]}`,
          mode: "edit",
          original: sel.text,
          result: "",
          streaming: true,
          error: null,
          from: sel.from,
          to: sel.to,
          handle,
        },
      });
      try {
        const { text } = await handle.done;
        if (get().preview?.handle === handle) set({ preview: { ...get().preview!, result: text, streaming: false } });
      } catch (e) {
        if (get().preview?.handle === handle) set({ preview: { ...get().preview!, streaming: false, error: errorMessage(e) } });
      }
    },

    async weeklyReview() {
      const cfg = app().config;
      const { from, to, label } = weekRange();
      const paths = journalNotesInRange(
        app().notes.map((n) => n.path),
        cfg.journal_folder,
        from,
        to,
      );
      if (!paths.length) return app().toast(`이번 주(${from} ~ ${to}) 업무일지가 없습니다`, "error");
      const provider = await ready();
      if (!provider) return;
      const privatePaths = new Set(await api.aiPrivateNotes(paths).catch(() => paths));
      const shareable = paths.filter((p) => !privatePaths.has(p));
      if (!shareable.length) return app().toast("이번 주 업무일지가 모두 #비공개라 보낼 수 없습니다", "error");
      const notes: ContextNote[] = await Promise.all(
        shareable.map(async (p) => {
          const text = await api.readNote(p).catch(() => "");
          return { path: p, title: noteTitle(p), snippet: text.replace(/\s+/g, " ").slice(0, 120), chars: [...text].length };
        }),
      );
      const send = await get().confirmSend({
        provider,
        title: `주간 회고 만들기 (${from} ~ ${to})`,
        notes,
        checked: shareable,
        privateExcluded: privatePaths.size,
      });
      if (send === null) return;
      if (!send.length) return app().toast("보낼 업무일지를 하나 이상 고르세요", "error");
      const handle = runAi(provider.id, REVIEW_SYSTEM, reviewPrompt(`${from} ~ ${to}`), send, (text) =>
        set({ preview: get().preview && { ...get().preview!, result: text } }),
      );
      set({
        preview: {
          title: `주간 회고 ${label}`,
          mode: "note",
          original: "",
          result: "",
          streaming: true,
          error: null,
          from: 0,
          to: 0,
          noteName: `주간 회고 ${label}`,
          noteDir: cfg.journal_folder,
          handle,
        },
      });
      try {
        const { text } = await handle.done;
        if (get().preview?.handle === handle) set({ preview: { ...get().preview!, result: text, streaming: false } });
      } catch (e) {
        if (get().preview?.handle === handle) set({ preview: { ...get().preview!, streaming: false, error: errorMessage(e) } });
      }
    },

    closePreview() {
      const p = get().preview;
      if (p?.streaming) p.handle?.cancel();
      set({ preview: null });
    },

    async applyPreview(how, text) {
      const p = get().preview;
      if (!p) return;
      if (how === "note") {
        try {
          // Same topic again: "이름 1", "이름 2"… instead of failing on the taken name.
          const dir = p.noteDir ?? "";
          const base = p.noteName ?? `AI ${stamp()}`;
          const taken = new Set(app().notes.map((n) => n.path.toLowerCase()));
          const at = (name: string) => `${dir ? dir + "/" : ""}${name}.md`.toLowerCase();
          let name = base;
          for (let n = 1; taken.has(at(name)); n++) name = `${base} ${n}`;
          const path = await api.createNote(dir, name, text.endsWith("\n") ? text : text + "\n");
          set({ preview: null });
          await app().refreshTree();
          app().openNote(path);
        } catch (e) {
          app().toast(`노트를 만들지 못했습니다: ${errorMessage(e)}`, "error");
        }
        return;
      }
      const editor = app().editorApi;
      if (!editor) return app().toast("노트가 닫혀 적용하지 못했습니다", "error");
      const ok =
        how === "replace" ? editor.replace(p.from, p.to, text, p.original) : editor.replace(p.to, p.to, `\n\n${text}`, "");
      if (!ok) return app().toast("그사이 글이 바뀌어 적용하지 못했습니다. 다시 실행해 주세요", "error");
      set({ preview: null });
    },
  };
});
