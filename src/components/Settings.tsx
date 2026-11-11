// SCR-16 설정: 일반 · 편집기 · 단축키 · 파일·링크 · 프리셋 · AI · 플러그인 · 히스토리 · 백업 · 정보.
import { useEffect, useRef, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { openPath, openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import { allCommands, keysFromEvent, keysOf, onCommandsChanged, type Command } from "../commands";
import {
  api,
  errorMessage,
  type AppSettings,
  type BackupStatus,
  type CryptKeyStatus,
  type DriveConflict,
  type HistoryStats,
  type McpGrant,
  type McpStatus,
  type TreeNode,
  type VaultConfig,
} from "../api";
import { useApp } from "../store";
import { useAi } from "../aiStore";
import { forgetApiModels, ProviderFix } from "./AiPanel";
import { CryptKeyDialog, type CryptKeyDialogMode } from "./CryptKeyDialog";
import { PERMISSION_LABEL, usePlugins } from "../plugins";
import { checkForUpdate } from "../updates";

import { getLang, setLang, dateLocale, tx, type Lang } from "../i18n";
type Tab = "general" | "editor" | "keys" | "files" | "preset" | "ai" | "plugins" | "history" | "backup" | "about";
const TABS: [Tab, string][] = [
  ["general", tx("일반")],
  ["editor", tx("편집기")],
  ["keys", tx("단축키")],
  ["files", tx("파일·링크")],
  ["preset", tx("프리셋")],
  ["ai", "AI"],
  ["plugins", tx("플러그인")],
  ["history", tx("히스토리")],
  ["backup", tx("백업")],
  ["about", tx("정보")],
];

export function Settings() {
  const modal = useApp((s) => s.modal);
  const setModal = useApp((s) => s.setModal);
  if (modal !== "settings") return null;
  return <SettingsDialog close={() => setModal(null)} />;
}

function SettingsDialog({ close }: { close: () => void }) {
  const config = useApp((s) => s.config);
  const vault = useApp((s) => s.vault);
  const { saveConfig, applyPreset, toast, ask, setTrust } = useApp.getState();
  const trust = useApp((s) => s.trust);
  const [tab, setTab] = useState<Tab>("general");
  const [notices, setNotices] = useState("");
  const setCss = async (on: boolean) => {
    const ok =
      !on ||
      (await ask(
        tx("사용자 CSS 켜기"),
        tx("이 노트 폴더의 .app/custom.css를 앱 화면에 적용합니다. 다른 사람에게서 받은 폴더라면 CSS가 화면을 바꿔 보이게 할 수 있으니, 직접 만든 파일일 때만 켜세요."),
        tx("켜기"),
      ));
    if (!ok) return;
    try {
      setTrust(await api.setCustomCss(on));
    } catch (e) {
      toast(errorMessage(e), "error");
    }
  };
  const [version, setVersion] = useState("");

  useEffect(() => {
    getVersion().then(setVersion).catch(() => setVersion("0.1.0"));
  }, []);

  const set = <K extends keyof VaultConfig>(key: K, value: VaultConfig[K]) => void saveConfig({ ...config, [key]: value });

  return (
    <div className="modal-backdrop" onMouseDown={close} onKeyDown={(e) => e.key === "Escape" && close()}>
      <div className="modal settings" tabIndex={-1} onMouseDown={(e) => e.stopPropagation()}>
        <div className="vv-head">
          <h2>{tx("설정")}</h2>
          <button className="icon-btn" title={tx("닫기 (Esc)")} onClick={close}>
            ×
          </button>
        </div>
        <div className="settings-body">
          <nav className="settings-tabs">
            {TABS.map(([t, label]) => (
              <button key={t} className={tab === t ? "on" : ""} onClick={() => setTab(t)}>
                {label}
              </button>
            ))}
          </nav>
          <div className="settings-pane">
            {tab === "general" && (
              <>
                <Row label={tx("테마")}>
                  <select value={config.theme} onChange={(e) => set("theme", e.target.value as VaultConfig["theme"])}>
                    <option value="system">{tx("시스템 설정 따르기")}</option>
                    <option value="light">{tx("라이트")}</option>
                    <option value="dark">{tx("다크")}</option>
                  </select>
                </Row>
                <Row label={tx("언어")} hint={tx("바꾸면 창을 다시 불러옵니다. 노트 내용·폴더 이름·사용자 매뉴얼은 그대로입니다")}>
                  <select
                    value={getLang()}
                    onChange={async (e) => {
                      const lang = e.target.value as Lang;
                      await useApp.getState().flushEditor();
                      await saveConfig({ ...config, language: lang });
                      setLang(lang);
                    }}
                  >
                    <option value="ko">한국어</option>
                    <option value="en">English</option>
                  </select>
                </Row>
                <Row label={tx("시작할 때")} hint={tx("앱을 켜면 마지막 노트 폴더와 노트를 다시 엽니다")}>
                  <span className="muted small">{tx("마지막 노트 폴더 열기 (항상)")}</span>
                </Row>
                <TraySettings />
                <Row
                  label={tx("사용자 CSS")}
                  hint={tx("이 노트 폴더의 .app/custom.css로 색·글꼴·크기를 바꿉니다. 파일을 저장하고 Notevine 창으로 돌아오면 바로 반영됩니다")}
                >
                  <input type="checkbox" checked={trust.custom_css} onChange={(e) => void setCss(e.target.checked)} />
                  <button
                    className="btn small"
                    onClick={async () => {
                      try {
                        const [path] = await api.customCss(true);
                        if (!trust.custom_css) await setCss(true);
                        await openPath(path);
                      } catch (e) {
                        toast(errorMessage(e), "error");
                      }
                    }}
                  >
                    {tx("파일 열기")}
                  </button>
                </Row>
              </>
            )}
            {tab === "editor" && (
              <>
                <Row label={tx("링크 이동")} hint={tx("노트 링크를 눌렀을 때 이동하는 방법")}>
                  <select value={config.link_click} onChange={(e) => set("link_click", e.target.value as VaultConfig["link_click"])}>
                    <option value="ctrl">{tx("Ctrl+클릭")}</option>
                    <option value="click">{tx("클릭")}</option>
                  </select>
                </Row>
                <Row label={tx("자동 저장")} hint={tx("입력을 멈추고 저장하기까지 기다리는 시간")}>
                  <select value={config.autosave_ms} onChange={(e) => set("autosave_ms", Number(e.target.value))}>
                    {[500, 1000, 2000, 5000].map((ms) => (
                      <option key={ms} value={ms}>
                        {tx("{0}초", ms / 1000)}
                      </option>
                    ))}
                  </select>
                </Row>
              </>
            )}
            {tab === "keys" && <ShortcutSettings />}
            {tab === "plugins" && <PluginSettings />}
            {tab === "backup" && (
              <>
                <DriveSettings />
                <BackupSettings />
              </>
            )}
            {tab === "files" && (
              <>
                <TextRow label={tx("첨부 폴더")} value={config.attachment_folder} onCommit={(v) => set("attachment_folder", v)} />
                <Row label={tx("링크 자동 갱신")} hint={tx("노트 이름을 바꾸거나 옮길 때 그 노트를 가리키는 링크를 고칩니다")}>
                  <input
                    type="checkbox"
                    checked={config.update_links_on_rename}
                    onChange={(e) => set("update_links_on_rename", e.target.checked)}
                  />
                </Row>
              </>
            )}
            {tab === "preset" && (
              <>
                <Row
                  label={tx("기본 구조 (PARA)")}
                  hint={tx("켜면 프로젝트·영역·자료·보관 폴더와 템플릿 5종을 만들고 오늘 업무일지·아이디어 보드를 씁니다. 끄면 이 기능만 숨기고 기존 노트·폴더는 그대로입니다")}
                >
                  <input
                    type="checkbox"
                    checked={config.preset_enabled}
                    onChange={(e) => (e.target.checked ? void applyPreset() : set("preset_enabled", false))}
                  />
                </Row>
                <TextRow label={tx("Inbox 폴더")} value={config.inbox_folder} onCommit={(v) => set("inbox_folder", v)} />
                <TextRow label={tx("프로젝트 폴더")} value={config.project_folder} onCommit={(v) => set("project_folder", v)} />
                <TextRow label={tx("영역 폴더")} value={config.area_folder} onCommit={(v) => set("area_folder", v)} />
                <TextRow label={tx("자료 폴더")} value={config.resource_folder} onCommit={(v) => set("resource_folder", v)} />
                <TextRow label={tx("보관 폴더")} value={config.archive_folder} onCommit={(v) => set("archive_folder", v)} />
                <TextRow label={tx("업무일지 폴더")} value={config.journal_folder} onCommit={(v) => set("journal_folder", v)} />
                <TextRow label={tx("아이디어 폴더")} value={config.idea_folder} onCommit={(v) => set("idea_folder", v)} />
                <TextRow label={tx("조사자료 폴더")} value={config.research_folder} onCommit={(v) => set("research_folder", v)} />
                <TextRow label={tx("템플릿 폴더")} value={config.template_folder} onCommit={(v) => set("template_folder", v)} />
                <TextRow
                  label={tx("업무일지 경로")}
                  hint={tx("{{YYYY}} {{MM}} {{DD}} {{YYYY-MM-DD}}를 쓸 수 있습니다")}
                  value={config.journal_path}
                  onCommit={(v) => set("journal_path", v)}
                />
                <TextRow
                  label={tx("아이디어 상태")}
                  hint={tx("쉼표로 구분, 순서대로 보드에 표시됩니다")}
                  value={config.idea_statuses.join(", ")}
                  onCommit={(v) =>
                    set(
                      "idea_statuses",
                      v
                        .split(",")
                        .map((s) => s.trim())
                        .filter(Boolean),
                    )
                  }
                />
              </>
            )}
            {tab === "ai" && <AiSettings />}
            {tab === "history" && (
              <>
                <HistoryUsage />
                <Row label={tx("묶음 간격")} hint={tx("같은 노트를 이어서 저장하면 5분 단위로 한 버전으로 묶습니다")}>
                  <span>{tx("5분")}</span>
                </Row>
                <Row
                  label={tx("저장 위치")}
                  hint={
                    vault?.store_on_this_pc
                      ? tx("드라이브로 동기화되지 않는 이 PC의 폴더입니다. 다시 만들 수 없는 파일이니 따로 백업하세요")
                      : tx("다시 만들 수 없는 파일이니 노트 폴더와 함께 백업하세요")
                  }
                >
                  {vault?.store_on_this_pc ? (
                    <span className="small" title={`${vault.store_dir}\\history.db`}>{tx("이 PC")}</span>
                  ) : (
                    <span className="mono small">.app/history.db</span>
                  )}
                  <button
                    className="btn small"
                    onClick={() =>
                      vault && void revealItemInDir(`${vault.store_dir}\\history.db`).catch((e) => toast(errorMessage(e), "error"))
                    }
                  >
                    {tx("폴더 열기")}
                  </button>
                </Row>
                <Row label={tx("삭제된 노트")} hint={tx("지운 노트도 히스토리에서 되살릴 수 있습니다")}>
                  <button className="btn small" onClick={() => useApp.getState().setModal("deleted")}>
                    {tx("삭제된 노트 히스토리")}
                  </button>
                </Row>
              </>
            )}
            {tab === "about" && (
              <>
                <Row label={tx("버전")}>
                  <span>Notevine {version}</span>
                </Row>
                <UpdateSettings />
                <Row label={tx("사용자 매뉴얼")} hint={tx("기능별 사용법과 단축키 (Shift+F1)")}>
                  <button className="btn small" onClick={() => useApp.getState().setModal("manual")}>
                    {tx("매뉴얼 열기")}
                  </button>
                </Row>
                <Row label={tx("라이선스")}>
                  <span>MIT</span>
                </Row>
                <Row label={tx("소스 코드")}>
                  <button className="btn small" onClick={() => void openUrl("https://github.com/jinkyoin/notevine")}>
                    {tx("GitHub 열기")}
                  </button>
                </Row>
                <Row label={tx("오픈소스 라이선스")} hint={tx("Notevine은 MIT 라이선스이며, 아래 오픈소스를 포함합니다")}>
                  <button
                    className="btn small"
                    onClick={async () => {
                      const res = await fetch("/THIRD-PARTY-NOTICES.txt").catch(() => null);
                      const text = res?.ok ? await res.text() : "";
                      // A development server answers unknown paths with the app's page.
                      setNotices(text && !text.startsWith("<") ? text : tx("고지 파일은 릴리스 빌드에 들어 있습니다 (npm run notices로 만듭니다)"));
                    }}
                  >
                    {tx("라이선스 보기")}
                  </button>
                </Row>
                {notices && <pre className="license-text">{notices}</pre>}
                <Row label={tx("검색 인덱스")} hint={tx("검색이 이상하면 인덱스를 처음부터 다시 만듭니다. 노트는 바뀌지 않습니다")}>
                  <button
                    className="btn small"
                    onClick={async () => {
                      try {
                        const n = await api.rebuildIndex();
                        toast(tx("인덱스를 다시 만들었습니다 · 노트 {0}개", n));
                        await useApp.getState().refreshTree();
                      } catch (e) {
                        toast(errorMessage(e), "error");
                      }
                    }}
                  >
                    {tx("인덱스 다시 만들기")}
                  </button>
                </Row>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}

const THIN_DAYS = [0, 7, 30, 90, 365];
const DELETE_DAYS = [0, 90, 180, 365, 730];
const daysLabel = (d: number) => (d === 0 ? tx("끄기 (모두 보관)") : d % 365 === 0 ? tx("{0}년", d / 365) : tx("{0}일", d));

/** History usage and how long to keep versions (FR-HIS-08). */
function HistoryUsage() {
  const config = useApp((s) => s.config);
  const { saveConfig, toast, ask } = useApp.getState();
  const [stats, setStats] = useState<HistoryStats | null>(null);
  const [busy, setBusy] = useState(false);
  const load = () => void api.historyStats().then(setStats).catch(() => setStats(null));
  useEffect(load, []);
  const off = !config.history_thin_days && !config.history_delete_days;

  const prune = async () => {
    setBusy(true);
    try {
      const n = await api.pruneHistory(true);
      if (n === 0) {
        toast(tx("지금 정리할 오래된 버전이 없습니다"));
        return;
      }
      if (!(await ask(tx("오래된 버전 정리"), tx("버전 {0}개를 지웁니다. 지운 버전은 되살릴 수 없습니다.", n.toLocaleString()), tx("정리")))) return;
      const before = stats?.file_bytes ?? 0;
      await api.pruneHistory(false);
      const after = await api.historyStats();
      setStats(after);
      toast(tx("버전 {0}개를 정리했습니다 · {1} 줄어듦", n.toLocaleString(), formatBytes(Math.max(0, before - after.file_bytes))));
    } catch (e) {
      toast(errorMessage(e), "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Row label={tx("사용량")} hint={tx("노트 내용은 압축해서 저장합니다")}>
        <span className="small">
          {stats
            ? tx("노트 {0}개 · 버전 {1}개 · {2}", stats.notes.toLocaleString(), stats.versions.toLocaleString(), formatBytes(stats.file_bytes)) +
              (stats.oldest ? tx(" · {0}부터", new Date(stats.oldest).toLocaleDateString(dateLocale())) : "")
            : "…"}
        </span>
      </Row>
      <Row label={tx("오래된 버전 줄이기")} hint={tx("이보다 오래된 버전은 노트마다 하루에 하나(그날 마지막)만 남깁니다")}>
        <select value={config.history_thin_days} onChange={(e) => void saveConfig({ ...config, history_thin_days: Number(e.target.value) })}>
          {THIN_DAYS.map((d) => (
            <option key={d} value={d}>
              {daysLabel(d)}
            </option>
          ))}
        </select>
      </Row>
      <Row label={tx("오래된 버전 지우기")} hint={tx("이보다 오래된 버전은 지웁니다. 노트마다 가장 최근 버전 하나는 늘 남깁니다")}>
        <select
          value={config.history_delete_days}
          onChange={(e) => void saveConfig({ ...config, history_delete_days: Number(e.target.value) })}
        >
          {DELETE_DAYS.map((d) => (
            <option key={d} value={d}>
              {daysLabel(d)}
            </option>
          ))}
        </select>
      </Row>
      <Row label={tx("정리")} hint={tx("위 규칙은 노트 폴더를 열 때마다 자동으로 적용됩니다. 지금 바로 정리하고 파일 크기를 줄일 수도 있습니다")}>
        <button className="btn small" disabled={off || busy} onClick={() => void prune()}>
          {busy ? tx("정리 중…") : tx("지금 정리")}
        </button>
      </Row>
    </>
  );
}

/** Looks for a new version only when asked, or at start-up if turned on (NFR-SEC-02). */
function UpdateSettings() {
  const { toast } = useApp.getState();
  const [auto, setAuto] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void api.appSettings().then((s) => setAuto(s.update_check)).catch(() => {});
  }, []);
  return (
    <Row label={tx("업데이트")} hint={tx("GitHub에서 새 버전을 확인합니다. 켜 두면 앱을 시작할 때마다 확인하고, 설치 전에 묻습니다. 끄면 누를 때만 접속합니다")}>
      <label className="switch-label">
        <input
          type="checkbox"
          checked={auto}
          onChange={(e) => {
            const on = e.target.checked;
            void api
              .setUpdateCheck(on)
              .then(() => setAuto(on))
              .catch((err) => toast(errorMessage(err), "error"));
          }}
        />{" "}
        {tx("시작할 때 확인")}
      </label>
      <button
        className="btn small"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          await checkForUpdate(false);
          setBusy(false);
        }}
      >
        {busy ? tx("확인하는 중…") : tx("지금 확인")}
      </button>
    </Row>
  );
}

/** Tray and start with Windows (FR-PRS-08). App-wide, unlike the rest of the settings. */
function TraySettings() {
  const { toast } = useApp.getState();
  const [s, setS] = useState<AppSettings | null>(null);
  const load = () => void api.appSettings().then(setS).catch(() => setS(null));
  useEffect(load, []);
  const change = async (f: () => Promise<void>) => {
    try {
      await f();
    } catch (e) {
      toast(errorMessage(e), "error");
    }
    load();
  };
  if (!s) return null;
  return (
    <>
      <Row
        label={tx("닫으면 트레이로")}
        hint={tx("창을 닫아도 작업 표시줄 오른쪽 아이콘으로 계속 실행되어, Ctrl+Alt+N 빠른 메모를 쓸 수 있습니다. 끝내려면 아이콘 메뉴의 [종료]")}
      >
        <input type="checkbox" checked={s.tray} onChange={(e) => void change(() => api.setTray(e.target.checked))} />
      </Row>
      <Row label={tx("Windows 시작 시 실행")} hint={tx("로그인하면 Notevine을 트레이에 띄워 둡니다 (닫으면 트레이로를 켰을 때만)")}>
        <input
          type="checkbox"
          disabled={!s.tray}
          checked={s.autostart}
          onChange={(e) => void change(() => api.setAutostart(e.target.checked))}
        />
      </Row>
    </>
  );
}

/** Shortcuts of the app's commands, changed per vault (FR-UI-05). */
function ShortcutSettings() {
  const config = useApp((s) => s.config);
  const { saveConfig } = useApp.getState();
  const [, setTick] = useState(0);
  const [filter, setFilter] = useState("");
  const [capturing, setCapturing] = useState<string | null>(null);
  useEffect(() => onCommandsChanged(() => setTick((n) => n + 1)), []);

  const cmds = allCommands().sort((a, b) => a.title.localeCompare(b.title, "ko"));
  const q = filter.trim().toLowerCase();
  const shown = q
    ? cmds.filter((c) => `${c.title} ${c.keywords ?? ""} ${keysOf(c) ?? ""}`.toLowerCase().includes(q))
    : cmds;
  const owner = (keys: string, except: string) => cmds.find((c) => c.id !== except && keysOf(c)?.toLowerCase() === keys.toLowerCase());

  const save = (map: Record<string, string>) => void saveConfig({ ...config, keybindings: map });
  const bind = (c: Command, keys: string) => {
    const map = { ...config.keybindings };
    if (keys === (c.keys ?? "")) delete map[c.id];
    else map[c.id] = keys;
    // A key does one thing: the command that had it loses it.
    const other = keys && owner(keys, c.id);
    if (other) map[other.id] = "";
    save(map);
  };

  // While waiting for a key, take every key press before the app's own shortcuts do.
  useEffect(() => {
    if (!capturing) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopImmediatePropagation();
      const c = cmds.find((x) => x.id === capturing);
      if (e.key === "Escape" || !c) return setCapturing(null);
      if ((e.key === "Backspace" || e.key === "Delete") && !e.ctrlKey && !e.altKey && !e.shiftKey) {
        bind(c, "");
        return setCapturing(null);
      }
      const keys = keysFromEvent(e);
      if (!keys) return;
      bind(c, keys);
      setCapturing(null);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  return (
    <>
      <p className="muted small pad">
        {tx("단추를 누르고 새 단축키를 누르세요. Backspace는 단축키 없애기, Esc는 취소입니다. 다른 명령이 쓰던 단축키를 고르면 그 명령의 단축키는 없어집니다. 편집기 안의 서식 단축키(Ctrl+B 등)와 다른 프로그램에서 쓰는 빠른 메모(Ctrl+Alt+N)는 바꿀 수 없습니다.")}
      </p>
      <div className="keys-tools">
        <input placeholder={tx("명령 찾기")} value={filter} onChange={(e) => setFilter(e.target.value)} />
        <button
          className="btn small"
          disabled={!Object.keys(config.keybindings).length}
          onClick={() => save({})}
          title={tx("바꾼 단축키를 모두 처음대로")}
        >
          {tx("모두 기본값")}
        </button>
      </div>
      {shown.map((c) => {
        const keys = keysOf(c);
        const changed = c.id in config.keybindings;
        return (
          <div key={c.id} className="set-row keys-row">
            <div>
              <div>{c.title}</div>
              {changed && <div className="muted small">{tx("기본: {0}", c.keys ?? tx("없음"))}</div>}
            </div>
            <div className="set-ctl">
              <button
                className={`btn small keys-btn ${capturing === c.id ? "capturing" : ""}`}
                onClick={() => setCapturing(capturing === c.id ? null : c.id)}
              >
                {capturing === c.id ? tx("키를 누르세요…") : keys ? <kbd>{keys}</kbd> : <span className="muted">{tx("없음")}</span>}
              </button>
              {changed && (
                <button
                  className="btn ghost small"
                  title={tx("기본값으로")}
                  onClick={() => {
                    const map = { ...config.keybindings };
                    delete map[c.id];
                    save(map);
                  }}
                >
                  ↺
                </button>
              )}
            </div>
          </div>
        );
      })}
    </>
  );
}

function AiSettings() {
  const { enabled, providers, providerId, models } = useAi();
  const { setEnabled, setProvider, setModel, detect, current } = useAi.getState();
  useEffect(() => {
    if (!providers) void detect();
  }, [providers, detect]);
  const cur = current();
  return (
    <>
      <Row label={tx("AI 도우미")} hint={tx("켜도 노트는 AI 입력창에 끌어다 놓은 것만 보냅니다")}>
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
      </Row>
      <Row label={tx("연결된 AI")} hint={tx("PC에 설치·로그인된 공식 CLI를 그대로 씁니다. Notevine은 로그인 정보를 읽지 않습니다")}>
        <button className="btn small" onClick={() => void detect(true)}>
          {tx("다시 찾기")}
        </button>
      </Row>
      {(providers ?? []).map((p) => {
        const usable = p.available && p.logged_in !== false;
        return (
          <div key={p.id} className="set-row">
            <div>
              <div>
                {p.name} {p.version && <span className="muted small">{p.version}</span>}
              </div>
              <div className={`small ${usable ? "muted" : "error"}`}>
                {usable
                  ? p.logged_in
                    ? tx("로그인됨 · 사용할 수 있음")
                    : tx("설치됨 · 사용할 수 있음 (로그인 안 되어 있으면 질문할 때 안내합니다)")
                  : (p.detail ?? tx("사용할 수 없음"))}
              </div>
              {!usable && <ProviderFix p={p} />}
            </div>
            <div className="set-ctl">
              <input
                className="model-input"
                placeholder={tx("모델 (비우면 기본)")}
                key={models[p.id] ?? ""}
                defaultValue={models[p.id] ?? ""}
                title={tx("CLI에 넘길 모델 이름(예: opus, sonnet, haiku). 계정에서 쓸 수 없는 모델이면 기본 모델로 다시 보냅니다")}
                onBlur={(e) => setModel(p.id, e.target.value)}
              />
              <input
                type="radio"
                name="ai-provider"
                disabled={!usable}
                checked={cur?.id === p.id}
                onChange={() => setProvider(p.id)}
                title={tx("이 AI 사용")}
              />
            </div>
          </div>
        );
      })}
      {providers === null && <p className="muted small">{tx("AI를 찾는 중…")}</p>}
      <p className="muted small pad">
        {tx("Claude Code는 Claude Pro/Max 구독, Codex는 ChatGPT 구독으로 동작합니다. 로그인 버튼을 누르면 각 AI의 공식 로그인 창이 열리고, 브라우저에서 로그인을 마치면 자동으로 연결됩니다. 선택: {0}", providerId || tx("자동"))}
      </p>
      <AiInstructions />
      <ApiConnections />
      <McpSettings />
    </>
  );
}

const MCP_TOOL_LABEL: Record<string, string> = {
  list_notes: tx("목록 보기"),
  read_note: tx("노트 읽기"),
  search_notes: tx("노트 검색"),
  get_backlinks: tx("백링크 보기"),
  get_note_history: tx("히스토리 보기"),
  create_note: tx("노트 만들기"),
  append_to_note: tx("노트에 덧붙이기"),
  update_note: tx("노트 고치기"),
};

/** Folders of the vault, for the "연결하지 않을 폴더" picker. */
function folderPaths(nodes: TreeNode[], out: string[] = []): string[] {
  for (const n of nodes) {
    if (n.kind !== "folder") continue;
    out.push(n.path);
    if (n.children) folderPaths(n.children, out);
  }
  return out;
}

/** AI tools on this PC reach this vault through `notevine --mcp` (FR-MCP-01~06). */
function McpSettings() {
  const tree = useApp((s) => s.tree);
  const { toast } = useApp.getState();
  const [st, setSt] = useState<McpStatus | null>(null);
  const [pick, setPick] = useState("");
  const load = () => void api.mcpStatus().then(setSt).catch(() => setSt(null));
  useEffect(load, []);
  if (!st) return null;
  const g = st.grant;
  const save = async (next: McpGrant) => {
    try {
      setSt(await api.setMcp(next));
    } catch (e) {
      toast(errorMessage(e), "error");
    }
  };
  const folders = folderPaths(tree).filter((f) => !g.excluded.some((x) => x.toLowerCase() === f.toLowerCase()));
  const q = (s: string) => `"${s}"`;
  const launch = `${q(st.exe)} --mcp`;
  const connections: [string, string][] = [
    [tx("Claude Code (터미널에서 실행)"), `claude mcp add --scope user notevine -- ${launch}`],
    [
      tx("Claude Desktop (claude_desktop_config.json에 넣기)"),
      JSON.stringify({ mcpServers: { notevine: { command: st.exe, args: ["--mcp"] } } }, null, 2),
    ],
    [tx("Codex CLI (터미널에서 실행)"), `codex mcp add notevine -- ${launch}`],
  ];
  const copy = (text: string) => void navigator.clipboard.writeText(text).then(() => toast(tx("복사했습니다")));
  return (
    <>
      <h3 className="set-sub">{tx("외부 AI 도구 연결 (MCP)")}</h3>
      <p className="muted small">
        {tx("Claude Code, Claude Desktop, Codex 같은 이 PC의 AI 도구가 이 노트 폴더의 노트를 찾고 읽게 합니다. 네트워크 포트는 열지 않습니다. #비공개 노트와 아래에서 뺀 폴더는 AI 도구에 보이지 않습니다.")}
      </p>
      <Row label={tx("이 노트 폴더를 AI 도구에 연결")} hint={tx("켜면 연결한 AI 도구가 노트를 찾고 읽을 수 있습니다. 읽은 내용은 그 AI 서비스로 보내집니다")}>
        <input type="checkbox" checked={g.enabled} onChange={(e) => void save({ ...g, enabled: e.target.checked })} />
      </Row>
      <Row
        label={tx("노트 만들기·고치기도 허용")}
        hint={tx("AI 도구가 쓴 내용은 히스토리에 'AI 도구'로 남아 되돌릴 수 있습니다. 지우기·이름 바꾸기·옮기기는 하지 못합니다")}
      >
        <input type="checkbox" disabled={!g.enabled} checked={g.write} onChange={(e) => void save({ ...g, write: e.target.checked })} />
      </Row>
      <Row label={tx("연결하지 않을 폴더")} hint={tx("이 폴더와 그 안의 모든 노트는 목록·검색·읽기·쓰기에서 빠집니다")}>
        <select value={pick} onChange={(e) => setPick(e.target.value)}>
          <option value="">{tx("폴더 선택")}</option>
          {folders.map((f) => (
            <option key={f} value={f}>
              {f}
            </option>
          ))}
        </select>
        <button
          className="btn small"
          disabled={!pick}
          onClick={() => {
            void save({ ...g, excluded: [...g.excluded, pick] });
            setPick("");
          }}
        >
          {tx("빼기")}
        </button>
      </Row>
      {g.excluded.length > 0 && (
        <div className="chips pad">
          {g.excluded.map((f) => (
            <span key={f} className="chip">
              {f}
              <button title={tx("다시 연결")} onClick={() => void save({ ...g, excluded: g.excluded.filter((x) => x !== f) })}>
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      {g.enabled && (
        <>
          <p className="muted small">{tx("쓰는 AI 도구에 아래 설정을 한 번 넣으면 연결됩니다. AI 도구는 Notevine에서 마지막으로 연 노트 폴더를 따라가므로 노트 폴더를 바꿔도 다시 넣지 않아도 됩니다(그 노트 폴더도 연결을 켜 두어야 합니다). Notevine이 꺼져 있어도 동작합니다.")}</p>
          {connections.map(([label, text]) => (
            <div key={label}>
              <div className="small">{label}</div>
              <div className="mcp-cmd">
                <code>{text}</code>
                <button className="btn ghost small" onClick={() => copy(text)}>
                  {tx("복사")}
                </button>
              </div>
            </div>
          ))}
        </>
      )}
      <Row label={tx("최근 AI 도구 활동")} hint={tx("도구 이름과 대상만 남기고 노트 내용은 남기지 않습니다")}>
        <button className="btn small" onClick={load}>
          {tx("새로 고침")}
        </button>
      </Row>
      {st.activity.length === 0 ? (
        <p className="muted small pad">{tx("아직 없습니다")}</p>
      ) : (
        <ul className="mcp-log pad">
          {st.activity.map((a, i) => (
            <li key={i} className={a.ok ? "" : "fail"}>
              <span className="muted">
                {new Date(a.at).toLocaleString(dateLocale(), { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}
              </span>
              <span>{MCP_TOOL_LABEL[a.tool] ?? a.tool}</span>
              <span>{a.target}</span>
              {!a.ok && <span>{tx("거부·실패")}</span>}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

/** How the AI answers in this note folder: sent with every AI request (질문·글 고치기·주간 회고). */
function AiInstructions() {
  const saved = useApp((s) => s.config.ai_instructions);
  const [draft, setDraft] = useState(saved);
  const latest = useRef(draft);
  latest.current = draft;
  useEffect(() => setDraft(saved), [saved]);
  // Saved on blur, and also when the settings close: Esc or a click outside closes them
  // before the box loses focus, so blur alone would drop what was typed.
  const save = () => {
    const { config, saveConfig } = useApp.getState();
    if (latest.current !== config.ai_instructions) void saveConfig({ ...config, ai_instructions: latest.current });
  };
  useEffect(() => save, []);
  return (
    <>
      <h3 className="set-sub">{tx("답변 지침 (이 노트 폴더)")}</h3>
      <p className="muted small">
        {tx("AI가 이 노트 폴더에서 답할 때 따를 말투·길이·형식을 적습니다. 모든 AI 요청에 함께 보내고, 노트 폴더 안에 저장되어 다른 PC에서도 같이 쓰입니다. 노트를 고치는 방식이나 #비공개 노트 같은 앱의 규칙은 바꾸지 못합니다.")}
      </p>
      <p className="muted small">
        {tx("모든 노트 폴더에는 공통 지침이 먼저 들어갑니다: 앱의 서식(표·강조 상자·형광펜 등)을 최대한 활용해 보기 좋게 쓰고, 이미지가 필요하면 그림(Mermaid)으로 그리거나 웹 이미지 링크로 넣습니다. 여기 적은 지침이 공통 지침과 다르면 여기 지침을 따릅니다.")}
      </p>
      <textarea
        className="ai-instructions"
        rows={5}
        maxLength={4000}
        value={draft}
        placeholder={tx("예: 한국어로 답한다. 결론부터 세 줄 이내로 쓴다. 비교는 표로 정리한다.")}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={save}
      />
    </>
  );
}

/** API keys (Anthropic, OpenAI) and the Ollama address (FR-AI-07). */
function ApiConnections() {
  const providers = useAi((s) => s.providers);
  const { detect } = useAi.getState();
  const { toast } = useApp.getState();
  const [ollama, setOllama] = useState("");
  useEffect(() => void api.appSettings().then((s) => setOllama(s.ollama_url)).catch(() => {}), []);
  const has = (id: string) => !!providers?.find((p) => p.id === id)?.available;
  const after = async (id: string, done: string) => {
    forgetApiModels(id);
    await detect(true);
    toast(done);
  };
  const saveKey = async (id: string, key: string) => {
    try {
      await api.aiSetKey(id, key);
      await after(id, key ? tx("API 키를 저장했습니다") : tx("API 키를 지웠습니다"));
    } catch (e) {
      toast(errorMessage(e), "error");
    }
  };
  return (
    <>
      <h3 className="set-sub">{tx("API 키 · 내 PC 모델")}</h3>
      <p className="muted small">
        {tx("구독 대신 각 회사의 API 키로 쓰거나, 내 PC에서 돌리는 Ollama 모델로 씁니다. 키는 Windows 자격 증명 관리자에 저장되고 화면에 다시 보이지 않습니다. API 사용료는 그 회사 계정으로 청구됩니다. 웹 검색은 CLI 연결에서만 됩니다.")}
      </p>
      <KeyRow label={tx("Claude API 키")} id="anthropic" set={has("anthropic")} placeholder="sk-ant-…" onSave={saveKey} />
      <KeyRow label={tx("OpenAI API 키")} id="openai" set={has("openai")} placeholder="sk-…" onSave={saveKey} />
      <Row label={tx("Ollama 주소")} hint={has("ollama") ? tx("연결됨") : tx("Ollama를 설치·실행하면 쓸 수 있습니다 (이 PC 주소만)")}>
        <input className="api-input" value={ollama} placeholder="http://127.0.0.1:11434" onChange={(e) => setOllama(e.target.value)} />
        <button
          className="btn small"
          onClick={async () => {
            try {
              await api.setOllamaUrl(ollama);
              await after("ollama", tx("Ollama 주소를 저장했습니다"));
            } catch (e) {
              toast(errorMessage(e), "error");
            }
          }}
        >
          {tx("저장·확인")}
        </button>
      </Row>
    </>
  );
}

function KeyRow({
  label,
  id,
  set,
  placeholder,
  onSave,
}: {
  label: string;
  id: string;
  set: boolean;
  placeholder: string;
  onSave: (id: string, key: string) => Promise<void>;
}) {
  const [key, setKey] = useState("");
  return (
    <Row label={label} hint={set ? tx("저장됨 · 바꾸려면 새 키를 넣으세요") : tx("없음")}>
      <input
        className="api-input"
        type="password"
        autoComplete="off"
        value={key}
        placeholder={set ? "••••••••" : placeholder}
        onChange={(e) => setKey(e.target.value)}
      />
      <button
        className="btn small"
        disabled={!key.trim()}
        onClick={async () => {
          await onSave(id, key.trim());
          setKey("");
        }}
      >
        {tx("저장")}
      </button>
      {set && (
        <button className="btn ghost small" onClick={() => void onSave(id, "")}>
          {tx("지우기")}
        </button>
      )}
    </Row>
  );
}

/** Shown when the note folder is inside a cloud drive folder. */
function DriveSettings() {
  const drive = useApp((s) => s.vault?.drive ?? null);
  const tree = useApp((s) => s.tree);
  const { openNote, setModal, toast } = useApp.getState();
  const [conflicts, setConflicts] = useState<DriveConflict[]>([]);
  useEffect(() => {
    if (!drive) return;
    let stale = false;
    api
      .driveConflicts()
      .then((c) => !stale && setConflicts(c))
      .catch((e) => toast(errorMessage(e), "error"));
    return () => {
      stale = true;
    };
  }, [drive, tree, toast]);

  if (!drive) return null;
  return (
    <>
      <Row
        label={tx("드라이브")}
        hint={tx("이 노트 폴더는 드라이브 앱이 동기화합니다. 이 폴더에 Git 백업까지 함께 쓰면 드라이브가 .git 폴더를 망가뜨릴 수 있으니 둘 중 하나만 쓰세요")}
      >
        <span>{drive === "google" ? "Google Drive" : "OneDrive"}</span>
      </Row>
      <Row label={tx("드라이브 충돌본")} hint={tx("두 PC에서 같은 노트를 고쳤을 때 드라이브 앱이 만든 사본입니다. 내용을 확인해 합친 뒤 지우세요")}>
        {conflicts.length === 0 ? (
          <span className="muted small">{tx("없음")}</span>
        ) : (
          <ul className="drive-conflicts">
            {conflicts.map((c) => (
              <li key={c.copy}>
                <button
                  className="link-btn"
                  title={tx("원본: {0}", c.original)}
                  onClick={() => {
                    setModal(null);
                    openNote(c.copy);
                  }}
                >
                  {c.copy}
                </button>
              </li>
            ))}
          </ul>
        )}
      </Row>
    </>
  );
}

function BackupSettings() {
  const trust = useApp((s) => s.trust);
  const { toast, backupNow, ask, setTrust } = useApp.getState();
  const [st, setSt] = useState<BackupStatus | null>(null);
  const [remote, setRemote] = useState("");
  const [busy, setBusy] = useState(false);
  const [key, setKey] = useState<CryptKeyStatus | null>(null);
  const [keyDlg, setKeyDlg] = useState<CryptKeyDialogMode | null>(null);
  const [movedAside, setMovedAside] = useState<string | null>(null);
  const load = () => {
    void api
      .backupStatus()
      .then((s) => {
        setSt(s);
        setRemote(s.remote ?? "");
      })
      .catch((e) => toast(errorMessage(e), "error"));
    void api
      .cryptKeyStatus()
      .then(setKey)
      .catch((e) => toast(errorMessage(e), "error"));
  };
  useEffect(load, []); // eslint-disable-line react-hooks/exhaustive-deps
  const run = async (f: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await f();
      setTrust(await api.deviceTrust());
    } catch (e) {
      toast(errorMessage(e), "error");
    } finally {
      setBusy(false);
      load();
    }
  };
  const allow = async () => {
    const ok = await ask(
      tx("이 Git 저장소 허용"),
      tx("이 노트 폴더에 이미 Git 저장소(.git)가 있습니다. 저장소 설정은 명령을 실행할 수 있으므로, 다른 사람에게서 받은 폴더라면 허용하지 마세요. 직접 만들었거나 내 저장소에서 받은(clone) 폴더일 때만 허용하세요."),
      tx("허용"),
    );
    if (ok) await run(api.backupTrust);
  };

  const createKey = async () => {
    setBusy(true);
    try {
      setKeyDlg({ kind: "created", code: await api.cryptCreateKey() });
    } catch (e) {
      toast(errorMessage(e), "error");
    } finally {
      setBusy(false);
      load();
    }
  };
  const showCode = async () => {
    try {
      setKeyDlg({ kind: "show", code: await api.cryptShowRecoveryCode() });
    } catch (e) {
      toast(errorMessage(e), "error");
    }
  };
  const enableEncryption = async () => {
    const ok = await ask(
      tx("이 노트 폴더 암호화 켜기"),
      tx("새 저장소로 시작합니다. 지금 저장소는 .git-before-encryption-…로 옮겨 둡니다. 원격 저장소는 새 빈 저장소를 만들어 주소를 넣어 주세요. 옛 원격 저장소는 직접 지워 주세요."),
      tx("암호화 켜기"),
    );
    if (!ok) return;
    setBusy(true);
    try {
      const moved = await api.backupEnableEncryption();
      setMovedAside(moved ?? "");
      toast(moved ? tx("암호화를 켰습니다 · 옛 저장소는 {0}로 옮겼습니다. 새 빈 원격 저장소를 만들어 주소를 넣어 주세요", moved) : tx("암호화를 켰습니다 · 새 빈 원격 저장소를 만들어 주소를 넣어 주세요"));
    } catch (e) {
      toast(errorMessage(e), "error");
    } finally {
      setBusy(false);
      load();
    }
  };

  if (!st) return <p className="muted small">{tx("확인하는 중…")}</p>;
  if (!st.git) {
    return (
      <p>
        {tx("Git이 설치되어 있지 않습니다. 백업을 쓰려면 Git을 설치한 뒤 다시 여세요.")}{" "}
        <button className="link-btn" onClick={() => void openUrl("https://git-scm.com/download/win")}>
          {tx("Git 받기")}
        </button>
      </p>
    );
  }
  return (
    <>
      {keyDlg && (
        <CryptKeyDialog
          mode={keyDlg}
          onClose={() => {
            setKeyDlg(null);
            load();
          }}
        />
      )}
      <p className="muted small">
        {tx("노트 폴더를 Git 저장소로 백업합니다. 백업할 때마다 그 순간의 노트 전체가 남아 언제든 되돌릴 수 있습니다. 원격 저장소(예: GitHub 비공개 저장소)를 넣으면 그곳으로도 보내고, 다른 PC에서 백업한 변경을 받아 와 여러 PC에서 같은 노트를 쓸 수 있습니다. 검색 인덱스·히스토리 DB는 넣지 않습니다.")}
      </p>
      {st.repo && !st.trusted ? (
        <Row label={tx("저장소 확인")} hint={tx("이미 있던 Git 저장소입니다. 허용하기 전에는 이 PC에서 Git을 실행하지 않습니다")}>
          <button className="btn small primary" disabled={busy} onClick={() => void allow()}>
            {tx("이 저장소 허용")}
          </button>
        </Row>
      ) : !st.repo ? (
        <Row label={tx("백업 시작")} hint={tx("이 노트 폴더에 Git 저장소(.git)를 만듭니다. 노트는 바뀌지 않습니다")}>
          <button className="btn small primary" disabled={busy} onClick={() => void run(api.backupInit)}>
            {tx("Git 저장소 만들기")}
          </button>
        </Row>
      ) : (
        <>
          <Row
            label={tx("상태")}
            hint={
              st.last_at
                ? tx("마지막 백업 {0} · {1}", new Date(st.last_at).toLocaleString(dateLocale()), st.last_message ?? "")
                : tx("아직 백업한 적이 없습니다")
            }
          >
            <span className="small">
              {st.changed ? tx("바뀐 파일 {0}개", st.changed) : tx("모두 백업됨")}
              {st.ahead ? tx(" · 보낼 백업 {0}개", st.ahead) : ""}
              {st.behind ? tx(" · 받을 백업 {0}개", st.behind) : ""}
            </span>
            <button className="btn small primary" disabled={busy} onClick={() => void run(() => backupNow())}>
              {busy ? tx("백업하는 중…") : tx("지금 백업")}
            </button>
          </Row>
          <Row label={tx("원격 저장소")} hint={tx("비워 두면 이 PC에만 백업합니다. 넣으면 백업할 때 노트가 그 저장소로 전송됩니다(비공개 저장소를 쓰세요)")}>
            <input
              className="api-input"
              value={remote}
              placeholder={tx("https://github.com/이름/notes.git")}
              onChange={(e) => setRemote(e.target.value)}
            />
            <button
              className="btn small"
              disabled={busy || remote.trim() === (st.remote ?? "")}
              onClick={() => void run(() => api.backupSetRemote(remote))}
            >
              {tx("저장")}
            </button>
          </Row>
          <Row
            label={tx("암호화")}
            hint={
              st.encrypted
                ? tx("원격 저장소에는 노트가 암호화되어 올라갑니다. 열쇠는 이 PC에만 있고, 다른 PC에는 복구 코드로 넣습니다")
                : tx("노트를 암호화해서 원격 저장소에 올립니다. 켜면 새 저장소로 다시 시작합니다")
            }
          >
            {st.encrypted ? (
              <>
                <span className="small">{st.key_ok ? tx("암호화됨 · 열쇠 확인됨") : tx("암호화됨 · 이 PC에 열쇠가 없습니다")}</span>
                {key?.has_key && (
                  <button className="btn small" disabled={busy} onClick={() => void showCode()}>
                    {tx("복구 코드 보기")}
                  </button>
                )}
                {!key?.has_key && (
                  <button className="btn small" disabled={busy} onClick={() => setKeyDlg({ kind: "import" })}>
                    {tx("복구 코드 입력")}
                  </button>
                )}
              </>
            ) : key?.has_key ? (
              <>
                <button className="btn small primary" disabled={busy} onClick={() => void enableEncryption()}>
                  {tx("이 노트 폴더 암호화 켜기")}
                </button>
                <button className="btn small" disabled={busy} onClick={() => void showCode()}>
                  {tx("복구 코드 보기")}
                </button>
              </>
            ) : (
              <>
                <button className="btn small primary" disabled={busy} onClick={() => void createKey()}>
                  {tx("열쇠 만들기")}
                </button>
                <button className="btn small" disabled={busy} onClick={() => setKeyDlg({ kind: "import" })}>
                  {tx("복구 코드 입력")}
                </button>
              </>
            )}
          </Row>
          {movedAside !== null && (
            <p className="muted small">
              {movedAside ? tx("옛 저장소는 {0}로 옮겨 두었습니다. ", movedAside) : ""}
              {tx("새 빈 원격 저장소를 만들어 위 원격 저장소 칸에 주소를 넣고, 옛 원격 저장소는 직접 지워 주세요.")}
            </p>
          )}
          <Row label={tx("자동 백업")} hint={tx("바뀐 것이 있을 때만 정해진 간격으로 백업합니다. 실패하면 알림으로 알려 드립니다")}>
            <select value={trust.backup_minutes} onChange={(e) => void run(() => api.setBackupMinutes(Number(e.target.value)))}>
              <option value={0}>{tx("끄기 (직접 백업)")}</option>
              <option value={15}>{tx("15분마다")}</option>
              <option value={30}>{tx("30분마다")}</option>
              <option value={60}>{tx("1시간마다")}</option>
              <option value={180}>{tx("3시간마다")}</option>
            </select>
          </Row>
        </>
      )}
    </>
  );
}

function PluginSettings() {
  const infos = usePlugins((s) => s.infos);
  const errors = usePlugins((s) => s.errors);
  const { toast, ask } = useApp.getState();

  const apply = async (id: string, on: boolean) => {
    try {
      await api.setPluginGrant(id, on);
      usePlugins.getState().reload();
    } catch (e) {
      toast(errorMessage(e), "error");
    }
  };

  const turn = async (id: string, on: boolean) => {
    const info = infos.find((p) => p.id === id);
    if (!info) return;
    if (!on) return apply(id, false);
    const perms = info.permissions.length ? info.permissions.map((p) => `· ${PERMISSION_LABEL[p]}`).join("\n") : tx("· 없음 (명령·패널·알림만)");
    const ok = await ask(
      tx("플러그인 켜기: {0}", info.name),
      tx("이 플러그인이 쓰는 권한입니다.\n\n{0}\n\n플러그인은 노트 폴더 .app/plugins/{1}의 코드를 실행합니다. 만든 사람을 믿을 수 있을 때만 켜세요.", perms, id),
      tx("켜기"),
    );
    if (ok) await apply(id, true);
  };

  return (
    <>
      <p className="muted small">
        {tx("플러그인은 명령·패널을 더하는 작은 프로그램입니다. 노트 폴더의")}{" "} <code>.app/plugins</code> {" "}{tx("안에 폴더째 넣고 여기서 켭니다. 플러그인은 앱과 떨어진 곳에서 돌고, 켤 때 허락한 일만 할 수 있습니다. 만드는 법은 사용자 매뉴얼(Shift+F1)의 '플러그인' 장을 보세요.")}
      </p>
      <div className="set-actions">
        <button
          className="btn small"
          onClick={() =>
            void api
              .pluginsFolder()
              .then(openPath)
              .catch((e) => toast(errorMessage(e), "error"))
          }
        >
          {tx("플러그인 폴더 열기")}
        </button>
        <button
          className="btn small"
          onClick={async () => {
            try {
              await api.createSamplePlugin();
              usePlugins.getState().reload();
              toast(tx("예시 플러그인을 넣었습니다 · 아래에서 켜 보세요"));
            } catch (e) {
              toast(errorMessage(e), "error");
            }
          }}
        >
          {tx("예시 플러그인 넣기")}
        </button>
        <button className="btn small ghost" onClick={() => usePlugins.getState().reload()} title={tx("플러그인 폴더를 다시 읽고 켜진 플러그인을 다시 시작합니다")}>
          {tx("다시 읽기")}
        </button>
      </div>
      {!infos.length && <p className="muted small pad">{tx("플러그인 폴더에 플러그인이 없습니다.")}</p>}
      {infos.map((p) => {
        const on = !p.error && !!p.granted;
        return (
          <div className="set-row plugin-row" key={p.id}>
            <div>
              <div>
                {p.name} {p.version && <span className="muted small">v{p.version}</span>}
                {p.author && <span className="muted small"> · {p.author}</span>}
              </div>
              {p.description && <div className="muted small">{p.description}</div>}
              <div className="muted small">
                {tx("권한: {0}", p.permissions.length ? p.permissions.map((x) => PERMISSION_LABEL[x]?.split(" (")[0] ?? x).join(", ") : tx("없음"))}
              </div>
              {p.error && <div className="error-text small">{tx("쓸 수 없음: {0}", p.error)}</div>}
              {p.changed && <div className="error-text small">{tx("코드나 권한이 바뀌었습니다. 내용을 확인한 뒤 다시 켜야 동작합니다")}</div>}
              {on && errors[p.id] && <div className="error-text small">{tx("오류: {0}", errors[p.id])}</div>}
            </div>
            <div className="set-ctl">
              <label className="switch-label">
                <input type="checkbox" disabled={!!p.error} checked={on} onChange={(e) => void turn(p.id, e.target.checked)} /> {on ? tx("켜짐") : tx("꺼짐")}
              </label>
            </div>
          </div>
        );
      })}
    </>
  );
}

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="set-row">
      <div>
        <div>{label}</div>
        {hint && <div className="muted small">{hint}</div>}
      </div>
      <div className="set-ctl">{children}</div>
    </div>
  );
}

function TextRow({ label, hint, value, onCommit }: { label: string; hint?: string; value: string; onCommit: (v: string) => void }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => draft.trim() && draft !== value && onCommit(draft.trim());
  return (
    <Row label={label} hint={hint}>
      <input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => !e.nativeEvent.isComposing && e.key === "Enter" && commit()}
      />
    </Row>
  );
}
