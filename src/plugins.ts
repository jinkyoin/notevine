// 플러그인 실행기 (FR-EXT-02). 노트 폴더 `.app/plugins/<id>/main.js`를 플러그인마다 보이지 않는
// 샌드박스 프레임에서 돌린다. 프레임은 앱(Tauri)에 직접 닿지 못하고 네트워크도 막혀 있어서,
// 할 수 있는 일은 postMessage로 부르는 `notevine.*` 함수뿐이다. 그 함수마다 사용자가 켤 때
// 허락한 권한(read·write·network)을 여기서 확인한다.
import { useEffect } from "react";
import { create } from "zustand";
import DOMPurify from "dompurify";
import { api, errorMessage, type PluginInfo, type PluginPermission } from "./api";
import { registerCommands } from "./commands";
import { useApp } from "./store";

import { tx } from "./i18n";
export const PERMISSION_LABEL: Record<PluginPermission, string> = {
  read: tx("노트 읽기 (목록·내용·열린 노트·선택한 글, 노트 열기·저장 알림)"),
  write: tx("노트 쓰기 (노트 고치기·만들기, 편집기에 글 넣기)"),
  network: tx("인터넷 접속 (웹 페이지 받아 오기)"),
};

/** Each call a plugin can make and the permission it needs (null = always allowed). */
const NEEDS: Record<string, PluginPermission | null> = {
  "commands.add": null,
  "panel.show": null,
  "panel.set": null,
  "panel.hide": null,
  "ui.toast": null,
  on: "read",
  "notes.list": "read",
  "notes.read": "read",
  "notes.active": "read",
  "editor.selection": "read",
  "notes.write": "write",
  "notes.create": "write",
  "editor.insert": "write",
  "net.fetch": "network",
};

export const PLUGIN_EVENTS = ["note-open", "note-save"] as const;

interface Panel {
  title: string;
  html: string;
}

interface PluginState {
  /** Plugins found in `.app/plugins` (also broken ones). */
  infos: PluginInfo[];
  panels: Record<string, Panel>;
  /** Plugin id → the last error it reported. */
  errors: Record<string, string>;
  /** Bumped to read `.app/plugins` again and restart the plugins. */
  reloadSeq: number;
  reload(): void;
}

export const usePlugins = create<PluginState>((set, get) => ({
  infos: [],
  panels: {},
  errors: {},
  reloadSeq: 0,
  reload: () => set({ reloadSeq: get().reloadSeq + 1 }),
}));

/** A plugin is on when the user granted everything its manifest asks for. */
export function grantCovers(info: PluginInfo, granted: PluginPermission[] | undefined): boolean {
  return !!granted && info.permissions.every((p) => granted.includes(p));
}

// Runs in the frame before the plugin's own code: the `notevine` object.
const BOOTSTRAP = `
"use strict";
(() => {
  // The webview puts its bridge into every frame. Messages from here don't reach the app,
  // but the plugin's code should not even see it.
  for (const k of ["__TAURI_INTERNALS__", "__TAURI_EVENT_PLUGIN_INTERNALS__", "ipc", "chrome"]) {
    try { delete window[k]; } catch {}
    try { Object.defineProperty(window, k, { value: undefined, configurable: false }); } catch {}
  }
  const pending = new Map();
  const commands = new Map();
  const events = new Map();
  let actionHandler = null;
  let seq = 0;
  const call = (method, ...args) =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, { resolve, reject });
      parent.postMessage({ nv: 1, id, method, args }, "*");
    });
  const report = (message) => parent.postMessage({ nv: 1, id: 0, method: "error", args: [String(message)] }, "*");
  window.addEventListener("error", (e) => report(e.message));
  window.addEventListener("unhandledrejection", (e) => report(e.reason && e.reason.message ? e.reason.message : e.reason));
  window.addEventListener("message", async (e) => {
    if (e.source !== parent || !e.data || e.data.nv !== 1) return;
    const m = e.data;
    try {
      if (m.reply) {
        const p = pending.get(m.reply);
        pending.delete(m.reply);
        if (p) m.ok ? p.resolve(m.value) : p.reject(new Error(m.error));
      } else if (m.type === "command") await commands.get(m.id)?.();
      else if (m.type === "event") for (const fn of events.get(m.event) || []) await fn(m.payload);
      else if (m.type === "action" && actionHandler) await actionHandler(m.action, m.arg, m.values);
    } catch (err) {
      report(err && err.message ? err.message : err);
    }
  });
  window.notevine = Object.freeze({
    commands: { add: ({ id, name, run }) => (commands.set(String(id), run), call("commands.add", String(id), String(name))) },
    on: (event, fn) => {
      if (!events.has(event)) events.set(event, []);
      events.get(event).push(fn);
      return call("on", event);
    },
    panel: {
      show: (title) => call("panel.show", String(title || "")),
      set: (html) => call("panel.set", String(html)),
      hide: () => call("panel.hide"),
      onAction: (fn) => void (actionHandler = fn),
    },
    ui: { toast: (message, kind) => call("ui.toast", String(message), kind === "error" ? "error" : "info") },
    notes: {
      list: () => call("notes.list"),
      read: (path) => call("notes.read", String(path)),
      active: () => call("notes.active"),
      write: (path, text) => call("notes.write", String(path), String(text)),
      create: (folder, name, text) => call("notes.create", String(folder || ""), String(name), String(text || "")),
    },
    editor: {
      selection: () => call("editor.selection"),
      insert: (text) => call("editor.insert", String(text)),
    },
    net: { fetch: (url) => call("net.fetch", String(url)) },
  });
})();
`;

// No network, no plugins of the browser, nothing but its own inline code and styles.
const FRAME_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:";

function frameDoc(source: string): string {
  // Keep the plugin's code inside its <script>: "</script" in it would end the element.
  const code = source.replace(/<\/(script)/gi, "<\\/$1");
  return `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${FRAME_CSP}"><script>${BOOTSTRAP}</script><script>${code}\n</script>`;
}

const PANEL_TAGS = ["div", "p", "span", "b", "strong", "i", "em", "u", "s", "small", "br", "hr", "ul", "ol", "li", "h3", "h4", "h5", "code", "pre", "blockquote", "table", "thead", "tbody", "tr", "th", "td", "button", "input", "textarea", "select", "option", "label"];
const PANEL_ATTRS = ["class", "title", "data-action", "data-arg", "name", "value", "placeholder", "type", "checked", "selected", "rows", "colspan", "rowspan", "disabled"];

/** A plugin's panel HTML with only plain markup: no scripts, styles, links or anything that loads. */
export function cleanPanelHtml(html: string): string {
  return DOMPurify.sanitize(html, { ALLOWED_TAGS: PANEL_TAGS, ALLOWED_ATTR: PANEL_ATTRS, ALLOW_DATA_ATTR: false });
}

class PluginHost {
  readonly frame: HTMLIFrameElement;
  private perms: Set<PluginPermission>;
  private unregister: (() => void)[] = [];
  readonly events = new Set<string>();

  constructor(
    readonly info: PluginInfo,
    source: string,
    granted: PluginPermission[],
    holder: HTMLElement,
  ) {
    this.perms = new Set(granted);
    const f = document.createElement("iframe");
    f.className = "plugin-frame";
    f.title = tx("플러그인: {0}", info.name);
    f.setAttribute("sandbox", "allow-scripts");
    // CSP Embedded Enforcement: also stops the frame from navigating to a web page.
    f.setAttribute("csp", FRAME_CSP);
    f.dataset.plugin = info.id;
    f.srcdoc = frameDoc(source);
    holder.appendChild(f);
    this.frame = f;
  }

  send(msg: Record<string, unknown>) {
    this.frame.contentWindow?.postMessage({ nv: 1, ...msg }, "*");
  }

  emit(event: string, payload: unknown) {
    if (this.events.has(event)) this.send({ type: "event", event, payload });
  }

  stop() {
    this.unregister.forEach((f) => f());
    this.frame.remove();
    const { panels } = usePlugins.getState();
    if (panels[this.info.id]) {
      const { [this.info.id]: _gone, ...rest } = panels;
      usePlugins.setState({ panels: rest });
    }
  }

  private fail(message: string) {
    usePlugins.setState((s) => ({ errors: { ...s.errors, [this.info.id]: message } }));
    useApp.getState().toast(tx("플러그인 \"{0}\" 오류: {1}", this.info.name, message), "error");
  }

  async handle(id: number, method: string, args: unknown[]) {
    if (method === "error") return this.fail(String(args[0]));
    const reply = (ok: boolean, value?: unknown, error?: string) => id && this.send({ reply: id, ok, value, error });
    try {
      if (!(method in NEEDS)) throw new Error(tx("알 수 없는 함수: {0}", method));
      const need = NEEDS[method];
      if (need && !this.perms.has(need)) throw new Error(tx("\"{0}\" 권한이 없어 {1}를 쓸 수 없습니다", need, method));
      reply(true, await this.run(method, args));
    } catch (e) {
      reply(false, undefined, errorMessage(e));
    }
  }

  private async run(method: string, args: unknown[]): Promise<unknown> {
    const app = useApp.getState();
    const str = (i: number) => String(args[i] ?? "");
    const pid = this.info.id;
    switch (method) {
      case "commands.add": {
        const cid = str(0);
        this.unregister.push(
          registerCommands([
            {
              id: `plugin.${pid}.${cid}`,
              title: `${this.info.name}: ${str(1)}`,
              keywords: tx("플러그인 plugin {0}", pid),
              when: () => !!useApp.getState().vault,
              run: () => this.send({ type: "command", id: cid }),
            },
          ]),
        );
        return null;
      }
      case "panel.show":
        usePlugins.setState((s) => ({ panels: { ...s.panels, [pid]: { title: str(0) || this.info.name, html: s.panels[pid]?.html ?? "" } } }));
        return null;
      case "panel.set":
        usePlugins.setState((s) => ({ panels: { ...s.panels, [pid]: { title: s.panels[pid]?.title ?? this.info.name, html: cleanPanelHtml(str(0)) } } }));
        return null;
      case "panel.hide": {
        const { [pid]: _gone, ...rest } = usePlugins.getState().panels;
        usePlugins.setState({ panels: rest });
        return null;
      }
      case "ui.toast":
        app.toast(`${this.info.name}: ${str(0)}`, args[1] === "error" ? "error" : "info");
        return null;
      case "on":
        if (!(PLUGIN_EVENTS as readonly string[]).includes(str(0))) throw new Error(tx("알 수 없는 알림: {0} ({1})", str(0), PLUGIN_EVENTS.join(", ")));
        this.events.add(str(0));
        return null;
      case "notes.list":
        return app.notes.map((n) => ({ path: n.path, title: n.title }));
      case "notes.active":
        return app.openPath;
      case "notes.read": {
        const path = str(0);
        // What may leave the PC never includes #비공개 notes (as for AI).
        if (this.perms.has("network") && (await api.aiPrivateNotes([path])).length) throw new Error(tx("#비공개 노트는 인터넷 접속 권한이 있는 플러그인에 보여 주지 않습니다"));
        if (path === app.openPath) await app.flushEditor();
        return api.readNote(path);
      }
      case "editor.selection": {
        const sel = app.editorApi?.selection();
        return sel && !sel.whole ? sel.text : "";
      }
      case "notes.write": {
        const path = str(0);
        if (!/\.md$/i.test(path) || !app.notes.some((n) => n.path === path)) throw new Error(tx("없는 노트입니다: {0}", path));
        const text = str(1);
        if (!(await app.editNote(path, () => text, tx("플러그인이 노트를 고치지 못했습니다")))) throw new Error(tx("노트를 고치지 못했습니다"));
        return null;
      }
      case "notes.create": {
        const path = await api.createNote(str(0), str(1), str(2));
        await app.refreshTree();
        return path;
      }
      case "editor.insert": {
        const ed = app.editorApi;
        if (!ed || !app.openPath) throw new Error(tx("열린 노트가 없습니다"));
        if (app.readMode) app.setReadMode(false);
        const text = str(0);
        const sel = ed.selection();
        if (!sel.whole) ed.replace(sel.from, sel.to, text, sel.text);
        else ed.rewrite((t, c) => ({ text: t.slice(0, c) + text + t.slice(c), cursor: c + text.length }));
        return null;
      }
      case "net.fetch": {
        const page = await api.fetchPage(str(0));
        return { url: page.url, text: page.html };
      }
    }
    return null;
  }
}

let hosts: PluginHost[] = [];

/** Sends a panel button press to its plugin, with the values of the panel's named fields. */
export function panelAction(pluginId: string, action: string, arg: string | undefined, values: Record<string, string | boolean>) {
  hosts.find((h) => h.info.id === pluginId)?.send({ type: "action", action, arg, values });
}

function onMessage(e: MessageEvent) {
  const host = hosts.find((h) => h.frame.contentWindow === e.source);
  const m = e.data;
  if (!host || !m || m.nv !== 1 || typeof m.method !== "string") return;
  void host.handle(Number(m.id) || 0, m.method, Array.isArray(m.args) ? m.args : []);
}

/** Starts the vault's plugins that are on, and stops them when the vault or the choices change. */
export function usePluginHost() {
  const root = useApp((s) => s.vault?.root);
  const granted = useApp((s) => s.config.plugins);
  const reloadSeq = usePlugins((s) => s.reloadSeq);
  const key = JSON.stringify(granted ?? {});

  useEffect(() => {
    if (!root) return;
    let live = true;
    const holder = document.createElement("div");
    holder.className = "plugin-frames";
    holder.setAttribute("aria-hidden", "true");
    document.body.appendChild(holder);
    window.addEventListener("message", onMessage);
    usePlugins.setState({ errors: {}, panels: {} });
    (async () => {
      const infos = await api.listPlugins().catch(() => [] as PluginInfo[]);
      if (!live) return;
      usePlugins.setState({ infos });
      for (const info of infos) {
        const g = granted?.[info.id];
        if (info.error || !grantCovers(info, g)) continue;
        try {
          const source = await api.pluginSource(info.id);
          if (!live) return;
          hosts.push(new PluginHost(info, source, g!, holder));
        } catch (e) {
          usePlugins.setState((s) => ({ errors: { ...s.errors, [info.id]: errorMessage(e) } }));
        }
      }
    })();
    return () => {
      live = false;
      hosts.forEach((h) => h.stop());
      hosts = [];
      holder.remove();
      window.removeEventListener("message", onMessage);
    };
  }, [root, key, reloadSeq]); // eslint-disable-line react-hooks/exhaustive-deps

  // Tell plugins when a note opens or is saved.
  const openPath = useApp((s) => s.openPath);
  const savedSeq = useApp((s) => s.savedSeq);
  useEffect(() => {
    hosts.forEach((h) => h.emit("note-open", openPath));
  }, [openPath]);
  useEffect(() => {
    const p = useApp.getState().openPath;
    if (savedSeq && p) hosts.forEach((h) => h.emit("note-save", p));
  }, [savedSeq]);
}
