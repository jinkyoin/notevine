// SCR-03 파일 탐색기: 트리, 새 노트·폴더, 우클릭 메뉴, 이름 변경, 드래그 이동.
import { useEffect, useRef, useState } from "react";
import { ask } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { api, type TreeNode } from "../api";
import { useApp } from "../store";
import { baseName, countNotes, findNode, noteTitle, parentPath } from "../lib/tree";
import { paraActions } from "../lib/para";
import { openProps } from "./TabBar";
import { MODE_LABEL } from "./FolderView";
import { TEXT_COLORS } from "../editor/colors";

interface Menu {
  x: number;
  y: number;
  node: TreeNode | null; // null = empty area (vault root)
}

const DRAG_TYPE = "application/x-notevine-path";

export function Explorer() {
  const tree = useApp((s) => s.tree);
  const createNote = useApp((s) => s.createNote);
  const setEditing = useApp((s) => s.setEditing);
  const editing = useApp((s) => s.editing);
  const move = useApp((s) => s.move);
  const [menu, setMenu] = useState<Menu | null>(null);

  return (
    <div className="explorer">
      <div className="pane-toolbar">
        <span className="pane-title">파일</span>
        <button className="icon-btn" title="새 노트" onClick={() => createNote("")}>
          ＋
        </button>
        <button className="icon-btn" title="새 폴더" onClick={() => setEditing({ mode: "new-folder", parent: "" })}>
          ▣
        </button>
      </div>
      <div
        className="tree"
        onContextMenu={(e) => {
          e.preventDefault();
          setMenu({ x: e.clientX, y: e.clientY, node: null });
        }}
        onDragOver={(e) => e.dataTransfer.types.includes(DRAG_TYPE) && e.preventDefault()}
        onDrop={(e) => {
          const from = e.dataTransfer.getData(DRAG_TYPE);
          if (from) move(from, "");
        }}
      >
        {editing?.mode === "new-folder" && editing.parent === "" && <NewFolderRow parent="" depth={0} project={editing.project} />}
        {tree.map((n) => (
          <Row key={n.path} node={n} depth={0} onMenu={setMenu} />
        ))}
        {tree.length === 0 && <p className="muted small pad">노트가 없습니다. ＋로 새 노트를 만드세요.</p>}
      </div>
      {menu && <ContextMenu menu={menu} onClose={() => setMenu(null)} />}
    </div>
  );
}

/** Folders get a ">" chevron that turns down when open. */
function Chevron({ open }: { open: boolean }) {
  return (
    <svg className={`twisty-icon ${open ? "open" : ""}`} viewBox="0 0 16 16" aria-hidden="true">
      <path d="M6 3.5L10.5 8 6 12.5" />
    </svg>
  );
}


/** `color` comes from the nearest colored folder above; a folder's own color wins. */
function Row({ node, depth, onMenu, color }: { node: TreeNode; depth: number; onMenu: (m: Menu) => void; color?: string }) {
  const own = useApp((s) => (node.kind === "folder" ? s.config.folder_colors?.[node.path] : undefined));
  const shown = own ?? color;
  const expanded = useApp((s) => s.expanded.has(node.path));
  const openPath = useApp((s) => s.canvasView ?? s.openPath);
  const editing = useApp((s) => s.editing);
  const toggleFolder = useApp((s) => s.toggleFolder);
  const openNote = useApp((s) => s.openNote);
  const move = useApp((s) => s.move);
  const [dropHover, setDropHover] = useState(false);

  const isFolder = node.kind === "folder";
  const isRenaming = editing?.mode === "rename" && editing.path === node.path;
  const label = node.kind === "note" ? noteTitle(node.path) : node.name;

  return (
    <>
      <div
        className={[
          "tree-row",
          node.kind,
          openPath === node.path ? "active" : "",
          dropHover ? "drop-target" : "",
        ].join(" ")}
        style={{ paddingLeft: 8 + depth * 14, color: shown }}
        draggable={!isRenaming}
        onDragStart={(e) => {
          e.dataTransfer.setData(DRAG_TYPE, node.path);
          e.dataTransfer.effectAllowed = "move";
        }}
        onDragOver={(e) => {
          if (!isFolder || !e.dataTransfer.types.includes(DRAG_TYPE)) return;
          e.preventDefault();
          e.stopPropagation();
          setDropHover(true);
        }}
        onDragLeave={() => setDropHover(false)}
        onDrop={(e) => {
          if (!isFolder) return;
          e.preventDefault();
          e.stopPropagation();
          setDropHover(false);
          const from = e.dataTransfer.getData(DRAG_TYPE);
          if (from && from !== node.path) move(from, node.path);
        }}
        {...(isFolder
          ? { onClick: () => toggleFolder(node.path) }
          : openProps((o) =>
              node.kind === "note"
                ? openNote(node.path, undefined, undefined, o)
                : /\.pdf$/i.test(node.path)
                  ? useApp.getState().openPdf(node.path)
                  : /\.canvas$/i.test(node.path) && useApp.getState().openCanvas(node.path),
            ))}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onMenu({ x: e.clientX, y: e.clientY, node });
        }}
        title={node.path}
      >
        <span className="twisty">{isFolder && <Chevron open={expanded} />}</span>
        {isRenaming ? (
          <RenameInput node={node} />
        ) : (
          <>
            <span className="tree-label">{label}</span>
            {isFolder && !expanded && <span className="tree-count">{countNotes(node) || ""}</span>}
          </>
        )}
      </div>
      {isFolder && expanded && (
        <>
          {editing?.mode === "new-folder" && editing.parent === node.path && (
            <NewFolderRow parent={node.path} depth={depth + 1} project={editing.project} />
          )}
          {node.children?.map((c) => (
            <Row key={c.path} node={c} depth={depth + 1} onMenu={onMenu} color={shown} />
          ))}
        </>
      )}
    </>
  );
}

/** Inline name input. Enter commits, Esc or blur without change cancels. */
function NameInput({ initial, onCommit }: { initial: string; onCommit: (name: string | null) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const finish = (value: string | null) => {
    if (done.current) return;
    done.current = true;
    onCommit(value);
  };
  return (
    <input
      ref={ref}
      className="tree-input"
      defaultValue={initial}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === "Enter") finish(e.currentTarget.value.trim() || null);
        if (e.key === "Escape") finish(null);
      }}
      onBlur={(e) => finish(e.currentTarget.value.trim() || null)}
    />
  );
}

function RenameInput({ node }: { node: TreeNode }) {
  const rename = useApp((s) => s.rename);
  const setEditing = useApp((s) => s.setEditing);
  const initial = node.kind === "note" ? noteTitle(node.path) : node.name.replace(/\.canvas$/i, "");
  return (
    <NameInput
      initial={initial}
      onCommit={(name) => {
        setEditing(null);
        if (name && name !== initial) rename(node.path, name);
      }}
    />
  );
}

/** Names a new folder, or a new PARA project (a folder with an overview note). */
function NewFolderRow({ parent, depth, project }: { parent: string; depth: number; project?: boolean }) {
  const createFolder = useApp((s) => s.createFolder);
  const createProject = useApp((s) => s.createProject);
  const setEditing = useApp((s) => s.setEditing);
  return (
    <div className="tree-row folder" style={{ paddingLeft: 8 + depth * 14 }}>
      <span className="twisty">
        <Chevron open={false} />
      </span>
      <NameInput
        initial={project ? "새 프로젝트" : "새 폴더"}
        onCommit={(name) => {
          setEditing(null);
          if (name) void (project ? createProject(name) : createFolder(parent, name));
        }}
      />
    </div>
  );
}

function ContextMenu({ menu, onClose }: { menu: Menu; onClose: () => void }) {
  const { createNote, setEditing, remove, toggleFolder, toast, setVersionView, setModal, setFolderColor } = useApp.getState();
  const node = menu.node;
  const folderColor = node?.kind === "folder" ? useApp.getState().config.folder_colors?.[node.path] : undefined;
  const dir = !node ? "" : node.kind === "folder" ? node.path : parentPath(node.path);

  useEffect(() => {
    const close = () => onClose();
    window.addEventListener("click", close);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("blur", close);
    };
  }, [onClose]);

  const items: [string, () => void][] = [
    ["새 노트", () => createNote(dir)],
    ["새 캔버스", () => void useApp.getState().createCanvas(dir)],
    [
      "새 폴더",
      () => {
        if (dir) toggleFolder(dir, true);
        setEditing({ mode: "new-folder", parent: dir });
      },
    ],
  ];
  if (node) {
    const { config, tree, startNewProject, archive, unarchive } = useApp.getState();
    const para = paraActions(node.path, node.kind === "folder", config, (f) => !!f && !!findNode(tree, f));
    items.push(
      ...(node.kind === "note"
        ? ([
            ["새 탭에서 열기", () => useApp.getState().openNote(node.path, undefined, undefined, { newTab: true })],
            ["오른쪽에 나란히 열기", () => useApp.getState().openSplit(node.path)],
          ] as [string, () => void][])
        : []),
      ...(node.kind === "folder"
        ? (["table", "board", "calendar", "graph"] as const).map((m): [string, () => void] => [
            `${MODE_LABEL[m]}로 보기`,
            () => useApp.getState().setTableView(node.path, m),
          ])
        : []),
      ...para.map(
        (a): [string, () => void] => [
          a.label,
          () => void (a.kind === "newProject" ? startNewProject() : a.kind === "archive" ? archive(node.path) : unarchive(node.path, a.to)),
        ],
      ),
      ["이름 변경", () => setEditing({ mode: "rename", path: node.path })],
      ...(node.kind === "note" ? ([["히스토리 보기", () => setVersionView({ path: node.path, id: null })]] as [string, () => void][]) : []),
      [
        "탐색기에서 보기",
        async () => {
          try {
            await revealItemInDir(await api.revealEntry(node.path));
          } catch (e) {
            toast(String(e), "error");
          }
        },
      ],
      [
        "경로 복사",
        () => navigator.clipboard.writeText(node.path).then(() => toast("경로를 복사했습니다")),
      ],
      [
        "삭제",
        async () => {
          const what = node.kind === "folder" ? `폴더 "${node.name}"와 안의 모든 파일` : `"${baseName(node.path)}"`;
          if (await ask(`${what}을(를) 휴지통으로 옮길까요?`, { title: "삭제", kind: "warning" })) remove(node.path);
        },
      ],
    );
  }

  items.push(["삭제된 노트 히스토리", () => setModal("deleted")]);

  return (
    <ul className="menu" style={{ left: menu.x, top: menu.y }} onClick={(e) => e.stopPropagation()}>
      {items.map(([label, run]) => (
        <li
          key={label}
          className={label === "삭제" ? "danger" : ""}
          onClick={() => {
            onClose();
            run();
          }}
        >
          {label}
        </li>
      ))}
      {node?.kind === "folder" && (
        <li className="menu-colors" aria-label="폴더 색">
          <span className="muted small">폴더 색</span>
          <div className="menu-swatches">
            {TEXT_COLORS.map((c) => (
              <button
                key={c.value}
                className={`menu-swatch${folderColor === c.value ? " on" : ""}`}
                title={c.name}
                aria-label={c.name}
                style={{ background: c.value }}
                onClick={() => {
                  onClose();
                  void setFolderColor(node.path, c.value);
                }}
              />
            ))}
            <button
              className="menu-swatch none"
              title="색 없음"
              aria-label="색 없음"
              onClick={() => {
                onClose();
                void setFolderColor(node.path, null);
              }}
            />
          </div>
        </li>
      )}
    </ul>
  );
}
