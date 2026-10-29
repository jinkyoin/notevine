// 앱 기본 명령. 단축키는 화면설계서 '단축키' 표를 따른다.
import { registerCommands } from "./commands";
import { useApp } from "./store";
import { useAi } from "./aiStore";
import { WRITE_LABEL, type WriteTask } from "./ai";

const st = () => useApp.getState();
const hasVault = () => !!st().vault;
const hasNote = () => !!st().openPath;
/**
 * Shortcuts that open dialogs shouldn't fire while another dialog is up. The palette
 * doesn't count: it lists commands while it is open and closes itself before running one.
 */
const noModal = () => hasVault() && (!st().modal || st().modal === "palette") && !st().quickOpen && !st().versionView;

export function registerAppCommands(): () => void {
  return registerCommands([
    { id: "note.new", title: "새 노트 (템플릿 선택)", keys: "Ctrl+N", when: noModal, run: () => st().setModal("template") },
    {
      id: "note.insertTemplate",
      title: "템플릿 삽입 (현재 노트)",
      keywords: "템플릿 넣기 붙이기 양식 서식 template",
      when: () => hasNote() && noModal(),
      run: () => st().setModal("insertTemplate"),
    },
    { id: "note.quickOpen", title: "빠른 열기", keys: "Ctrl+O", when: noModal, run: () => st().setQuickOpen(true) },
    { id: "app.palette", title: "명령 팔레트", keys: "Ctrl+P", when: noModal, run: () => st().setModal("palette") },
    { id: "note.quickMemo", title: "빠른 메모", keywords: "아이디어 메모 inbox", keys: "Ctrl+Shift+N", when: noModal, run: () => st().setModal("quickMemo") },
    {
      id: "journal.today",
      title: "오늘 업무일지",
      keys: "Ctrl+Shift+D",
      keywords: "업무일지 일지 오늘 일기 journal",
      when: noModal,
      run: () => st().openTodayJournal(),
    },
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
    {
      id: "help.markdown",
      title: "마크다운 문법 도움말",
      keywords: "도움말 문법 서식 help markdown 사용법",
      keys: "F1",
      when: noModal,
      run: () => st().setModal("mdHelp"),
    },
    { id: "app.settings", title: "설정", keys: "Ctrl+,", when: noModal, run: () => st().setModal("settings") },
    {
      id: "note.rename",
      title: "현재 노트 이름 변경",
      keys: "F2",
      when: () => hasNote() && !st().modal,
      // In the title above the editor: always on screen, unlike the file tree.
      run: () => st().editTitle(),
    },
    {
      id: "note.readMode",
      title: "편집/읽기 모드 전환",
      keywords: "미리보기 보기 preview 렌더링 서식",
      keys: "Ctrl+E",
      when: hasNote,
      run: () => st().setReadMode(!st().readMode),
    },
    { id: "nav.back", title: "이전 노트", keys: "Alt+ArrowLeft", when: hasVault, run: () => st().goBack() },
    { id: "nav.forward", title: "다음 노트", keys: "Alt+ArrowRight", when: hasVault, run: () => st().goForward() },
    {
      id: "history.open",
      title: "현재 노트 히스토리 보기",
      keywords: "버전 되돌리기 복원 이전 내용 변경 기록",
      when: hasNote,
      run: () => st().setVersionView({ path: st().openPath!, id: null }),
    },
    { id: "history.deleted", title: "삭제된 노트 히스토리", keywords: "휴지통 되살리기 복원", when: hasVault, run: () => st().setModal("deleted") },
    {
      id: "preset.enable",
      title: "기본 구조 만들기 (폴더·템플릿)",
      keywords: "기본 구조 디폴트 초기 설정 기록 관리 프리셋 업무일지 아이디어 조사자료 템플릿 폴더",
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
    {
      id: "ai.panel",
      title: "AI: 질문하기 (노트·웹)",
      keys: "Ctrl+J",
      keywords: "ai 인공지능 질문 채팅 웹 검색 인터넷 조사 리서치 자료 claude codex chatgpt",
      when: hasVault,
      run: () => st().focusAi(),
    },
    ...(Object.keys(WRITE_LABEL) as WriteTask[]).map((task) => ({
      id: `ai.write.${task}`,
      title: `AI: ${WRITE_LABEL[task]} (선택한 글)`,
      keywords: "ai 인공지능 글쓰기 작성",
      when: hasNote,
      run: () => useAi.getState().write(task),
    })),
    {
      id: "ai.weekly",
      title: "AI: 이번 주 업무일지로 주간 회고 만들기",
      keywords: "ai 회고 주간 정리 업무일지 요약",
      when: hasVault,
      run: () => useAi.getState().weeklyReview(),
    },
  ]);
}
