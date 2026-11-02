// 명령 레지스트리 (FR-EXT-01): 모든 명령은 여기에 등록되고, 명령 팔레트와 단축키가 이 목록을 쓴다.
// 새 명령은 registerCommands에 넣기만 하면 팔레트·단축키에 나타난다. v0.2 플러그인 API도 이 위에 올린다.

export interface Command {
  id: string;
  title: string;
  /** e.g. "Ctrl+Shift+D", "F2", "Alt+ArrowLeft". */
  keys?: string;
  /** Extra words the palette matches (e.g. "업무일지 일지 오늘"). */
  keywords?: string;
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

/** Command id → shortcut the user chose ("" = none), replacing `keys` (FR-UI-05). */
let overrides: Record<string, string> = {};

export function setKeyOverrides(map: Record<string, string>) {
  overrides = map;
  listeners.forEach((l) => l());
}

/** The shortcut in effect for a command: the user's, else its own. */
export function keysOf(c: Command): string | undefined {
  return c.id in overrides ? overrides[c.id] || undefined : c.keys;
}

/** Every registered command with its own (default) keys, for the shortcut settings. */
export function allCommands(): Command[] {
  return [...registry.values()];
}

/** Commands usable now, with the shortcuts in effect. */
export function availableCommands(): Command[] {
  return [...registry.values()].filter((c) => !c.when || c.when()).map((c) => ({ ...c, keys: keysOf(c) }));
}

export function runCommand(id: string): boolean {
  const c = registry.get(id);
  if (!c || (c.when && !c.when())) return false;
  void c.run();
  return true;
}

/** True when the keyboard event matches a "Ctrl+Shift+X" style binding (Ctrl also matches ⌘). */
export function matchKeys(
  e: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "shiftKey" | "altKey"> & { code?: string },
  keys: string,
): boolean {
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
  // Shift+1 gives "!": the key's place (code) still says Digit1.
  return base === key || pressed === key || (!!e.code && codeKey(e.code) === key);
}

/** "KeyA" → "a", "Digit1" → "1"; other codes give null. */
function codeKey(code: string): string | null {
  const m = /^(?:Key|Digit)(.)$/.exec(code);
  return m ? m[1].toLowerCase() : null;
}

const MODIFIERS = new Set(["Control", "Shift", "Alt", "Meta", "AltGraph", "CapsLock", "Process", "Unidentified", "HangulMode", "HanjaMode"]);

/**
 * The binding a key press stands for, written the way commands write theirs
 * ("Ctrl+Shift+N", "F2", "Alt+ArrowLeft"); null for a modifier key alone.
 */
export function keysFromEvent(e: Pick<KeyboardEvent, "key" | "code" | "ctrlKey" | "metaKey" | "shiftKey" | "altKey">): string | null {
  if (MODIFIERS.has(e.key)) return null;
  const named = codeKey(e.code);
  const key = named ? named.toUpperCase() : e.key === " " ? "Space" : e.key.length === 1 ? e.key.toUpperCase() : e.key;
  const mods = [e.ctrlKey || e.metaKey ? "Ctrl" : "", e.altKey ? "Alt" : "", e.shiftKey ? "Shift" : ""].filter(Boolean);
  return [...mods, key].join("+");
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
