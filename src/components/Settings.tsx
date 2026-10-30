// SCR-16 설정: 일반 · 편집기 · 파일·링크 · 프리셋 · 히스토리 · 정보.
import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import { api, errorMessage, type VaultConfig } from "../api";
import { useApp } from "../store";
import { useAi } from "../aiStore";
import { ProviderFix } from "./AiPanel";

type Tab = "general" | "editor" | "files" | "preset" | "ai" | "history" | "about";
const TABS: [Tab, string][] = [
  ["general", "일반"],
  ["editor", "편집기"],
  ["files", "파일·링크"],
  ["preset", "프리셋"],
  ["ai", "AI"],
  ["history", "히스토리"],
  ["about", "정보"],
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
  const { saveConfig, applyPreset, toast } = useApp.getState();
  const [tab, setTab] = useState<Tab>("general");
  const [version, setVersion] = useState("");

  useEffect(() => {
    getVersion().then(setVersion).catch(() => setVersion("0.1.0"));
  }, []);

  const set = <K extends keyof VaultConfig>(key: K, value: VaultConfig[K]) => void saveConfig({ ...config, [key]: value });

  return (
    <div className="modal-backdrop" onMouseDown={close} onKeyDown={(e) => e.key === "Escape" && close()}>
      <div className="modal settings" tabIndex={-1} onMouseDown={(e) => e.stopPropagation()}>
        <div className="vv-head">
          <h2>설정</h2>
          <button className="icon-btn" title="닫기 (Esc)" onClick={close}>
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
                <Row label="테마">
                  <select value={config.theme} onChange={(e) => set("theme", e.target.value as VaultConfig["theme"])}>
                    <option value="system">시스템 설정 따르기</option>
                    <option value="light">라이트</option>
                    <option value="dark">다크</option>
                  </select>
                </Row>
                <Row label="언어" hint="영어 화면은 v0.2에서 지원합니다">
                  <select value="ko" disabled>
                    <option value="ko">한국어</option>
                  </select>
                </Row>
                <Row label="시작할 때" hint="앱을 켜면 마지막 노트 폴더와 노트를 다시 엽니다">
                  <span className="muted small">마지막 노트 폴더 열기 (항상)</span>
                </Row>
              </>
            )}
            {tab === "editor" && (
              <>
                <Row label="링크 이동" hint="노트 링크를 눌렀을 때 이동하는 방법">
                  <select value={config.link_click} onChange={(e) => set("link_click", e.target.value as VaultConfig["link_click"])}>
                    <option value="ctrl">Ctrl+클릭</option>
                    <option value="click">클릭</option>
                  </select>
                </Row>
                <Row label="자동 저장" hint="입력을 멈추고 저장하기까지 기다리는 시간">
                  <select value={config.autosave_ms} onChange={(e) => set("autosave_ms", Number(e.target.value))}>
                    {[500, 1000, 2000, 5000].map((ms) => (
                      <option key={ms} value={ms}>
                        {ms / 1000}초
                      </option>
                    ))}
                  </select>
                </Row>
              </>
            )}
            {tab === "files" && (
              <>
                <TextRow label="첨부 폴더" value={config.attachment_folder} onCommit={(v) => set("attachment_folder", v)} />
                <Row label="링크 자동 갱신" hint="노트 이름을 바꾸거나 옮길 때 그 노트를 가리키는 링크를 고칩니다">
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
                  label="기본 구조 (PARA)"
                  hint="켜면 프로젝트·영역·자료·보관 폴더와 템플릿 5종을 만들고 오늘 업무일지·아이디어 보드를 씁니다. 끄면 이 기능만 숨기고 기존 노트·폴더는 그대로입니다"
                >
                  <input
                    type="checkbox"
                    checked={config.preset_enabled}
                    onChange={(e) => (e.target.checked ? void applyPreset() : set("preset_enabled", false))}
                  />
                </Row>
                <TextRow label="Inbox 폴더" value={config.inbox_folder} onCommit={(v) => set("inbox_folder", v)} />
                <TextRow label="프로젝트 폴더" value={config.project_folder} onCommit={(v) => set("project_folder", v)} />
                <TextRow label="영역 폴더" value={config.area_folder} onCommit={(v) => set("area_folder", v)} />
                <TextRow label="자료 폴더" value={config.resource_folder} onCommit={(v) => set("resource_folder", v)} />
                <TextRow label="보관 폴더" value={config.archive_folder} onCommit={(v) => set("archive_folder", v)} />
                <TextRow label="업무일지 폴더" value={config.journal_folder} onCommit={(v) => set("journal_folder", v)} />
                <TextRow label="아이디어 폴더" value={config.idea_folder} onCommit={(v) => set("idea_folder", v)} />
                <TextRow label="조사자료 폴더" value={config.research_folder} onCommit={(v) => set("research_folder", v)} />
                <TextRow label="템플릿 폴더" value={config.template_folder} onCommit={(v) => set("template_folder", v)} />
                <TextRow
                  label="업무일지 경로"
                  hint="{{YYYY}} {{MM}} {{DD}} {{YYYY-MM-DD}}를 쓸 수 있습니다"
                  value={config.journal_path}
                  onCommit={(v) => set("journal_path", v)}
                />
                <TextRow
                  label="아이디어 상태"
                  hint="쉼표로 구분, 순서대로 보드에 표시됩니다"
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
                <Row label="묶음 간격" hint="같은 노트를 이어서 저장하면 5분 단위로 한 버전으로 묶습니다">
                  <span>5분</span>
                </Row>
                <Row label="저장 위치" hint="다시 만들 수 없는 파일이니 노트 폴더와 함께 백업하세요">
                  <span className="mono small">.app/history.db</span>
                  <button
                    className="btn small"
                    onClick={() =>
                      vault && void revealItemInDir(`${vault.root}\\.app\\history.db`).catch((e) => toast(errorMessage(e), "error"))
                    }
                  >
                    폴더 열기
                  </button>
                </Row>
                <Row label="삭제된 노트" hint="지운 노트도 히스토리에서 되살릴 수 있습니다">
                  <button className="btn small" onClick={() => useApp.getState().setModal("deleted")}>
                    삭제된 노트 히스토리
                  </button>
                </Row>
              </>
            )}
            {tab === "about" && (
              <>
                <Row label="버전">
                  <span>Notevine {version}</span>
                </Row>
                <Row label="라이선스">
                  <span>MIT</span>
                </Row>
                <Row label="소스 코드">
                  <button className="btn small" onClick={() => void openUrl("https://github.com/jinkyoin/notevine")}>
                    GitHub 열기
                  </button>
                </Row>
                <Row label="검색 인덱스" hint="검색이 이상하면 인덱스를 처음부터 다시 만듭니다. 노트는 바뀌지 않습니다">
                  <button
                    className="btn small"
                    onClick={async () => {
                      try {
                        const n = await api.rebuildIndex();
                        toast(`인덱스를 다시 만들었습니다 · 노트 ${n}개`);
                        await useApp.getState().refreshTree();
                      } catch (e) {
                        toast(errorMessage(e), "error");
                      }
                    }}
                  >
                    인덱스 다시 만들기
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

function AiSettings() {
  const { enabled, providers, providerId, models } = useAi();
  const { setEnabled, setProvider, setModel, detect, current } = useAi.getState();
  useEffect(() => {
    if (!providers) void detect();
  }, [providers, detect]);
  const cur = current();
  return (
    <>
      <Row label="AI 도우미" hint="켜도 질문할 때마다 보낼 노트를 먼저 보여 주고, 확인한 것만 보냅니다">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
      </Row>
      <Row label="연결된 AI" hint="PC에 설치·로그인된 공식 CLI를 그대로 씁니다. Notevine은 로그인 정보를 읽지 않습니다">
        <button className="btn small" onClick={() => void detect(true)}>
          다시 찾기
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
                    ? "로그인됨 · 사용할 수 있음"
                    : "설치됨 · 사용할 수 있음 (로그인 안 되어 있으면 질문할 때 안내합니다)"
                  : (p.detail ?? "사용할 수 없음")}
              </div>
              {!usable && <ProviderFix p={p} />}
            </div>
            <div className="set-ctl">
              <input
                className="model-input"
                placeholder="모델 (비우면 기본)"
                key={models[p.id] ?? ""}
                defaultValue={models[p.id] ?? ""}
                title="CLI에 넘길 모델 이름(예: opus, sonnet, haiku). 계정에서 쓸 수 없는 모델이면 기본 모델로 다시 보냅니다"
                onBlur={(e) => setModel(p.id, e.target.value)}
              />
              <input
                type="radio"
                name="ai-provider"
                disabled={!usable}
                checked={cur?.id === p.id}
                onChange={() => setProvider(p.id)}
                title="이 AI 사용"
              />
            </div>
          </div>
        );
      })}
      {providers === null && <p className="muted small">AI를 찾는 중…</p>}
      <p className="muted small pad">
        Claude Code는 Claude Pro/Max 구독, Codex는 ChatGPT 구독으로 동작합니다. 로그인 버튼을 누르면 각 AI의 공식 로그인
        창이 열리고, 브라우저에서 로그인을 마치면 자동으로 연결됩니다. 선택: {providerId || "자동"}
      </p>
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
