// 앱 기본 명령. 단축키는 화면설계서 '단축키' 표를 따른다.
import { registerCommands } from "./commands";
import { useApp } from "./store";
import { useAi } from "./aiStore";
import { WRITE_LABEL, type WriteTask } from "./ai";
import { findNode } from "./lib/tree";
import type { FolderMode } from "./store";

import { tx } from "./i18n";
const st = () => useApp.getState();
const hasVault = () => !!st().vault;
const hasNote = () => !!st().openPath;
/**
 * Shortcuts that open dialogs shouldn't fire while another dialog is up. The palette
 * doesn't count: it lists commands while it is open and closes itself before running one.
 */
const noModal = () => hasVault() && (!st().modal || st().modal === "palette") && !st().quickOpen && !st().versionView && !st().adding && !st().switchLocked;

export function registerAppCommands(): () => void {
  return registerCommands([
    { id: "note.new", title: tx("새 노트 (템플릿 선택)"), keys: "Ctrl+N", when: noModal, run: () => st().setModal("template") },
    {
      id: "note.insertTemplate",
      title: tx("템플릿 삽입 (현재 노트)"),
      keywords: tx("템플릿 넣기 붙이기 양식 서식 template"),
      keys: "Ctrl+T",
      when: () => hasNote() && noModal(),
      run: () => st().setModal("insertTemplate"),
    },
    { id: "note.quickOpen", title: tx("빠른 열기"), keys: "Ctrl+O", when: noModal, run: () => st().setQuickOpen(true) },
    { id: "app.palette", title: tx("명령 팔레트"), keys: "Ctrl+P", when: noModal, run: () => st().setModal("palette") },
    { id: "note.quickMemo", title: tx("빠른 메모"), keywords: tx("아이디어 메모 inbox"), keys: "Ctrl+Shift+N", when: noModal, run: () => st().setModal("quickMemo") },
    {
      id: "journal.today",
      title: tx("오늘 업무일지"),
      keys: "Ctrl+Shift+D",
      keywords: tx("업무일지 일지 오늘 일기 journal"),
      when: noModal,
      run: () => st().openTodayJournal(),
    },
    {
      id: "search.focus",
      title: tx("검색"),
      keys: "Ctrl+Shift+F",
      when: hasVault,
      run: () => {
        st().setPanels({ leftOpen: true });
        st().focusSearch();
      },
    },
    { id: "view.left", title: tx("왼쪽 사이드바 접기/펴기"), keys: "Ctrl+\\", when: hasVault, run: () => st().setPanels({ leftOpen: !st().leftOpen }) },
    {
      id: "view.right",
      title: tx("오른쪽 패널 접기/펴기"),
      keys: "Ctrl+Shift+\\",
      when: hasVault,
      run: () => st().setPanels({ rightOpen: !st().rightOpen }),
    },
    {
      id: "help.markdown",
      title: tx("마크다운 문법 도움말"),
      keywords: tx("도움말 문법 서식 help markdown 사용법"),
      keys: "F1",
      when: noModal,
      run: () => st().setModal("mdHelp"),
    },
    {
      id: "ai.noteWork",
      title: tx("AI로 노트 만들기·고치기"),
      keywords: tx("AI 노트 작업 만들기 고치기 정리 수정 생성 편집 edit"),
      when: hasVault,
      run: () => st().focusAi(),
    },
    {
      id: "backup.now",
      title: tx("지금 백업 (Git)"),
      keywords: tx("백업 git 동기화 저장 깃 커밋 푸시 sync backup"),
      when: hasVault,
      run: () => st().backupNow(),
    },
    {
      id: "canvas.new",
      title: tx("새 캔버스"),
      keywords: tx("캔버스 화이트보드 보드 마인드맵 카드 canvas whiteboard"),
      when: noModal,
      run: () => st().createCanvas(st().currentDir()),
    },
    {
      id: "note.webClip",
      title: tx("웹 페이지 클립 (주소로 노트 만들기)"),
      keywords: tx("웹 클립 스크랩 저장 url 주소 인터넷 기사 블로그 clip"),
      when: noModal,
      run: () => st().setModal("clip"),
    },
    {
      id: "help.manual",
      title: tx("사용자 매뉴얼"),
      keywords: tx("도움말 사용법 설명서 안내 help manual"),
      keys: "Shift+F1",
      when: noModal,
      run: () => st().setModal("manual"),
    },
    { id: "app.settings", title: tx("설정"), keys: "Ctrl+,", when: noModal, run: () => st().setModal("settings") },
    {
      id: "note.rename",
      title: tx("현재 노트 이름 변경"),
      keys: "F2",
      when: () => hasNote() && !st().modal,
      // In the title above the editor: always on screen, unlike the file tree.
      run: () => st().editTitle(),
    },
    {
      id: "note.readMode",
      title: tx("편집/읽기 모드 전환"),
      keywords: tx("미리보기 보기 preview 렌더링 서식"),
      keys: "Ctrl+E",
      when: hasNote,
      run: () => st().setReadMode(!st().readMode),
    },
    { id: "nav.back", title: tx("이전 노트"), keys: "Alt+ArrowLeft", when: hasVault, run: () => st().goBack() },
    { id: "nav.forward", title: tx("다음 노트"), keys: "Alt+ArrowRight", when: hasVault, run: () => st().goForward() },
    { id: "tab.close", title: tx("탭 닫기"), keywords: tx("탭 닫기 tab close"), keys: "Ctrl+W", when: () => hasNote() && noModal(), run: () => st().closeTab() },
    {
      id: "tab.closeOthers",
      title: tx("다른 탭 모두 닫기"),
      keywords: tx("탭 닫기 tab close others"),
      when: () => st().tabs.length > 1 && noModal(),
      run: () => st().closeOtherTabs(),
    },
    { id: "tab.next", title: tx("다음 탭"), keywords: tx("탭 tab next"), keys: "Ctrl+Tab", when: () => st().tabs.length > 1 && noModal(), run: () => st().stepTab(1) },
    {
      id: "tab.prev",
      title: tx("이전 탭"),
      keywords: tx("탭 tab previous"),
      keys: "Ctrl+Shift+Tab",
      when: () => st().tabs.length > 1 && noModal(),
      run: () => st().stepTab(-1),
    },
    {
      id: "tab.reopen",
      title: tx("닫은 탭 다시 열기"),
      keywords: tx("탭 다시 열기 tab reopen"),
      keys: "Ctrl+Shift+T",
      when: () => noModal() && st().closedTabs.length > 0,
      run: () => st().reopenClosedTab(),
    },
    {
      id: "split.close",
      title: tx("나란히 보기 닫기"),
      keywords: tx("분할 창 나란히 오른쪽 닫기 split"),
      when: () => !!st().splitPath && noModal(),
      run: () => st().closeSplit(),
    },
    {
      id: "split.swap",
      title: tx("나란히 보기: 왼쪽·오른쪽 노트 바꾸기"),
      keywords: tx("분할 창 나란히 바꾸기 교체 swap split"),
      when: () => !!st().splitPath && hasNote() && noModal(),
      run: async () => {
        const left = st().openPath!;
        const right = st().splitPath!;
        // Save both first, so neither side reads the other's note before its edits are on disk.
        await st().flushEditor();
        st().closeSplit();
        st().openNote(right);
        st().openSplit(left);
      },
    },
    {
      id: "history.open",
      title: tx("현재 노트 히스토리 보기"),
      keywords: tx("버전 되돌리기 복원 이전 내용 변경 기록"),
      when: hasNote,
      run: () => st().setVersionView({ path: st().openPath!, id: null }),
    },
    { id: "history.deleted", title: tx("삭제된 노트 히스토리"), keywords: tx("휴지통 되살리기 복원"), when: hasVault, run: () => st().setModal("deleted") },
    {
      id: "preset.enable",
      title: tx("기본 구조 만들기 (PARA 폴더·템플릿)"),
      keywords: tx("기본 구조 디폴트 초기 설정 기록 관리 프리셋 para 프로젝트 영역 자료 보관 업무일지 아이디어 조사자료 템플릿 폴더"),
      // Again later it only adds what is missing (folders, templates, guide notes).
      when: hasVault,
      run: () => st().applyPreset(),
    },
    ...(
      [
        ["folderTable", "table", tx("표로"), tx("표 테이블 속성 목록 데이터베이스 table properties")],
        ["folderBoard", "board", tx("보드로"), tx("보드 칸반 카드 상태 status kanban board 진행")],
        ["folderCalendar", "calendar", tx("캘린더로"), tx("캘린더 달력 날짜 일정 calendar 업무일지")],
        ["folderGraph", "graph", tx("그래프로"), tx("그래프 링크 연결 관계 graph network")],
      ] as [string, FolderMode, string, string][]
    ).map(([id, mode, how, keywords]) => ({
      id: `view.${id}`,
      title: tx("현재 폴더를 {0} 보기", how),
      keywords: tx("{0} 폴더 보기", keywords),
      when: () => hasNote() && noModal(),
      run: () => {
        const p = st().openPath!;
        st().setTableView(p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "", mode);
      },
    })),
    {
      id: "view.graphAll",
      title: tx("전체 노트 그래프"),
      keywords: tx("그래프 링크 연결 관계 graph network 전체 지도"),
      when: () => hasVault() && noModal(),
      run: () => st().setTableView("", "graph"),
    },
    {
      id: "view.calendarAll",
      title: tx("전체 노트 캘린더"),
      keywords: tx("캘린더 달력 날짜 일정 calendar 업무일지 전체"),
      when: () => hasVault() && noModal(),
      run: () => st().setTableView("", "calendar"),
    },
    {
      id: "para.newProject",
      title: tx("새 프로젝트 (PARA)"),
      keywords: tx("프로젝트 새로 만들기 시작 para project 폴더 개요"),
      when: () => noModal() && !!findNode(st().tree, st().config.project_folder),
      run: () => st().startNewProject(),
    },
    ...(
      [
        ["week", 0, tx("이번 주")],
        ["week", -7, tx("지난주")],
        ["month", 0, tx("이번 달")],
        ["month", -1, tx("지난달")],
      ] as const
    ).map(([kind, back, when]) => ({
      id: `review.${kind}${back ? ".last" : ""}`,
      title: tx("{0} 회고 묶음 만들기 ({1})", kind === "week" ? tx("주간") : tx("월간"), when),
      keywords: tx("회고 리뷰 정리 묶음 요약 업무일지 회의록 review 주간 월간"),
      when: () => hasVault() && noModal(),
      run: () => {
        const d = new Date();
        if (kind === "week") d.setDate(d.getDate() + back);
        else d.setMonth(d.getMonth() + back, 1);
        return st().createReview(kind, d);
      },
    })),
    {
      id: "ideas.board",
      title: tx("아이디어 보드"),
      when: () => hasVault() && st().config.preset_enabled,
      run: () => {
        st().setPanels({ leftOpen: true });
        st().setSidebarTab("ideas");
      },
    },
    {
      id: "view.theme",
      title: tx("테마 바꾸기 (시스템 → 라이트 → 다크)"),
      when: hasVault,
      run: () => {
        const order = ["system", "light", "dark"] as const;
        const c = st().config;
        void st().saveConfig({ ...c, theme: order[(order.indexOf(c.theme) + 1) % order.length] });
      },
    },
    // Note folder rail (FR-VLT-07).
    { id: "vault.switch", title: tx("노트 폴더 더 열기"), keywords: tx("노트 폴더 바꾸기 추가 열기 vault"), when: noModal, run: () => st().setAdding(true) },
    { id: "vault.close", title: tx("노트 폴더 닫기"), keywords: tx("막대에서 닫기 vault"), when: hasVault, run: () => st().closeRailVault() },
    ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => ({
      id: `vault.go${n}`,
      title: tx("노트 폴더 {0}로 가기", n),
      keys: `Ctrl+${n}`,
      when: () => noModal() && st().rail.length >= n,
      run: () => st().switchVault(st().rail[n - 1].path),
    })),
    {
      id: "ai.panel",
      title: tx("AI: 질문하기 (노트·웹)"),
      keys: "Ctrl+J",
      keywords: tx("ai 인공지능 질문 채팅 웹 검색 인터넷 조사 리서치 자료 claude codex chatgpt"),
      when: hasVault,
      run: () => st().focusAi(),
    },
    ...(Object.keys(WRITE_LABEL) as WriteTask[]).map((task) => ({
      id: `ai.write.${task}`,
      title: tx("AI: {0} (선택한 글)", WRITE_LABEL[task]),
      keywords: tx("ai 인공지능 글쓰기 작성"),
      when: hasNote,
      run: () => useAi.getState().write(task),
    })),
    {
      id: "ai.weekly",
      title: tx("AI: 이번 주 업무일지로 주간 회고 만들기"),
      keywords: tx("ai 회고 주간 정리 업무일지 요약"),
      when: hasVault,
      run: () => useAi.getState().weeklyReview(),
    },
  ]);
}
