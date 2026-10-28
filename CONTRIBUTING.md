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
| `src-tauri/src/vault.rs` | 볼트: 파일 읽기·원자적 저장·이름 변경·이동·삭제, 충돌 감지 |
| `src-tauri/src/history.rs` | `.app/history.db` 버전 저장 (zstd, 5분 묶음) |
| `src-tauri/src/index.rs`, `search.rs` | `.app/index.db` 인덱스와 검색 (FTS5 trigram) |
| `src-tauri/src/parse.rs`, `rewrite.rs` | 마크다운에서 속성·태그·링크 추출, 이름 변경 시 링크 고쳐 쓰기 |
| `src-tauri/src/watcher.rs` | 외부 변경 감시 |
| `src-tauri/src/workspace.rs`, `extras.rs` | 설정·프리셋·템플릿, 히스토리 복원·비교, 첨부 |
| `src-tauri/src/commands.rs` ↔ `src/api.ts` | Tauri 명령과 그 TypeScript 래퍼 (이름·인자를 함께 바꿀 것) |
| `src/editor/` | CodeMirror 6 확장: 라이브 미리보기, 위키링크, 첨부, frontmatter 접기 |
| `src/components/` | 화면 (주석에 화면설계서의 SCR 번호) |
| `src/commands.ts`, `src/appCommands.ts` | 명령 레지스트리. 명령 팔레트와 단축키가 모두 여기서 나옴 |

## 원칙

1. **노트를 잃으면 안 됩니다.** 저장은 임시 파일 → 교체로 하고, 다른 프로그램이 바꾼 내용을 덮어쓰지 않습니다.
   파일 I/O·링크 치환·히스토리 로직을 바꾸면 테스트를 함께 추가해 주세요.
2. **원본은 `.md` 파일뿐입니다.** 독자 형식을 만들지 않습니다. `.app/` 안의 데이터는 볼트 밖으로 나가지 않습니다.
3. **네트워크를 쓰지 않습니다.** 텔레메트리, 원격 이미지 로딩 등을 넣지 않습니다.
4. **한글 우선.** 경로는 NFC로 정규화하고, 한글 입력(IME) 조합 중에는 단축키·자동완성을 보류합니다.

## 풀 리퀘스트

- `main`에서 브랜치를 만들어 작업해 주세요.
- 올리기 전에 아래가 모두 통과해야 합니다. GitHub Actions에서도 같은 검사를 돌립니다.

```bash
npm run typecheck
npm test
cargo test --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets   # 경고 0개
```

- 화면을 바꿨다면 스크린샷을 붙이고, 관련 요구사항 ID(예: FR-LNK-05)나 화면 번호(예: SCR-04)를 적어 주세요.
- 커밋 메시지는 한국어 또는 영어 모두 괜찮습니다.

## 라이선스

기여한 코드는 MIT 라이선스로 배포됩니다.
