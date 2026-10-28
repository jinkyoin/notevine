// SCR-12 명령 팔레트 (Ctrl+P): 등록된 모든 명령을 이름으로 찾아 실행한다 (FR-UI-04, FR-EXT-01).
import { useMemo, useState } from "react";
import { availableCommands } from "../commands";
import { useApp } from "../store";

export function CommandPalette() {
  const modal = useApp((s) => s.modal);
  const setModal = useApp((s) => s.setModal);
  if (modal !== "palette") return null;
  return <Palette close={() => setModal(null)} />;
}

function Palette({ close }: { close: () => void }) {
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const items = useMemo(() => {
    const k = q.normalize("NFC").toLowerCase().trim();
    return availableCommands()
      .filter((c) => c.id !== "app.palette")
      .filter((c) => !k || `${c.title} ${c.keywords ?? ""}`.toLowerCase().includes(k) || c.id.includes(k))
      .sort((a, b) => a.title.localeCompare(b.title, "ko"));
  }, [q]);

  const run = (i: number) => {
    const c = items[i];
    if (!c) return;
    close();
    // Let the palette unmount before a command opens another dialog.
    setTimeout(() => void c.run(), 0);
  };

  return (
    <div className="modal-backdrop top" onMouseDown={close}>
      <div className="palette" onMouseDown={(e) => e.stopPropagation()}>
        <input
          className="palette-input"
          autoFocus
          placeholder="명령 찾기"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setSel(0);
          }}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;
            if (e.key === "Escape") close();
            else if (e.key === "ArrowDown") setSel((s) => Math.min(s + 1, items.length - 1));
            else if (e.key === "ArrowUp") setSel((s) => Math.max(s - 1, 0));
            else if (e.key === "Enter") run(sel);
            else return;
            e.preventDefault();
          }}
        />
        <ul className="palette-list">
          {items.map((c, i) => (
            <li key={c.id} className={i === sel ? "sel" : ""} onMouseEnter={() => setSel(i)} onClick={() => run(i)}>
              <span>{c.title}</span>
              {c.keys && <kbd>{c.keys}</kbd>}
            </li>
          ))}
          {items.length === 0 && <li className="muted">맞는 명령이 없습니다</li>}
        </ul>
      </div>
    </div>
  );
}
