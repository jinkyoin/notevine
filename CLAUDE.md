# Notevine

마크다운 폴더(노트 폴더)에 기록·링크·검색·히스토리를 얹는 Windows 데스크톱 앱. Tauri 2(Rust) + React/TypeScript + CodeMirror 6.
코드 구조 표, 원칙, PR 검사 목록은 [CONTRIBUTING.md](CONTRIBUTING.md), 기능 설명은 [docs/사용자매뉴얼.md](docs/사용자매뉴얼.md), 요구사항 ID(FR-·NFR-)는 [docs/요구사항정의서.md](docs/요구사항정의서.md)를 본다.

## 명령

```bash
npm run tauri dev        # 개발 실행
npm run typecheck        # tsc --noEmit
npm test                 # vitest (단위 테스트)
cargo test --manifest-path src-tauri/Cargo.toml
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings   # 경고 0개
npm run tauri build      # 릴리스 빌드 (설치 파일: src-tauri/target/release/bundle/{nsis,msi})
```

## 코드를 고칠 때

- 화면 글은 한국어로 쓰고 `tx("…")`로 감싼다. 영어는 `src/i18n/en.json`에 같은 키로 추가한다(없으면 한국어로 보인다). 노트 내용·폴더 이름·AI 지시문은 번역하지 않는다.
- Tauri 명령은 `src-tauri/src/commands.rs`와 `src/api.ts`를 함께 바꾼다(이름·인자 일치).
- 명령 팔레트·단축키 항목은 `src/appCommands.ts`·`src/commands.ts`에 등록한다.
- 화면 컴포넌트 주석에 화면설계서 SCR 번호, 요구사항 ID를 적는 관례를 따른다.
- 노트를 잃으면 안 된다. 저장·이동·링크 치환·히스토리 코드를 바꾸면 테스트를 같이 추가한다.
- 사용자가 시키지 않은 네트워크 접속, 텔레메트리, 원격 이미지 로딩을 넣지 않는다.
- 경로는 NFC로 정규화한다. 한글 입력(IME) 조합 중에는 단축키·자동완성을 보류한다.
- 탭은 노트 경로로 식별한다(`tabs`, `openPath`). 폴더 보기(표·보드·캘린더·그래프)는 노트 탭과 따로 `viewTabs`로 관리하고 화면에는 `tableView` + `folderMode`로 나온다.

## 작업 방식

- 수정이 끝나면 `npm run tauri build`로 릴리스 빌드까지 한다. 빌드가 덮어쓰는 `src-tauri\target\release\notevine.exe`로 띄운 앱만 닫는다. 사용자가 쓰는 설치본(`%LOCALAPPDATA%\Notevine\notevine.exe`)과 MCP 서버 프로세스는 닫지 않는다. 설치본을 새 버전으로 바꾸는 일은 사용자가 요청할 때만 하고, 앱이 닫힌다고 먼저 알린다.
- 커밋·푸시·태그·릴리스는 사용자가 요청할 때만 한다. 이번 작업과 무관한 수정·untracked 파일은 커밋에 넣지 않는다.
- GitHub 릴리스는 `v*` 태그를 푸시하면 Actions가 초안으로 올린다. 게시는 사용자가 직접 하고, 게시 전에 CI 결과를 확인한다.
- 문서(계획서·스펙·보고서)는 `docs/`에 Markdown으로 저장하고, 다이어그램은 Mermaid로 쓴다.
- 사용자에게는 한국어로 답한다.

## 버전 번호

- 메뉴·기능 추가가 있으면 가운데 자리를 올리고 끝자리는 0으로 한다(0.4.6 → 0.5.0).
- 버그 수정·화면 다듬기뿐이면 끝자리를 올린다(0.4.5 → 0.4.6).
- 지난 릴리스 이후 기능 추가가 하나라도 있으면 가운데 자리를 올린다.
- 올릴 파일 6개: `package.json`, `package-lock.json`(2곳), `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock`, `src-tauri/tauri.conf.json`, `docs/사용자매뉴얼.md`의 "대상 버전". 버전은 요청받았을 때만 올린다.
