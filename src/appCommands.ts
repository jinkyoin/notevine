// 앱 기본 명령. 단축키는 화면설계서 '단축키' 표를 따른다.
import { registerCommands } from "./commands";
import { useApp } from "./store";

const st = () => useApp.getState();
const hasVault = () => !!st().vault;
const hasNote = () => !!st().openPath;
/** Shortcuts that open dialogs shouldn't fire while another dialog is up. */
const noModal = () => hasVault() && !st().modal && !st().quickOpen && !st().versionView;

export function registerAppCommands(): () => void {
  return registerCommands([
    { id: "note.new", title: "새 노트 (템플릿 선택)", keys: "Ctrl+N", when: noModal, run: () => st().setModal("template") },
    { id: "note.quickOpen", title: "빠른 열기", keys: "Ctrl+O", when: noModal, run: () => st().setQuickOpen(true) },
    { id: "app.palette", title: "명령 팔레트", keys: "Ctrl+P", when: noModal, run: () => st().setModal("palette") },
    { id: "note.quickMemo", title: "빠른 메모", keys: "Ctrl+Shift+N", when: noModal, run: () => st().setModal("quickMemo") },
    { id: "journal.today", title: "오늘 업무일지", keys: "Ctrl+Shift+D", when: noModal, run: () => st().openTodayJournal() },
    {
      id: "search.focus",
      title: "검색",
      keys: "Ctrl+Shift+F",
      when: hasVault,
      run: () => {
        st().setPanels({ leftOpen: true });
        st().focusSearch();
      },
    },
    { id: "view.left", title: "왼쪽 사이드바 접기/펴기", keys: "Ctrl+\\", when: hasVault, run: () => st().setPanels({ leftOpen: !st().leftOpen }) },
    {
      id: "view.right",
      title: "오른쪽 패널 접기/펴기",
      keys: "Ctrl+Shift+\\",
      when: hasVault,
      run: () => st().setPanels({ rightOpen: !st().rightOpen }),
    },
    { id: "app.settings", title: "설정", keys: "Ctrl+,", when: noModal, run: () => st().setModal("settings") },
    {
      id: "note.rename",
      title: "현재 노트 이름 변경",
      keys: "F2",
      when: () => hasNote() && !st().modal,
      run: () => st().setEditing({ mode: "rename", path: st().openPath! }),
    },
    { id: "nav.back", title: "이전 노트", keys: "Alt+ArrowLeft", when: hasVault, run: () => st().goBack() },
    { id: "nav.forward", title: "다음 노트", keys: "Alt+ArrowRight", when: hasVault, run: () => st().goForward() },
    {
      id: "history.open",
      title: "현재 노트 히스토리 보기",
      when: hasNote,
      run: () => st().setVersionView({ path: st().openPath!, id: null }),
    },
    { id: "history.deleted", title: "삭제된 노트 히스토리", when: hasVault, run: () => st().setModal("deleted") },
    {
      id: "preset.enable",
      title: "기록 관리 프리셋 켜기 (폴더·템플릿 만들기)",
      when: () => hasVault() && !st().config.preset_enabled,
      run: () => st().applyPreset(),
    },
    {
      id: "ideas.board",
      title: "아이디어 보드",
      when: () => hasVault() && st().config.preset_enabled,
      run: () => {
        st().setPanels({ leftOpen: true });
        st().setSidebarTab("ideas");
      },
    },
    {
      id: "view.theme",
      title: "테마 바꾸기 (시스템 → 라이트 → 다크)",
      when: hasVault,
      run: () => {
        const order = ["system", "light", "dark"] as const;
        const c = st().config;
        void st().saveConfig({ ...c, theme: order[(order.indexOf(c.theme) + 1) % order.length] });
      },
    },
    { id: "vault.switch", title: "볼트 바꾸기", when: hasVault, run: () => st().closeVault() },
  ]);
}
