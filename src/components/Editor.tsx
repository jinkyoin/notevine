// SCR-04 편집기: 라이브 미리보기 마크다운 편집, 1초 자동 저장, Ctrl+S 수동 저장.
// 위쪽 서식 막대로 마크다운을 넣고, 읽기 모드(Ctrl+E)로 서식이 적용된 노트를 본다.
import { useEffect, useRef, useState } from "react";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap, drawSelection } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { syntaxHighlighting } from "@codemirror/language";
import { api, errorMessage } from "../api";
import { useApp } from "../store";
import { noteTitle } from "../lib/tree";
import { frontmatterEnd, livePreview, livePreviewTheme } from "../editor/livePreview";
import { frontmatterFold } from "../editor/frontmatterFold";
import { attachments, dropFilesOn, linkFor, TREE_DRAG_TYPE } from "../editor/attachments";
import { noteHighlight } from "../editor/highlight";
import { refreshLinks, wikiLinks } from "../editor/wikilinks";
import { openUrl } from "@tauri-apps/plugin-opener";
import { findNode } from "../lib/tree";
import { toggleLines, toggleWrap, webLink } from "../editor/format";
import { colorSpans } from "../editor/colors";
import { koDate } from "../editor/koDate";
import { toggleTask } from "../lib/renderNote";
import { viewKey } from "../lib/vaultMemory";
import { switchGuard } from "../editor/switchGuard";
import { FormatBar, ModeSwitch, type FormatAction } from "./FormatBar";
import { NoteView } from "./NoteView";
import { NoteTags } from "./NoteTags";

import { tx } from "../i18n";
const SAVE_DELAY_MS = 1000;
const DOC_TEXT_DELAY_MS = 250;

/** Smallest single change turning `a` into `b`, so the cursor and undo history stay sensible. */
function minimalChange(a: string, b: string) {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  return { from: start, to: endA, insert: b.slice(start, endB) };
}

type SaveState = "saved" | "dirty" | "saving" | "error";

let historyWarned = false;

/** Cursor and scroll of notes shown before, so going back to a tab finds them as they were. */
const viewMemory = new Map<string, { anchor: number; head: number; top: number }>();

/** The note's name above the editor; click it (or F2, unless `f2` is off) to rename the note. */
function NoteTitle({ path, f2 = true }: { path: string; f2?: boolean }) {
  const title = noteTitle(path);
  const editSeq = useApp((s) => s.titleEditSeq);
  const [editing, setEditing] = useState(false);
  const startSeq = useRef(editSeq);
  const done = useRef(false);

  useEffect(() => {
    if (f2 && editSeq !== startSeq.current) setEditing(true);
  }, [editSeq, f2]);

  if (!editing) {
    return (
      <h1
        className="note-title editable"
        title={tx("눌러서 이름 바꾸기 (F2)")}
        onClick={() => {
          done.current = false;
          setEditing(true);
        }}
      >
        {title}
      </h1>
    );
  }

  const finish = (value: string | null) => {
    if (done.current) return;
    done.current = true;
    setEditing(false);
    const name = value?.trim();
    if (name && name !== title) void useApp.getState().rename(path, name);
  };
  return (
    <input
      className="note-title note-title-input"
      aria-label={tx("노트 이름")}
      defaultValue={title}
      ref={(el) => {
        if (el && document.activeElement !== el) {
          done.current = false;
          el.focus();
          el.select();
        }
      }}
      onKeyDown={(e) => {
        if (e.nativeEvent.isComposing) return;
        if (e.key === "Enter") finish(e.currentTarget.value);
        else if (e.key === "Escape") finish(null);
        else return;
        e.preventDefault();
      }}
      onBlur={(e) => finish(e.currentTarget.value)}
    />
  );
}

/**
 * Edits a note. `side`: the split view's right pane, which keeps its own read mode
 * and saving and leaves the shared hooks (AI, properties panel, F2, jumps) to the main editor.
 */
export function Editor({ path, side = false }: { path: string; side?: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef<HTMLDivElement>(null);
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [loadError, setLoadError] = useState<string | null>(null);
  const setFlushEditor = useApp((s) => s.setFlushEditor);
  const toast = useApp((s) => s.toast);
  const sharedReadMode = useApp((s) => s.readMode);
  const setSharedReadMode = useApp((s) => s.setReadMode);
  const [sideReadMode, setSideReadMode] = useState(false);
  const readMode = side ? sideReadMode : sharedReadMode;
  const setReadMode = side ? setSideReadMode : setSharedReadMode;
  const viewRef = useRef<EditorView | null>(null);
  const readModeRef = useRef(readMode);
  // Text shown in read mode (kept in step with the editor while reading).
  const [readText, setReadText] = useState<string | null>(null);

  useEffect(() => {
    readModeRef.current = readMode;
    const v = viewRef.current;
    if (!v) return;
    if (readMode) setReadText(v.state.doc.toString());
    else v.focus();
  }, [readMode]);

  // A jump within this note ([[#제목]], a search hit here): the note is already
  // loaded, so move the cursor now. Jumps into a newly opened note happen on load.
  const jumpSeq = useApp((s) => s.jumpSeq);
  const seenJump = useRef(jumpSeq);
  useEffect(() => {
    if (side || jumpSeq === seenJump.current) return;
    seenJump.current = jumpSeq;
    const v = viewRef.current;
    const line = useApp.getState().jumpLine;
    if (!v || !line || line > v.state.doc.lines) return;
    const at = v.state.doc.line(line).from;
    v.dispatch({ selection: { anchor: at }, effects: EditorView.scrollIntoView(at, { y: "start", yMargin: 40 }) });
    if (!readModeRef.current) v.focus();
  }, [jumpSeq, side]);

  const applyFormat = (a: FormatAction) => {
    const v = viewRef.current;
    if (!v || readModeRef.current) return;
    v.dispatch(a(v.state));
    v.focus();
  };

  const toggleTaskAt = (index: number) => {
    const v = viewRef.current;
    if (!v) return;
    const cur = v.state.doc.toString();
    const next = toggleTask(cur, index);
    if (next !== null) v.dispatch({ changes: minimalChange(cur, next), userEvent: "input.task" });
  };

  useEffect(() => {
    let view: EditorView | null = null;
    let timer: number | undefined;
    let dirty = false;
    let disposed = false;
    let saving: Promise<void> = Promise.resolve();
    let docTimer: number | undefined;
    // The right pane leaves the shared hooks alone: they belong to the main editor.
    const { setDocText, setEditText, setEditorApi } = side
      ? { setDocText: () => {}, setEditText: () => {}, setEditorApi: () => {} }
      : useApp.getState();
    const scrollEl = scroller.current;
    // Taken now: by cleanup another note folder may already be open (FR-VLT-07).
    const memoryKey = viewKey(useApp.getState().vault?.root ?? "", path);
    // Read on scroll: by cleanup the editor may already be off the page and read as 0.
    let top = 0;
    const onScroll = () => scrollEl && (top = scrollEl.scrollTop);
    scrollEl?.addEventListener("scroll", onScroll, { passive: true });
    const publishText = () => view && setDocText(view.state.doc.toString());

    /** Writes the note. `force` (Ctrl+S, app exit) always lands in a history version. */
    const save = (force = false) => {
      window.clearTimeout(timer);
      if (!view || (!dirty && !force)) return saving;
      const text = view.state.doc.toString();
      dirty = false;
      setSaveState("saving");
      saving = saving
        .then(() => api.writeNote(path, text, force))
        .then(async ({ warning, conflict }) => {
          if (warning && !historyWarned) {
            historyWarned = true;
            toast(tx("노트는 저장했지만 히스토리·인덱스를 갱신하지 못했습니다: {0}", warning), "error");
          }
          if (conflict) {
            // Disk kept the other program's version; show it and point to our copy (NFR-REL-02).
            const { refreshTree, openNote } = useApp.getState();
            toast(tx("다른 프로그램이 이 노트를 동시에 고쳤습니다. 내 변경은 \"{0}\"로 저장했습니다", conflict), "error", {
              label: tx("열기"),
              run: () => openNote(conflict),
            });
            await refreshTree();
            if (!disposed && !dirty) await reload();
          }
          if (!disposed && !dirty) setSaveState("saved");
          useApp.getState().noteSaved();
        })
        .catch((e) => {
          dirty = true;
          setSaveState("error");
          toast(tx("저장하지 못했습니다: {0}", errorMessage(e)), "error");
        });
      return saving;
    };

    /** Replaces the editor text with the file on disk without treating it as an edit. */
    let applyingExternal = false;
    const reload = async () => {
      const text = await api.readNote(path);
      if (!view || disposed || text === view.state.doc.toString()) return;
      const head = Math.min(view.state.selection.main.head, text.length);
      applyingExternal = true;
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text }, selection: { anchor: head } });
      applyingExternal = false;
    };

    // Link styles depend on which notes exist.
    const unsubscribeNotes = useApp.subscribe((s, prev) => {
      if (s.notes !== prev.notes) view?.dispatch({ effects: refreshLinks.of(null) });
    });

    // Another program changed this note: reload unless there are unsaved edits,
    // in which case the next save reports a conflict instead of overwriting.
    const unsubscribe = useApp.subscribe((s, prev) => {
      if (s.externalSeq !== prev.externalSeq && s.externalPaths.includes(path) && !dirty) {
        reload().catch((e) => toast(tx("노트를 다시 읽지 못했습니다: {0}", errorMessage(e)), "error"));
      }
    });

    setLoadError(null);
    setSaveState("saved");
    api
      .readNote(path)
      .then((text) => {
        if (disposed || !host.current) return;
        view = new EditorView({
          parent: host.current,
          state: EditorState.create({
            doc: text,
            extensions: [
              switchGuard,
              history(),
              drawSelection(),
              EditorView.lineWrapping,
              // Keep the cursor out from under the title and format bar pinned at the top, but only
              // once the note is scrolled under them: CodeMirror also takes the margin off the area
              // where it shows tooltips, and a margin on an unscrolled note hid the [[ suggestions.
              EditorView.scrollMargins.of((view) => {
                const top = pinned.current;
                if (!top) return null;
                const covered = top.getBoundingClientRect().bottom > view.scrollDOM.getBoundingClientRect().top;
                return covered ? { top: top.offsetHeight + 8 } : null;
              }),
              EditorView.contentAttributes.of({ spellcheck: "false", autocorrect: "off" }),
              markdown({ base: markdownLanguage, codeLanguages: languages, extensions: [koDate] }),
              syntaxHighlighting(noteHighlight),
              livePreview,
              livePreviewTheme,
              colorSpans,
              frontmatterFold,
              wikiLinks({
                path: () => path,
                notes: () => useApp.getState().notes,
                follow: (target, heading) => void useApp.getState().followLink(target, heading),
                openPath: (p) => {
                  const st = useApp.getState();
                  const node = findNode(st.tree, p);
                  if (node?.kind === "note") st.openNote(p);
                  else if (node && /\.pdf$/i.test(p)) st.openPdf(p);
                  else if (node) void st.openExternal(p);
                  else st.toast(tx("첨부 파일을 찾을 수 없음: {0}", p), "error");
                },
                openUrl: (url) => void openUrl(url).catch(() => {}),
                clickMode: () => useApp.getState().config.link_click,
                readTarget: async (target) => {
                  const found = await api.resolveLink(target).catch(() => null);
                  if (!found) return null;
                  // An open note may have edits not saved yet.
                  if (found === useApp.getState().openPath) await useApp.getState().flushEditor();
                  const text = await api.readNote(found).catch(() => null);
                  return text === null ? null : { path: found, text };
                },
                editTarget: (p, fn) => useApp.getState().editNote(p, fn, tx("블록 ID를 넣지 못했습니다")),
                tags: () => api.allTags().catch(() => []),
              }),
              attachments({
                path: () => path,
                folder: () => useApp.getState().config.attachment_folder,
                save: async (name, data) => {
                  const rel = await api.saveAttachment(name, data, useApp.getState().config.attachment_folder);
                  void useApp.getState().refreshTree();
                  return rel;
                },
                resolve: (target) => api.resolveAttachment(target, path),
                absPath: (rel) => api.attachmentPath(rel),
                error: (m) => useApp.getState().toast(m, "error"),
                linkTo: (p) => {
                  const { tree, notes } = useApp.getState();
                  const node = findNode(tree, p);
                  return node && node.kind !== "folder" ? linkFor(p, notes) : null;
                },
              }),
              keymap.of([
                { key: "Mod-s", run: () => (void save(true), true), preventDefault: true },
                ...(
                  [
                    ["Mod-b", (s) => toggleWrap(s, "**")],
                    ["Mod-i", (s) => toggleWrap(s, "*")],
                    ["Mod-Shift-x", (s) => toggleWrap(s, "~~")],
                    ["Mod-Shift-h", (s) => toggleWrap(s, "==")],
                    ["Mod-`", (s) => toggleWrap(s, "`")],
                    ["Mod-l", (s) => toggleLines(s, "task")],
                    ["Mod-k", webLink],
                  ] as [string, FormatAction][]
                ).map(([key, a]) => ({ key, run: (v: EditorView) => (v.dispatch(a(v.state)), true), preventDefault: true })),
                indentWithTab,
                ...defaultKeymap,
                ...historyKeymap,
              ]),
              EditorView.updateListener.of((u) => {
                if (!u.docChanged) return;
                if (readModeRef.current) setReadText(u.state.doc.toString());
                window.clearTimeout(docTimer);
                docTimer = window.setTimeout(publishText, DOC_TEXT_DELAY_MS);
                if (applyingExternal) return;
                dirty = true;
                setSaveState("dirty");
                window.clearTimeout(timer);
                timer = window.setTimeout(() => save(), useApp.getState().config.autosave_ms || SAVE_DELAY_MS);
              }),
            ],
          }),
        });
        viewRef.current = view;
        // An empty note is for writing, not reading.
        if (!text.slice(frontmatterEnd(view.state)).trim() && readModeRef.current) setReadMode(false);
        else if (readModeRef.current) setReadText(text);
        // Coming from a backlink: put the cursor on the linking line.
        const jump = side ? null : useApp.getState().jumpLine;
        const seen = viewMemory.get(memoryKey);
        if (jump && jump <= view.state.doc.lines) {
          const at = view.state.doc.line(jump).from;
          view.dispatch({ selection: { anchor: at }, effects: EditorView.scrollIntoView(at, { y: "center" }) });
        } else if (seen) {
          // Back to a note shown before (another tab, back/forward): where it was left.
          const len = view.state.doc.length;
          view.dispatch({ selection: { anchor: Math.min(seen.anchor, len), head: Math.min(seen.head, len) } });
          requestAnimationFrame(() => scrollEl && (scrollEl.scrollTop = seen.top));
        } else {
          // Start below the properties so they stay folded (SCR-04).
          const fmEnd = frontmatterEnd(view.state);
          if (fmEnd) view.dispatch({ selection: { anchor: Math.min(fmEnd, view.state.doc.length) } });
        }
        publishText();
        setEditorApi({
          selection: () => {
            if (!view) return { from: 0, to: 0, text: "", whole: false };
            const s = view.state.selection.main;
            if (!s.empty) return { from: s.from, to: s.to, text: view.state.sliceDoc(s.from, s.to), whole: false };
            // No selection: the paragraph around the cursor (lines up to blank lines).
            const doc = view.state.doc;
            let a = doc.lineAt(s.head).number;
            let b = a;
            if (!doc.line(a).text.trim()) return { from: s.head, to: s.head, text: "", whole: true };
            while (a > 1 && doc.line(a - 1).text.trim()) a--;
            while (b < doc.lines && doc.line(b + 1).text.trim()) b++;
            const from = doc.line(a).from;
            const to = doc.line(b).to;
            return { from, to, text: doc.sliceString(from, to), whole: true };
          },
          replace: (from, to, text, expect) => {
            if (!view || to > view.state.doc.length || view.state.sliceDoc(from, to) !== expect) return false;
            view.dispatch({ changes: { from, to, insert: text }, selection: { anchor: from + text.length }, userEvent: "input.ai" });
            view.focus();
            return true;
          },
          rewrite: (fn) => {
            if (!view) return;
            const cur = view.state.doc.toString();
            const r = fn(cur, view.state.selection.main.head);
            view.dispatch({
              changes: minimalChange(cur, r.text),
              selection: { anchor: r.cursor },
              scrollIntoView: true,
              userEvent: "input.template",
            });
            view.focus();
          },
          focus: () => {
            if (view && !readModeRef.current) view.focus();
          },
        });
        setEditText((fn) => {
          if (!view) return false;
          const cur = view.state.doc.toString();
          const next = fn(cur);
          if (next === null) return false;
          if (next !== cur) view.dispatch({ changes: minimalChange(cur, next), userEvent: "input.properties" });
          return true;
        });
        // A new note opens with its name being typed in the tree; don't steal that focus.
        // Nor after a click in the file tree: the keyboard stays there (Delete on the row).
        const inTree = document.activeElement?.closest(".tree") != null;
        if (!useApp.getState().editing && !readModeRef.current && !inTree) view.focus();
      })
      .catch((e) => !disposed && setLoadError(errorMessage(e)));

    setFlushEditor((force) => save(force), side);

    return () => {
      if (view) {
        const sel = view.state.selection.main;
        viewMemory.set(memoryKey, { anchor: sel.anchor, head: sel.head, top });
      }
      scrollEl?.removeEventListener("scroll", onScroll);
      void save();
      disposed = true;
      window.clearTimeout(docTimer);
      setDocText(null);
      setEditText(() => false);
      setEditorApi(null);
      unsubscribe();
      unsubscribeNotes();
      setFlushEditor(async () => {}, side);
      viewRef.current = null;
      setReadText(null);
      view?.destroy();
    };
  }, [path, side, setFlushEditor, toast, setReadMode]);

  return (
    <div
      className="editor"
      ref={scroller}
      // Files from Windows Explorer may land beside or below the text, not only on it.
      onDragOver={(e) => {
        if (!readMode && (e.dataTransfer.types.includes("Files") || e.dataTransfer.types.includes(TREE_DRAG_TYPE))) e.preventDefault();
      }}
      onDrop={(e) => {
        if (!readMode) dropFilesOn(viewRef.current, e.nativeEvent);
      }}
    >
      {/* Title, mode switch and format bar stay on screen while the note scrolls. */}
      <div className="editor-top" ref={pinned}>
        <div className="editor-head">
          <NoteTitle path={path} f2={!side} />
          {!loadError && <ModeSwitch readMode={readMode} setReadMode={setReadMode} />}
          <span className={`save-state ${saveState}`}>
            {saveState === "saved" && tx("√ 저장됨")}
            {saveState === "dirty" && tx("편집 중")}
            {saveState === "saving" && tx("저장 중…")}
            {saveState === "error" && tx("저장 실패")}
          </span>
        </div>
        {!loadError && <FormatBar apply={applyFormat} readMode={readMode} />}
      </div>
      {loadError ? (
        <p className="error pad">{tx("노트를 열지 못했습니다: {0}", loadError)}</p>
      ) : (
        <>
          <div className="cm-host" ref={host} hidden={readMode} />
          {readMode && readText !== null && <NoteView path={path} text={readText} onToggleTask={toggleTaskAt} />}
          <NoteTags path={path} />
          <div
            className="editor-tail"
            // A click below the note puts the cursor at its end, as on an empty page.
            onMouseDown={(e) => {
              const v = viewRef.current;
              if (readMode || !v) return;
              e.preventDefault();
              v.focus();
              v.dispatch({ selection: { anchor: v.state.doc.length }, scrollIntoView: true });
            }}
          />
        </>
      )}
    </div>
  );
}
