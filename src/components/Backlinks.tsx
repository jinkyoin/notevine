// SCR-07 백링크 패널: 현재 노트를 가리키는 노트와 링크가 있는 줄.
import { useEffect, useState } from "react";
import { api, type Backlink } from "../api";
import { useApp } from "../store";

export function Backlinks() {
  const openPath = useApp((s) => s.openPath);
  const savedSeq = useApp((s) => s.savedSeq);
  const externalSeq = useApp((s) => s.externalSeq);
  const notes = useApp((s) => s.notes);
  const openNote = useApp((s) => s.openNote);
  const [links, setLinks] = useState<Backlink[]>([]);

  useEffect(() => {
    if (!openPath) return setLinks([]);
    let stale = false;
    api
      .backlinks(openPath)
      .then((l) => !stale && setLinks(l))
      .catch(() => !stale && setLinks([]));
    return () => {
      stale = true;
    };
  }, [openPath, savedSeq, externalSeq, notes]);

  const groups = new Map<string, Backlink[]>();
  for (const l of links) groups.set(l.path, [...(groups.get(l.path) ?? []), l]);

  return (
    <section className="panel-section">
      <h3 className="panel-heading">
        백링크 <span className="count">{links.length}</span>
      </h3>
      {groups.size === 0 ? (
        <p className="muted small pad">이 노트를 가리키는 링크가 없습니다.</p>
      ) : (
        <ul className="backlinks">
          {[...groups].map(([path, items]) => (
            <li key={path}>
              <div className="bl-title" title={path}>
                {items[0].title}
              </div>
              {items.map((b) => (
                <button key={b.line} className="bl-line" onClick={() => openNote(b.path, b.line)}>
                  {b.context || `${b.line}번째 줄`}
                </button>
              ))}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
