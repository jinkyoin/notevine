// SCR-04 편집기 (1일 차 기본형): 마크다운 편집, 1초 자동 저장, Ctrl+S.
// 라이브 미리보기·자동완성은 2·4일 차에 이 위에 붙인다.
import { useEffect, useRef, useState } from "react";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap, drawSelection, highlightActiveLine } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { syntaxHighlighting, defaultHighlightStyle } from "@codemirror/language";
import { api, errorMessage } from "../api";
import { useApp } from "../store";
import { noteTitle } from "../lib/tree";

const SAVE_DELAY_MS = 1000;

type SaveState = "saved" | "dirty" | "saving" | "error";

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

    const save = () => {
      window.clearTimeout(timer);
      if (!view || !dirty) return saving;
      const text = view.state.doc.toString();
      dirty = false;
      setSaveState("saving");
      saving = saving
        .then(() => api.writeNote(path, text))
        .then(() => {
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
              highlightActiveLine(),
              EditorView.lineWrapping,
              markdown({ base: markdownLanguage, codeLanguages: languages }),
              syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
              keymap.of([
                { key: "Mod-s", run: () => (save(), true), preventDefault: true },
                indentWithTab,
                ...defaultKeymap,
                ...historyKeymap,
              ]),
              EditorView.updateListener.of((u) => {
                if (!u.docChanged) return;
                dirty = true;
                setSaveState("dirty");
                window.clearTimeout(timer);
                timer = window.setTimeout(save, SAVE_DELAY_MS);
              }),
            ],
          }),
        });
        // A new note opens with its name being typed in the tree; don't steal that focus.
        if (!useApp.getState().editing) view.focus();
      })
      .catch((e) => !disposed && setLoadError(errorMessage(e)));

    setFlushEditor(() => save());
    const onClose = () => void save();
    window.addEventListener("beforeunload", onClose);

    return () => {
      void save();
      disposed = true;
      window.removeEventListener("beforeunload", onClose);
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
