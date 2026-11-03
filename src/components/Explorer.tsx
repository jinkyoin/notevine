// SCR-03 파일 탐색기: 트리, 새 노트·폴더, 우클릭 메뉴, 이름 변경, 드래그 이동.
import { useEffect, useRef, useState } from "react";
import { ask } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { api, type TreeNode } from "../api";
import { useApp } from "../store";
import { baseName, countNotes, findNode, noteTitle, parentPath } from "../lib/tree";
import { paraActions, paraInfo } from "../lib/para";
import { openProps } from "./TabBar";
import { MODE_LABEL } from "./FolderView";
import { TEXT_COLORS } from "../editor/colors";

import { tx } from "../i18n";
import { PopupMenu } from "./PopupMenu";
interface Menu {
  x: number;
  y: number;
  node: TreeNode | null; // null = empty area (vault root)
}

const DRAG_TYPE = "application/x-notevine-path";

/** Files dragged in from Windows Explorer (not a row of this tree). */
const hasOsFiles = (e: React.DragEvent) => e.dataTransfer.types.includes("Files") && !e.dataTransfer.types.includes(DRAG_TYPE);

/** Files dropped from Windows Explorer go into `dir`; dropped folders are reported, not copied. */
function dropFiles(e: React.DragEvent, dir: string) {
  const items = [...e.dataTransfer.items];
  const folders = items.filter((i) => i.webkitGetAsEntry?.()?.isDirectory).map((i) => i.webkitGetAsEntry()!.name);
  const files = items.flatMap((i) => (i.kind === "file" && !i.webkitGetAsEntry?.()?.isDirectory ? [i.getAsFile()!] : [])).filter(Boolean);
  void useApp.getState().importFiles(dir, files, folders);
}

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
        <span className="pane-title">{tx("파일")}</span>
        <button className="icon-btn" title={tx("새 노트")} onClick={() => createNote("")}>
          ＋
        </button>
        <button className="icon-btn" title={tx("새 폴더")} onClick={() => setEditing({ mode: "new-folder", parent: "" })}>
          ▣
        </button>
      </div>
      <div
        className="tree"
        onContextMenu={(e) => {
          e.preventDefault();
          setMenu({ x: e.clientX, y: e.clientY, node: null });
        }}
        onDragOver={(e) => (e.dataTransfer.types.includes(DRAG_TYPE) || hasOsFiles(e)) && e.preventDefault()}
        onDrop={(e) => {
          if (hasOsFiles(e)) {
            e.preventDefault();
            return dropFiles(e, "");
          }
          const from = e.dataTransfer.getData(DRAG_TYPE);
          if (from) move(from, "");
        }}
      >
        {editing?.mode === "new-folder" && editing.parent === "" && <NewFolderRow parent="" depth={0} project={editing.project} />}
        {tree.map((n) => (
          <Row key={n.path} node={n} depth={0} onMenu={setMenu} />
        ))}
        {tree.length === 0 && <p className="muted small pad">{tx("노트가 없습니다. ＋로 새 노트를 만드세요.")}</p>}
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
          // Move within the tree, or link from the editor.
          e.dataTransfer.effectAllowed = "linkMove";
        }}
        onDragOver={(e) => {
          // Files from Windows Explorer: into this folder, or the folder of this note.
          const os = hasOsFiles(e);
          if (!os && (!isFolder || !e.dataTransfer.types.includes(DRAG_TYPE))) return;
          e.preventDefault();
          e.stopPropagation();
          e.dataTransfer.dropEffect = os ? "copy" : "move";
          setDropHover(true);
        }}
        onDragLeave={() => setDropHover(false)}
        onDrop={(e) => {
          if (hasOsFiles(e)) {
            e.preventDefault();
            e.stopPropagation();
            setDropHover(false);
            return dropFiles(e, isFolder ? node.path : parentPath(node.path));
          }
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
                  : /\.canvas$/i.test(node.path)
                    ? useApp.getState().openCanvas(node.path)
                    : // Excel, Hangul, Word, images…: the program Windows uses for them.
                      void useApp.getState().openExternal(node.path),
            ))}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onMenu({ x: e.clientX, y: e.clientY, node });
        }}
        title={(isFolder && paraInfo(node.path, useApp.getState().config)) ? `${node.path}\n${paraInfo(node.path, useApp.getState().config)}` : node.path}
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
        initial={project ? tx("새 프로젝트") : tx("새 폴더")}
        onCommit={(name) => {
          setEditing(null);
          if (name) void (project ? createProject(name) : createFolder(parent, name));
        }}
      />
    </div>
  );
}

function ContextMenu({ menu, onClose }: { menu: Menu; onClose: () => void }) {
  const { createNote, setEditing, remove, toggleFolder, toast, setVersionView, setModal } = useApp.getState();
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

  type Item = { label: string; run: () => void; danger?: boolean };
  /** A line of small buttons ("새로 만들기  노트 · 캔버스 · 폴더"). */
  type Row = { row: string; buttons: [string, () => void][] };
  const newRow: Row = {
    row: tx("새로 만들기"),
    buttons: [
      [tx("노트"), () => createNote(dir)],
      [tx("캔버스"), () => void useApp.getState().createCanvas(dir)],
      [
        tx("폴더"),
        () => {
          if (dir) toggleFolder(dir, true);
          setEditing({ mode: "new-folder", parent: dir });
        },
      ],
    ],
  };
  // Groups, drawn with a line between them; empty groups are left out.
  const groups: (Item | Row)[][] = [];
  if (!node) {
    groups.push([newRow], [{ label: tx("삭제된 노트 히스토리"), run: () => setModal("deleted") }]);
  } else {
    const { config, tree, startNewProject, archive, unarchive, openNote, openSplit, openExternal, setTableView } = useApp.getState();
    const para = paraActions(node.path, node.kind === "folder", config, (f) => !!f && !!findNode(tree, f));
    const isFolder = node.kind === "folder";
    const paraItems: Item[] = para.map((a) => ({
      label: a.label,
      run: () => void (a.kind === "newProject" ? startNewProject() : a.kind === "archive" ? archive(node.path) : unarchive(node.path, a.to)),
    }));
    if (isFolder) {
      groups.push([
        newRow,
        {
          row: tx("보기"),
          buttons: (["table", "board", "calendar", "graph"] as const).map((m): [string, () => void] => [MODE_LABEL[m], () => setTableView(node.path, m)]),
        },
      ]);
    } else {
      // New things go into the note's folder.
      groups.push([newRow]);
      groups.push([
        ...(node.kind === "note"
          ? [
              { label: tx("새 탭에서 열기"), run: () => openNote(node.path, undefined, undefined, { newTab: true }) },
              { label: tx("오른쪽에 나란히 열기"), run: () => openSplit(node.path) },
            ]
          : []),
        { label: tx("연결된 프로그램으로 열기"), run: () => void openExternal(node.path) },
      ]);
    }
    groups.push([
      { label: tx("이름 변경"), run: () => setEditing({ mode: "rename", path: node.path }) },
      ...(node.kind === "note" ? [{ label: tx("히스토리 보기"), run: () => setVersionView({ path: node.path, id: null }) }] : []),
      ...paraItems,
    ]);
    groups.push([
      {
        label: tx("탐색기에서 보기"),
        run: async () => {
          try {
            await revealItemInDir(await api.revealEntry(node.path));
          } catch (e) {
            toast(String(e), "error");
          }
        },
      },
      { label: tx("경로 복사"), run: () => void navigator.clipboard.writeText(node.path).then(() => toast(tx("경로를 복사했습니다"))) },
    ]);
    groups.push([
      {
        label: tx("삭제"),
        danger: true,
        run: async () => {
          const what = isFolder ? tx("폴더 \"{0}\"와 안의 모든 파일", node.name) : `"${baseName(node.path)}"`;
          if (await ask(tx("{0}을(를) 휴지통으로 옮길까요?", what), { title: tx("삭제"), kind: "warning" })) remove(node.path);
        },
      },
    ]);
  }
  const shown = groups.filter((g) => g.length);
  // The folder colors sit just above "삭제".
  const colorsAt = node?.kind === "folder" ? shown.length - 1 : -1;

  return (
    <PopupMenu x={menu.x} y={menu.y}>
      {shown.map((group, gi) => [
        gi > 0 && <li key={`sep${gi}`} className="menu-sep" role="separator" />,
        gi === colorsAt && node && <FolderColors key="colors" path={node.path} current={folderColor} onClose={onClose} />,
        gi === colorsAt && <li key="sep-colors" className="menu-sep" role="separator" />,
        ...group.map((it) =>
          "row" in it ? (
            <li key={it.row} className="menu-row">
              <span className="muted small">{it.row}</span>
              <span className="menu-row-btns">
                {it.buttons.map(([label, run]) => (
                  <button
                    key={label}
                    onClick={() => {
                      onClose();
                      run();
                    }}
                  >
                    {label}
                  </button>
                ))}
              </span>
            </li>
          ) : (
            <li
              key={it.label}
              className={it.danger ? "danger" : ""}
              onClick={() => {
                onClose();
                void it.run();
              }}
            >
              {it.label}
            </li>
          ),
        ),
      ])}
    </PopupMenu>
  );
}

/** Folder name colors, as one row of swatches. */
function FolderColors({ path, current, onClose }: { path: string; current: string | undefined; onClose: () => void }) {
  const setFolderColor = useApp((s) => s.setFolderColor);
  return (
    <li className="menu-colors" aria-label={tx("폴더 색")}>
      <span className="muted small">{tx("폴더 색")}</span>
      <div className="menu-swatches">
        {TEXT_COLORS.map((c) => (
          <button
            key={c.value}
            className={`menu-swatch${current === c.value ? " on" : ""}`}
            title={c.name}
            aria-label={c.name}
            style={{ background: c.value }}
            onClick={() => {
              onClose();
              void setFolderColor(path, c.value);
            }}
          />
        ))}
        <button
          className="menu-swatch none"
          title={tx("색 없음")}
          aria-label={tx("색 없음")}
          onClick={() => {
            onClose();
            void setFolderColor(path, null);
          }}
        />
      </div>
    </li>
  );
}
