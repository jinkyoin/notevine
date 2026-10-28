// SCR-04 편집기: 라이브 미리보기 마크다운 편집, 1초 자동 저장, Ctrl+S 수동 저장.
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
import { noteHighlight } from "../editor/highlight";
import { refreshLinks, wikiLinks } from "../editor/wikilinks";
import { openUrl } from "@tauri-apps/plugin-opener";
import { findNode } from "../lib/tree";

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

export function Editor({ path }: { path: string }) {
  const host = useRef<HTMLDivElement>(null);
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [loadError, setLoadError] = useState<string | null>(null);
  const setFlushEditor = useApp((s) => s.setFlushEditor);
  const toast = useApp((s) => s.toast);

  useEffect(() => {
    let view: EditorView | null = null;
    let timer: number | undefined;
    let dirty = false;
    let disposed = false;
    let saving: Promise<void> = Promise.resolve();
    let docTimer: number | undefined;
    const { setDocText, setEditText } = useApp.getState();
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
            toast(`노트는 저장했지만 히스토리·인덱스를 갱신하지 못했습니다: ${warning}`, "error");
          }
          if (conflict) {
            // Disk kept the other program's version; show it and point to our copy (NFR-REL-02).
            const { refreshTree, openNote } = useApp.getState();
            toast(`다른 프로그램이 이 노트를 동시에 고쳤습니다. 내 변경은 "${conflict}"로 저장했습니다`, "error", {
              label: "열기",
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
          toast(`저장하지 못했습니다: ${errorMessage(e)}`, "error");
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
        reload().catch((e) => toast(`노트를 다시 읽지 못했습니다: ${errorMessage(e)}`, "error"));
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
              history(),
              drawSelection(),
              EditorView.lineWrapping,
              EditorView.contentAttributes.of({ spellcheck: "false", autocorrect: "off" }),
              markdown({ base: markdownLanguage, codeLanguages: languages }),
              syntaxHighlighting(noteHighlight),
              livePreview,
              livePreviewTheme,
              frontmatterFold,
              wikiLinks({
                path: () => path,
                notes: () => useApp.getState().notes,
                follow: (target) => void useApp.getState().followLink(target),
                openPath: (p) => {
                  const st = useApp.getState();
                  if (findNode(st.tree, p)) st.openNote(p);
                  else st.toast(`파일을 찾을 수 없습니다: ${p}`, "error");
                },
                openUrl: (url) => void openUrl(url).catch(() => {}),
              }),
              keymap.of([
                { key: "Mod-s", run: () => (void save(true), true), preventDefault: true },
                indentWithTab,
                ...defaultKeymap,
                ...historyKeymap,
              ]),
              EditorView.updateListener.of((u) => {
                if (!u.docChanged) return;
                window.clearTimeout(docTimer);
                docTimer = window.setTimeout(publishText, DOC_TEXT_DELAY_MS);
                if (applyingExternal) return;
                dirty = true;
                setSaveState("dirty");
                window.clearTimeout(timer);
                timer = window.setTimeout(() => save(), SAVE_DELAY_MS);
              }),
            ],
          }),
        });
        // Coming from a backlink: put the cursor on the linking line.
        const jump = useApp.getState().jumpLine;
        if (jump && jump <= view.state.doc.lines) {
          const at = view.state.doc.line(jump).from;
          view.dispatch({ selection: { anchor: at }, effects: EditorView.scrollIntoView(at, { y: "center" }) });
        } else {
          // Start below the properties so they stay folded (SCR-04).
          const fmEnd = frontmatterEnd(view.state);
          if (fmEnd) view.dispatch({ selection: { anchor: Math.min(fmEnd, view.state.doc.length) } });
        }
        publishText();
        setEditText((fn) => {
          if (!view) return false;
          const cur = view.state.doc.toString();
          const next = fn(cur);
          if (next === null) return false;
          if (next !== cur) view.dispatch({ changes: minimalChange(cur, next), userEvent: "input.properties" });
          return true;
        });
        // A new note opens with its name being typed in the tree; don't steal that focus.
        if (!useApp.getState().editing) view.focus();
      })
      .catch((e) => !disposed && setLoadError(errorMessage(e)));

    setFlushEditor((force) => save(force));

    return () => {
      void save();
      disposed = true;
      window.clearTimeout(docTimer);
      setDocText(null);
      setEditText(() => false);
      unsubscribe();
      unsubscribeNotes();
      setFlushEditor(async () => {});
      view?.destroy();
    };
  }, [path, setFlushEditor, toast]);

  return (
    <div className="editor">
      <div className="editor-head">
        <h1 className="note-title">{noteTitle(path)}</h1>
        <span className={`save-state ${saveState}`}>
          {saveState === "saved" && "√ 저장됨"}
          {saveState === "dirty" && "편집 중"}
          {saveState === "saving" && "저장 중…"}
          {saveState === "error" && "저장 실패"}
        </span>
      </div>
      {loadError ? <p className="error pad">노트를 열지 못했습니다: {loadError}</p> : <div className="cm-host" ref={host} />}
    </div>
  );
}
