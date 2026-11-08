# 기여 안내

Notevine에 관심을 가져 주셔서 고맙습니다. 버그 제보, 제안, 코드 기여 모두 환영합니다.

## 이슈

- **버그:** 재현 순서, 기대한 동작과 실제 동작, Windows 버전, Notevine 버전(설정 → 정보)을 적어 주세요.
  노트 내용이 필요하면 민감한 내용은 지우고 최소한으로 줄여 주세요.
- **데이터 유실·충돌 관련 버그**는 가장 먼저 봅니다. 제목에 `[데이터]`를 붙여 주세요.
- **제안:** 어떤 기록 작업에서 무엇이 불편한지부터 적어 주세요.

## 개발 환경

README의 '개발' 절을 따라 설치한 뒤:

```bash
npm install
npm run tauri dev
```

## 코드 구조

| 위치 | 내용 |
| --- | --- |
| `src-tauri/src/vault.rs` | 노트 폴더: 파일 읽기·원자적 저장·이름 변경·이동·삭제, 충돌 감지 |
| `src-tauri/src/history.rs` | `.app/history.db` 버전 저장 (zstd, 5분 묶음) |
| `src-tauri/src/index.rs`, `search.rs` | `.app/index.db` 인덱스와 검색 (FTS5 trigram) |
| `src-tauri/src/parse.rs`, `rewrite.rs` | 마크다운에서 속성·태그·링크 추출, 이름 변경 시 링크 고쳐 쓰기 |
| `src-tauri/src/watcher.rs` | 외부 변경 감시 |
| `src-tauri/src/workspace.rs`, `extras.rs` | 설정·프리셋·템플릿, 히스토리 복원·비교, 첨부 |
| `src-tauri/src/ai.rs`, `ai_api.rs`, `src/ai.ts`, `src/aiStore.ts` | AI 도우미: Claude Code·Codex CLI 감지·실행, API 키·Ollama 연결, 관련 노트 찾기, 질의·작성 흐름 |
| `src-tauri/src/drive.rs` | Google Drive·OneDrive 폴더: 앱 데이터를 드라이브 밖에 두기, 잠긴 파일 재시도 |
| `src-tauri/src/backup.rs`, `trust.rs` | Git 백업, 받은 노트 폴더가 이 PC에서 스스로 정하지 못하게 하는 허락 기록 |
| `src-tauri/src/plugins.rs`, `src/plugins.ts` | 플러그인 찾기, 샌드박스 프레임과 권한 확인 |
| `src-tauri/src/web.rs`, `canvas.rs`, `tray.rs`, `recent.rs`, `paths.rs` | 웹 페이지 클립, 캔버스 파일, 트레이, 최근 노트 폴더, 경로 규칙 |
| `src-tauri/src/commands.rs` ↔ `src/api.ts` | Tauri 명령과 그 TypeScript 래퍼 (이름·인자를 함께 바꿀 것) |
| `src/editor/` | CodeMirror 6 확장: 라이브 미리보기, 위키링크, 첨부, frontmatter 접기 |
| `src/components/` | 화면 (주석에 화면설계서의 SCR 번호) |
| `src/lib/`, `src/i18n/`, `src/updates.ts` | 화면 없는 로직과 단위 테스트, 영어 번역(`en.json`), 앱 업데이트 |
| `src/commands.ts`, `src/appCommands.ts` | 명령 레지스트리. 명령 팔레트와 단축키가 모두 여기서 나옴 |

## 원칙

1. **노트를 잃으면 안 됩니다.** 저장은 임시 파일 → 교체로 하고, 다른 프로그램이 바꾼 내용을 덮어쓰지 않습니다.
   파일 I/O·링크 치환·히스토리 로직을 바꾸면 테스트를 함께 추가해 주세요.
2. **원본은 `.md` 파일뿐입니다.** 독자 형식을 만들지 않습니다. 인덱스·히스토리는 외부 서버로 보내지 않습니다. 보통은 `.app/`에 두고, 드라이브 폴더에서는 이 PC의 앱 데이터 폴더에 둡니다.
3. **사용자가 시키지 않은 네트워크 접속은 없습니다.** 텔레메트리, 원격 이미지 로딩 등을 넣지 않습니다. 예외는 사용자가 켜거나 눌러서 쓰는 것뿐입니다: AI 도우미(확인한 내용만 전송), 업데이트 확인, 웹 페이지 클립, network 권한을 허락한 플러그인, 원격 저장소를 넣은 Git 백업 (요구사항정의서 NFR-SEC-02). 다른 앱의 로그인 정보(토큰·쿠키)는 절대 읽지 않습니다.
4. **한글 우선.** 경로는 NFC로 정규화하고, 한글 입력(IME) 조합 중에는 단축키·자동완성을 보류합니다.

## 풀 리퀘스트

- `main`에서 브랜치를 만들어 작업해 주세요.
- 올리기 전에 아래가 모두 통과해야 합니다. GitHub Actions에서도 같은 검사를 돌립니다.

```bash
npm run typecheck
npm test
cargo test --manifest-path src-tauri/Cargo.toml
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings   # 경고 0개
```

- 화면을 바꿨다면 스크린샷을 붙이고, 관련 요구사항 ID(예: FR-LNK-05)나 화면 번호(예: SCR-04)를 적어 주세요.
- 커밋 메시지는 한국어 또는 영어 모두 괜찮습니다.

## 릴리스

- 태그(`v*`)를 푸시하면 GitHub Actions가 설치 파일과 업데이트 파일을 만들어 초안 릴리스를 올린다. 초안을 확인한 뒤 직접 게시한다. 게시 전에 그 커밋의 CI 결과도 확인한다.
- 업데이트 파일 서명에 저장소 비밀값 `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`가 필요하다. 비밀키를 잃으면 이미 설치한 사용자에게 업데이트를 보낼 수 없으므로 따로 백업한다. 저장소에는 넣지 않는다.
- 서명까지 로컬에서 시험하려면 `TAURI_SIGNING_PRIVATE_KEY`에 비밀키 파일 경로를 지정하고 `npm run tauri build -- --config src-tauri/tauri.release.conf.json`을 실행한다. 일반 `npm run tauri build`는 키 없이 된다.
- 오픈소스 고지(`public/THIRD-PARTY-NOTICES.txt`)는 빌드 전에 `scripts/gen-notices.mjs --check`가 만든다. 라이선스 원문을 찾지 못한 패키지가 있으면 빌드가 실패하므로, 패키지에 원문이 없으면 `scripts/license-texts`에 넣는다. 앱 아이콘은 `src-tauri/app-icon.svg`에서 `npx tauri icon`으로 만든다.

## 라이선스

기여한 코드는 MIT 라이선스로 배포됩니다.
