// AI 화면 상태와 흐름: 질문(SCR-18), 전송 확인(SCR-19), 작성 결과 미리보기(SCR-20).
import { create } from "zustand";
import { api, errorMessage, type AiProvider, type ContextNote } from "./api";
import {
  aiPrefs,
  asksForTemplate,
  asksForWeb,
  matchTemplate,
  namesWeb,
  supportsWeb,
  writeIntent,
  chatPrompt,
  journalNotesInRange,
  localizeProvider,
  needsLogin,
  pickProvider,
  qaSystem,
  REVIEW_SYSTEM,
  reviewPrompt,
  runAi,
  weekRange,
  withInstructions,
  WRITE_LABEL,
  WRITE_SYSTEM,
  writePrompt,
  type RunHandle,
  type WriteTask,
} from "./ai";
import { useApp } from "./store";
import { findNode, noteTitle } from "./lib/tree";
import { appendText, applyChanges, editSystem, OPEN_NOTE_ALIAS, parseEdits, planEdit, type Edit, type Planned } from "./lib/aiEdits";
import { day } from "./lib/folderTable";
import { entriesUnder } from "./lib/aiAttach";
import { fileText } from "./lib/fileText";

import { tx } from "./i18n";
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
  /** Asked to write something: the answer is the text itself, saved without the question around it. */
  written?: boolean;
  /** Folder for saving, from the template that was followed. */
  saveDir?: string;
  /** Proposed note changes not applied yet; can be opened again. */
  proposal?: EditProposal;
  /** How many notes the proposal changed once applied. */
  applied?: number;
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
  /** Offer the "also search the web" choice. */
  web?: boolean;
  /** Title of the open note the result will be proposed for. */
  target?: string;
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
  /** The AI's explanation outside the blocks. */
  message: string;
  items: EditItem[];
  applying: boolean;
  /** The chat message this came with. */
  chatIndex: number;
}

/** A note, file or folder dropped on the question box, with the notes and file texts it sends. */
export interface Attached {
  path: string;
  notes: string[];
  /** Files other than notes (PDF, Office, ...), their text read when dropped. */
  files?: { path: string; text: string }[];
  /** #비공개 notes in it, left out. */
  privateCount: number;
  /** Files in it whose text could not be read (a scanned PDF, a broken file), left out. */
  unreadCount?: number;
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
  edits: EditProposal | null;
  /** Opens a message's proposed changes again. */
  reviewEdits(index: number): void;
  toggleEdit(index: number, on: boolean): void;
  /** Applies the checked proposals (through the editor or the save path, so history keeps them). */
  applyEdits(): Promise<void>;
  closeEdits(): void;
  /** Questions may also search the web (choice under the question box, remembered). */
  webSearch: boolean;
  setWebSearch(on: boolean): void;
  /** Notes and folders dragged onto the question box: the only notes a question sends (FR-AI-03). */
  attached: Attached[];
  /** Adds a file-tree entry (a note, or a folder's notes) to what questions send. */
  attach(path: string): Promise<void>;
  detach(path: string): void;

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
  /** The panel's box: answers, or proposes note changes for review, as the request calls for. */
  ask(question: string): Promise<void>;
  stop(): void;
  newChat(): void;
  saveAnswer(index: number): Promise<void>;
  write(task: WriteTask): Promise<void>;
  weeklyReview(): Promise<void>;
  closePreview(): void;
  applyPreview(how: "replace" | "below" | "note", text: string): Promise<void>;
  /** The chat and proposals of the open note folder, kept while another folder is shown (FR-VLT-07). */
  snapshot(): unknown;
  /** Puts back what `snapshot` gave, or starts empty for a folder without one. */
  restore(s: unknown): void;
}

const app = () => useApp.getState();

/** Bumped whenever another note folder's AI state is put on screen (FR-VLT-07). */
let folderGen = 0;

/**
 * Wraps a callback of a running AI request so it does nothing once another note folder is
 * shown: a late answer must not land in that folder's chat or proposals.
 */
export function folderBound<A extends unknown[]>(fn: (...a: A) => void): (...a: A) => void {
  const gen = folderGen;
  return (...a) => {
    if (gen === folderGen) fn(...a);
  };
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
      app().toast(tx("AI 도우미가 꺼져 있습니다. 설정 → AI에서 켜 주세요"), "error", {
        label: tx("설정 열기"),
        run: () => app().setModal("settings"),
      });
      return null;
    }
    if (!get().providers) await get().detect();
    const p = get().current();
    if (!p) {
      const loggedOut = (get().providers ?? []).find(needsLogin);
      if (loggedOut) {
        app().toast(tx("{0}에 로그인되어 있지 않습니다", loggedOut.name), "error", {
          label: tx("로그인"),
          run: () => void get().login(loggedOut.id),
        });
      } else {
        app().toast(tx("사용할 수 있는 AI가 없습니다. Claude Code나 Codex CLI를 설치하고 로그인해 주세요"), "error", {
          label: tx("설정 열기"),
          run: () => app().setModal("settings"),
        });
      }
      return null;
    }
    return p;
  }

  /** The template the request asks to follow, as a note to send. undefined: none asked for. null: not usable; said why. */
  async function requestedTemplate(q: string): Promise<(ContextNote & { folder: string | null }) | null | undefined> {
    if (!asksForTemplate(q)) return undefined;
    const templates = await api.listTemplates().catch(() => []);
    const t = matchTemplate(q, templates);
    if (!t) {
      const names = templates.map((x) => x.title).join(", ");
      app().toast(names ? tx("요청한 템플릿을 찾지 못했습니다. 있는 템플릿: {0}", names) : tx("'{0}' 폴더에 템플릿이 없습니다. 이 폴더에 .md 파일을 넣으면 템플릿이 됩니다.", app().config.template_folder), "error");
      return null;
    }
    if ((await api.aiPrivateNotes([t.path]).catch(() => [t.path])).length > 0) {
      app().toast(tx("#비공개 태그가 있는 노트라 AI로 보내지 않습니다"), "error");
      return null;
    }
    const text = await api.readNote(t.path).catch(() => "");
    return { path: t.path, title: t.title, snippet: tx("(템플릿: 이 형식으로 작성합니다)"), chars: [...text].length, relevant: true, folder: t.folder };
  }

  /** The AI's proposals checked against the notes as they are now. `sent`: the only notes it may change. */
  function planEdits(edits: Edit[], sent: Set<string>, target: string | null): Promise<EditItem[]> {
    const byLower = new Map(app().notes.map((n) => [n.path.toLowerCase(), n.path]));
    const actual = (p: string) => byLower.get(p.toLowerCase()) ?? p;
    return Promise.all(
      edits.map(async (e) => {
        const path = target && e.path === OPEN_NOTE_ALIAS ? target : actual(e.path);
        const plan = await planEdit(
          { ...e, path },
          {
            sent,
            exists: (p) => byLower.has(p.toLowerCase()) || !!findNode(app().tree, p),
            read: (p) => api.readNote(actual(p)),
          },
        );
        return { ...plan, path: actual(plan.path), checked: !plan.error };
      }),
    );
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
    edits: null,
    attached: [],

    async attach(path) {
      if (get().attached.some((a) => a.path === path)) return;
      const found = entriesUnder(app().tree, path);
      if (found === null) return app().toast(tx("노트, 폴더, 글자를 읽을 수 있는 파일(PDF·문서·텍스트)만 AI에 보낼 수 있습니다"), "error");
      const { notes } = found;
      const hidden = new Set(notes.length ? await api.aiPrivateNotes(notes).catch(() => notes) : []);
      const sendable = notes.filter((p) => !hidden.has(p));
      // Files are read now, so a scanned PDF is known at once rather than at the question.
      const read = await Promise.all(
        found.files.map((p) =>
          fileText(p).then(
            (text) => ({ path: p, text: text.trim(), error: "" }),
            (e) => ({ path: p, text: "", error: errorMessage(e) }),
          ),
        ),
      );
      const files = read.filter((f) => f.text).map(({ path: p, text }) => ({ path: p, text }));
      const unread = read.filter((f) => !f.text);
      if (!sendable.length && !files.length) {
        if (found.files.length === 1 && !notes.length) {
          return app().toast(unread[0].error || tx("파일에서 글자를 찾지 못했습니다 (그림으로만 된 PDF일 수 있습니다): {0}", noteTitle(path)), "error");
        }
        return app().toast(hidden.size ? tx("#비공개 노트뿐이라 보낼 노트가 없습니다: {0}", noteTitle(path)) : tx("폴더에 보낼 노트나 파일이 없습니다: {0}", noteTitle(path)), "error");
      }
      if (get().attached.some((a) => a.path === path)) return;
      set({ attached: [...get().attached, { path, notes: sendable, files, privateCount: hidden.size, unreadCount: unread.length }] });
    },

    detach(path) {
      set({ attached: get().attached.filter((a) => a.path !== path) });
    },

    reviewEdits(index) {
      const p = get().chat[index]?.proposal;
      if (p) set({ edits: p });
    },

    toggleEdit(index, on) {
      const p = get().edits;
      if (!p) return;
      set({ edits: { ...p, items: p.items.map((it, i) => (i === index && !it.error ? { ...it, checked: on } : it)) } });
    },

    async applyEdits() {
      const p = get().edits;
      if (!p || p.applying) return;
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
          tx("{0}: 그사이 노트가 바뀌어 적용하지 못했습니다", it.path),
        );
        if (ok) done++;
        else failed.push(it.path);
      }
      await app().refreshTree();
      app().noteSaved();
      set({
        edits: null,
        chat: get().chat.map((m, i) => (i === p.chatIndex ? { ...m, proposal: undefined, applied: done } : m)),
      });
      if (done) {
        const open = created;
        app().toast(
          tx("노트 {0}개에 적용했습니다 · 히스토리에서 되돌릴 수 있습니다", done),
          "info",
          open ? { label: tx("새 노트 열기"), run: () => app().openNote(open) } : undefined,
        );
      }
      if (failed.length) app().toast(tx("적용하지 못한 것: {0}", failed.join(", ")), "error");
    },

    closeEdits() {
      const p = get().edits;
      if (p?.applying) return;
      set({ edits: null });
    },

    setWebSearch(on) {
      aiPrefs.setWeb(on);
      set({ webSearch: on });
    },

    async detect(refresh = false) {
      const providers = await api.aiProviders(refresh).catch(() => [] as AiProvider[]);
      set({ providers: providers.map(localizeProvider) });
    },

    async login(id) {
      if (get().loggingIn) return app().toast(tx("이미 로그인 창이 열려 있습니다. 그 창에서 로그인을 마쳐 주세요"), "error");
      const name = get().providers?.find((p) => p.id === id)?.name ?? id;
      set({ loggingIn: id });
      app().toast(tx("{0} 로그인 창을 열었습니다. 브라우저에서 로그인을 마치면 자동으로 연결됩니다", name));
      try {
        const p = await api.aiLogin(id);
        set({ providers: (get().providers ?? []).map((x) => (x.id === p.id ? localizeProvider(p) : x)) });
        if (p.logged_in === false) {
          app().toast(tx("{0} 로그인이 끝나지 않았습니다. 다시 시도해 주세요", name), "error", {
            label: tx("다시 로그인"),
            run: () => void get().login(id),
          });
        } else {
          if (get().current()?.id !== id) get().setProvider(id);
          // The "not logged in" notices no longer apply.
          app()
            .toasts.filter((t) => t.message.includes(tx("{0}에 로그인되어 있지 않습니다", "\u0000").split("\u0000").pop()!))
            .forEach((t) => app().dismissToast(t.id));
          app().toast(tx("{0}에 연결했습니다", name));
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
      const webOnly = asksForWeb(q);
      const wantsWeb = webOnly || namesWeb(q);
      if (wantsWeb && !supportsWeb(provider.id)) {
        app().toast(tx("{0}은(는) 웹 검색을 할 수 없습니다. AI 도우미에서 Claude Code나 Codex로 바꿔 주세요", provider.name), "error");
        return;
      }
      const template = await requestedTemplate(q);
      if (template === null) return;
      await app().flushEditor();
      const intent = writeIntent(q);
      // The writing goes to the open note, unless that note is private: its title stays here too.
      const open = app().openPath;
      const target = intent === "open" && open && !(await api.aiPrivateNotes([open]).catch(() => [open])).length ? open : null;
      // Only what the user put in: notes dropped on the box, the template asked for, and the
      // open note when the request writes into it. Nothing is searched for (FR-AI-03).
      const sent = [
        ...new Set([...(template ? [template.path] : []), ...get().attached.flatMap((a) => a.notes), ...(target ? [target] : [])]),
      ];
      const web = wantsWeb || get().webSearch;
      const cfg = app().config;
      const system = [
        qaSystem(web),
        editSystem({
          // Folder names would go along unasked: a new note goes to the inbox folder instead.
          folders: [],
          newNoteDir: cfg.preset_enabled ? cfg.inbox_folder : "",
          today: day(Date.now()),
          intent,
          target: target ? noteTitle(target) : null,
          template: template && sent.includes(template.path) ? template.path : null,
        }),
      ].join("\n\n");
      const history = get()
        .chat.filter((m) => !m.error && !m.streaming)
        .map((m) => ({ role: m.role, text: m.text }));
      const idx = get().chat.length + 1;
      set({
        chat: [
          ...get().chat,
          { role: "user", text: q, sources: sent },
          {
            role: "ai",
            text: "",
            streaming: true,
            question: q,
            sources: sent,
            provider: provider.id,
            written: intent !== null || !!template,
            saveDir: template?.folder ?? undefined,
          },
        ],
      });
      // Bound to this folder: after a switch, the answer's late parts are dropped (FR-VLT-07).
      const update = folderBound((patch: Partial<ChatMessage>) => set({ chat: get().chat.map((m, i) => (i === idx ? { ...m, ...patch } : m)) }));
      const propose = folderBound((edits: EditProposal) => set({ edits }));
      const finished = folderBound(() => set({ running: null }));
      // Proposal blocks aren't for reading as they arrive: the review shows them.
      const shown = (text: string) => {
        const r = parseEdits(text);
        return r.edits.length ? r.message : text;
      };
      const handle = runAi(
        provider.id,
        withInstructions(system, app().config.ai_instructions),
        chatPrompt(history, q),
        sent,
        (text) => update({ text: shown(text) }),
        (m) => app().toast(m),
        (model) => update({ model }),
        {
          web,
          onProgress: (m) => update({ progress: [...(get().chat[idx]?.progress ?? []), ...m.split("\n")] }),
          files: [...new Map(get().attached.flatMap((a) => a.files ?? []).map((f) => [f.path, f])).values()],
        },
      );
      set({ running: handle });
      try {
        const { text } = await handle.done;
        const { message, edits } = parseEdits(text);
        if (!edits.length) {
          update({ text, streaming: false });
        } else {
          // A template is only followed, and the open note may also be written to when its text wasn't sent.
          const allowed = new Set(sent.filter((p) => p !== template?.path));
          if (target) allowed.add(target);
          const items = await planEdits(edits, allowed, target);
          const proposal: EditProposal = { request: q, message, items, applying: false, chatIndex: idx };
          update({ text: message || tx("노트에 적용할 안을 만들었습니다."), streaming: false, proposal });
          propose(proposal);
        }
      } catch (e) {
        update({ streaming: false, error: errorMessage(e) });
      } finally {
        finished();
      }
    },

    stop() {
      get().running?.cancel();
    },

    newChat() {
      if (get().running) return;
      set({ chat: [], edits: null, attached: [] });
    },

    snapshot() {
      const { chat, edits, preview, attached } = get();
      // An answer or preview still being written stops with the switch: it can't finish in another folder.
      const stopped = chat.map((m) => (m.streaming ? { ...m, streaming: false, error: tx("노트 폴더를 바꿔 답을 멈췄습니다") } : m));
      return { chat: stopped, edits, preview: preview?.streaming ? null : preview, attached };
    },

    restore(s) {
      folderGen++;
      const v = (s ?? {}) as Partial<Pick<AiState, "chat" | "edits" | "preview" | "attached">>;
      set({ chat: v.chat ?? [], edits: v.edits ?? null, preview: v.preview ?? null, attached: v.attached ?? [], running: null });
    },

    async saveAnswer(index) {
      const m = get().chat[index];
      if (!m || m.role !== "ai" || !m.text) return;
      const cfg = app().config;
      // An answer researched on the web goes with the research notes.
      const usedWeb = (m.progress?.length ?? 0) > 0;
      const dir = m.saveDir ?? (cfg.preset_enabled ? (usedWeb ? cfg.research_folder : cfg.inbox_folder) : "");
      const sources = (m.sources ?? []).map((p) => `- [[${noteTitle(p)}]]`).join("\n") || tx("- (없음)");
      const body = m.written ? m.text.replace(/\s*$/, "\n") : tx("# 질문\n\n{0}\n\n# 답변\n\n{1}\n\n## 참고한 노트\n\n{2}\n", m.question ?? "", m.text, sources);
      try {
        await ensureFolder(dir);
        const path = await api.createNote(dir, tx("AI 답변 {0}", stamp()), body);
        await app().refreshTree();
        app().toast(tx("답변을 노트로 저장했습니다"), "info", { label: tx("열기"), run: () => app().openNote(path) });
      } catch (e) {
        app().toast(tx("저장하지 못했습니다: {0}", errorMessage(e)), "error");
      }
    },

    async write(task) {
      const editor = app().editorApi;
      const path = app().openPath;
      if (!editor || !path) return app().toast(tx("먼저 노트를 열고 글을 선택하세요"), "error");
      // Private first: the open note may carry the tag in text not saved yet, so check the editor text too.
      const privateNow = /(^|\s)#비공개(\/|\s|$)/m.test(app().docText ?? "");
      const privateSaved = (await api.aiPrivateNotes([path]).catch(() => [path])).length > 0;
      if (privateNow || privateSaved) return app().toast(tx("#비공개 태그가 있는 노트라 AI로 보내지 않습니다"), "error");
      const sel = editor.selection();
      if (!sel.text.trim()) return app().toast(tx("AI에 보낼 글이 없습니다. 글을 선택하거나 문단 안에 커서를 두세요"), "error");
      const provider = await ready();
      if (!provider) return;
      const title = noteTitle(path);
      const ok = await get().confirmSend({
        provider,
        title: `AI ${WRITE_LABEL[task]}`,
        notes: [],
        checked: [],
        extra: { label: sel.whole ? tx("현재 문단") : tx("선택한 글"), text: sel.text },
      });
      if (ok === null) return;
      const handle = runAi(provider.id, withInstructions(WRITE_SYSTEM, app().config.ai_instructions), writePrompt(task, title, sel.text), [], (text) =>
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
      if (!paths.length) return app().toast(tx("이번 주({0} ~ {1}) 업무일지가 없습니다", from, to), "error");
      const provider = await ready();
      if (!provider) return;
      const privatePaths = new Set(await api.aiPrivateNotes(paths).catch(() => paths));
      const shareable = paths.filter((p) => !privatePaths.has(p));
      if (!shareable.length) return app().toast(tx("이번 주 업무일지가 모두 #비공개라 보낼 수 없습니다"), "error");
      const notes: ContextNote[] = await Promise.all(
        shareable.map(async (p) => {
          const text = await api.readNote(p).catch(() => "");
          return { path: p, title: noteTitle(p), snippet: text.replace(/\s+/g, " ").slice(0, 120), chars: [...text].length, relevant: true };
        }),
      );
      const send = await get().confirmSend({
        provider,
        title: tx("주간 회고 만들기 ({0} ~ {1})", from, to),
        notes,
        checked: shareable,
        privateExcluded: privatePaths.size,
      });
      if (send === null) return;
      if (!send.length) return app().toast(tx("보낼 업무일지를 하나 이상 고르세요"), "error");
      const handle = runAi(provider.id, withInstructions(REVIEW_SYSTEM, app().config.ai_instructions), reviewPrompt(`${from} ~ ${to}`), send, (text) =>
        set({ preview: get().preview && { ...get().preview!, result: text } }),
      );
      set({
        preview: {
          title: tx("주간 회고 {0}", label),
          mode: "note",
          original: "",
          result: "",
          streaming: true,
          error: null,
          from: 0,
          to: 0,
          noteName: tx("주간 회고 {0}", label),
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
          app().toast(tx("노트를 만들지 못했습니다: {0}", errorMessage(e)), "error");
        }
        return;
      }
      const editor = app().editorApi;
      if (!editor) return app().toast(tx("노트가 닫혀 적용하지 못했습니다"), "error");
      const ok =
        how === "replace" ? editor.replace(p.from, p.to, text, p.original) : editor.replace(p.to, p.to, `\n\n${text}`, "");
      if (!ok) return app().toast(tx("그사이 글이 바뀌어 적용하지 못했습니다. 다시 실행해 주세요"), "error");
      set({ preview: null });
    },
  };
});
