// 명령 레지스트리 (FR-EXT-01): 모든 명령은 여기에 등록되고, 명령 팔레트와 단축키가 이 목록을 쓴다.
// 새 명령은 registerCommands에 넣기만 하면 팔레트·단축키에 나타난다. v0.2 플러그인 API도 이 위에 올린다.

export interface Command {
  id: string;
  title: string;
  /** e.g. "Ctrl+Shift+D", "F2", "Alt+ArrowLeft". */
  keys?: string;
  /** Hidden from the palette and shortcuts when this returns false. */
  when?: () => boolean;
  run: () => unknown;
}

const registry = new Map<string, Command>();
type Listener = () => void;
const listeners = new Set<Listener>();

export function registerCommands(cmds: Command[]): () => void {
  for (const c of cmds) registry.set(c.id, c);
  listeners.forEach((l) => l());
  return () => {
    for (const c of cmds) if (registry.get(c.id) === c) registry.delete(c.id);
    listeners.forEach((l) => l());
  };
}

export function onCommandsChanged(l: Listener): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function availableCommands(): Command[] {
  return [...registry.values()].filter((c) => !c.when || c.when());
}

export function runCommand(id: string): boolean {
  const c = registry.get(id);
  if (!c || (c.when && !c.when())) return false;
  void c.run();
  return true;
}

/** True when the keyboard event matches a "Ctrl+Shift+X" style binding (Ctrl also matches ⌘). */
export function matchKeys(e: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "shiftKey" | "altKey">, keys: string): boolean {
  const parts = keys.split("+");
  let key = parts.pop()!.toLowerCase();
  if (key === "" && keys.endsWith("+")) key = "+";
  const want = new Set(parts.map((p) => p.toLowerCase()));
  if (want.has("ctrl") !== (e.ctrlKey || e.metaKey)) return false;
  if (want.has("alt") !== e.altKey) return false;
  const pressed = e.key.toLowerCase();
  // Shift changes the produced character for symbols ("\\" → "|"), so compare loosely for those.
  const shifted: Record<string, string> = { "|": "\\", "<": ",", ">": ".", "?": "/" };
  const base = shifted[pressed] ?? pressed;
  if (want.has("shift") !== e.shiftKey) return false;
  return base === key || pressed === key;
}

/** Runs the command bound to this key, if any. Returns true when handled. */
export function dispatchKey(e: KeyboardEvent): boolean {
  if (e.isComposing) return false;
  for (const c of availableCommands()) {
    if (c.keys && matchKeys(e, c.keys)) {
      e.preventDefault();
      void c.run();
      return true;
    }
  }
  return false;
}
