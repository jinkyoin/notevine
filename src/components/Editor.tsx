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
import { livePreview, livePreviewTheme } from "../editor/livePreview";
import { noteHighlight } from "../editor/highlight";

const SAVE_DELAY_MS = 1000;

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

    /** Writes the note. `force` (Ctrl+S, app exit) always lands in a history version. */
    const save = (force = false) => {
      window.clearTimeout(timer);
      if (!view || (!dirty && !force)) return saving;
      const text = view.state.doc.toString();
      dirty = false;
      setSaveState("saving");
      saving = saving
        .then(() => api.writeNote(path, text, force))
        .then((warning) => {
          if (warning && !historyWarned) {
            historyWarned = true;
            toast(`노트는 저장했지만 히스토리를 남기지 못했습니다: ${warning}`, "error");
          }
          if (!disposed && !dirty) setSaveState("saved");
        })
        .catch((e) => {
          dirty = true;
          setSaveState("error");
          toast(`저장하지 못했습니다: ${errorMessage(e)}`, "error");
        });
      return saving;
    };

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
              keymap.of([
                { key: "Mod-s", run: () => (void save(true), true), preventDefault: true },
                indentWithTab,
                ...defaultKeymap,
                ...historyKeymap,
              ]),
              EditorView.updateListener.of((u) => {
                if (!u.docChanged) return;
                dirty = true;
                setSaveState("dirty");
                window.clearTimeout(timer);
                timer = window.setTimeout(() => save(), SAVE_DELAY_MS);
              }),
            ],
          }),
        });
        // A new note opens with its name being typed in the tree; don't steal that focus.
        if (!useApp.getState().editing) view.focus();
      })
      .catch((e) => !disposed && setLoadError(errorMessage(e)));

    setFlushEditor((force) => save(force));

    return () => {
      void save();
      disposed = true;
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
