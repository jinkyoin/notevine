// SCR-14 템플릿 선택 (Ctrl+N): 빈 노트 + 템플릿 폴더의 노트. 템플릿의 folder 속성을 기본 위치로 제안한다.
// 같은 목록으로 '템플릿 삽입'도 한다: 고른 템플릿을 열린 노트의 커서 위치에 넣는다.
import { useEffect, useState } from "react";
import { api, type TemplateRef } from "../api";
import { useApp } from "../store";
import { findNode } from "../lib/tree";

import { tx } from "../i18n";
export function TemplatePicker() {
  const modal = useApp((s) => s.modal);
  const setModal = useApp((s) => s.setModal);
  if (modal === "template") return <Picker close={() => setModal(null)} />;
  if (modal === "insertTemplate") return <InsertPicker close={() => setModal(null)} />;
  return null;
}

interface Option {
  label: string;
  preview: string;
  /** Shown on the right: the folder a new note goes to. */
  note?: string;
}

/** The ↑↓/Enter list both pickers show. */
function TemplateList({ head, options, choose, close }: { head: React.ReactNode; options: Option[]; choose: (i: number) => void; close: () => void }) {
  const [sel, setSel] = useState(0);
  return (
    <div
      className="modal-backdrop top"
      onMouseDown={close}
      onKeyDown={(e) => {
        if (e.key === "Escape") close();
        else if (e.key === "ArrowDown") setSel((s) => Math.min(s + 1, options.length - 1));
        else if (e.key === "ArrowUp") setSel((s) => Math.max(s - 1, 0));
        else if (e.key === "Enter") choose(sel);
        else return;
        e.preventDefault();
      }}
    >
      <div className="palette" onMouseDown={(e) => e.stopPropagation()}>
        <div className="memo-head">{head}</div>
        <ul className="palette-list templates" tabIndex={-1} ref={(el) => el?.focus()}>
          {options.map((o, i) => (
            <li key={o.label + i} className={i === sel ? "sel" : ""} onMouseEnter={() => setSel(i)} onClick={() => choose(i)}>
              <div>
                <div>{o.label}</div>
                {o.preview && <div className="muted small tpl-preview">{o.preview}</div>}
              </div>
              {o.note !== undefined && <span className="muted small">{o.note}</span>}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function InsertPicker({ close }: { close: () => void }) {
  const [templates, setTemplates] = useState<TemplateRef[] | null>(null);
  const folder = useApp((s) => s.config.template_folder);

  useEffect(() => {
    api
      .listTemplates()
      .then(setTemplates)
      .catch(() => setTemplates([]));
  }, []);

  if (templates === null) return null;
  if (templates.length === 0) {
    return (
      <div className="modal-backdrop top" onMouseDown={close} onKeyDown={(e) => e.key === "Escape" && close()}>
        <div className="palette" tabIndex={-1} ref={(el) => el?.focus()} onMouseDown={(e) => e.stopPropagation()}>
          <div className="memo-head">{tx("템플릿 삽입")}</div>
          <p className="muted small tpl-empty">{tx("'{0}' 폴더에 템플릿이 없습니다. 이 폴더에 .md 파일을 넣으면 템플릿이 됩니다.", folder)}</p>
        </div>
      </div>
    );
  }
  return (
    <TemplateList
      head={
        <>
          {tx("템플릿 삽입")}{" "} <span className="muted small">{tx("커서 위치에 넣습니다 · ↑↓ 선택 · Enter")}</span>
        </>
      }
      options={templates.map((t) => ({ label: t.title, preview: t.preview }))}
      choose={(i) => {
        const t = templates[i];
        if (!t) return;
        close();
        void useApp.getState().insertTemplate(t.path);
      }}
      close={close}
    />
  );
}

function Picker({ close }: { close: () => void }) {
  const [templates, setTemplates] = useState<TemplateRef[]>([]);
  /** Second step: the chosen option, waiting for a name so {{title}} renders right. */
  const [chosen, setChosen] = useState<number | null>(null);
  const [name, setName] = useState("");
  const { createFromTemplate, currentDir, tree } = useApp.getState();
  const here = currentDir();

  useEffect(() => {
    api
      .listTemplates()
      .then((t) => {
        setTemplates(t);
        // Nothing to choose from: skip straight to naming a blank note.
        if (t.length === 0) setChosen(0);
      })
      .catch(() => setChosen(0));
  }, []);

  const options: { label: string; preview: string; template: string | null; dir: string }[] = [
    { label: tx("빈 노트"), preview: "", template: null, dir: here },
    ...templates.map((t) => ({
      label: t.title,
      preview: t.preview,
      template: t.path,
      // Suggested folder from the template, if it exists; else where the user is.
      dir: t.folder && findNode(tree, t.folder) ? t.folder : here,
    })),
  ];

  const choose = (i: number) => {
    if (options[i]) setChosen(i);
  };
  const create = () => {
    const o = chosen === null ? undefined : options[chosen];
    if (!o) return;
    close();
    void createFromTemplate(o.dir, o.template, name);
  };

  if (chosen !== null) {
    const o = options[chosen];
    return (
      <div className="modal-backdrop top" onMouseDown={close}>
        <div className="palette" onMouseDown={(e) => e.stopPropagation()}>
          <div className="memo-head">
            {o.label} <span className="muted small">→ {o.dir || tx("맨 위 폴더")}</span>
          </div>
          <input
            className="palette-input"
            autoFocus
            placeholder={tx("노트 이름 (비우면 제목 없음)")}
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing) return;
              if (e.key === "Escape") setChosen(null);
              else if (e.key === "Enter") create();
              else return;
              e.preventDefault();
            }}
          />
        </div>
      </div>
    );
  }

  return (
    <TemplateList
      head={
        <>
          {tx("새 노트")}{" "} <span className="muted small">{tx("↑↓ 선택 · Enter 만들기")}</span>
        </>
      }
      options={options.map((o) => ({ label: o.label, preview: o.preview, note: o.dir || tx("맨 위 폴더") }))}
      choose={choose}
      close={close}
    />
  );
}
