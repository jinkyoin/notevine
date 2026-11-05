# 화면 자동 테스트 (Windows 11)

실제 앱 창을 Playwright로 조작해 확인한다. 앱의 WebView2에 원격 디버깅 포트를 열고 붙는다.

개발용(디버그) 빌드는 설치한 앱과 설정을 나눠 쓴다: 설정 폴더 `%APPDATA%\net.notevine.app.dev`(최근 노트 폴더·트레이 등), WebView2 저장소 `%LOCALAPPDATA%\net.notevine.app.dev\EBWebView`, API 키 이름 "Notevine AI (dev)". Windows 시작 프로그램 등록도 하지 않는다. 그래서 테스트가 임시 노트 폴더를 열어도 설치한 앱의 최근 목록은 바뀌지 않는다. `perf.cjs`만은 릴리스 exe를 띄우므로 설치한 앱의 최근 목록에 측정용 노트 폴더가 남는다.

```bash
node tests/e2e/plugins-canvas.cjs [스크린샷 폴더]  # 플러그인 샌드박스·권한, 캔버스
node tests/e2e/ai-edits.cjs [폴더] [모델]          # AI 노트 작업 (이 PC의 Ollama로 실제 제안, 노트는 PC 밖으로 안 나감)
node tests/e2e/english-backup.cjs [폴더]            # 영어 화면, Git 백업
node tests/e2e/vault-trust.cjs                      # 받은 노트 폴더가 스스로 실행하는 것이 없는지 (Git·플러그인·CSS·실행 파일·CSP·창 이동)
```

## 기능 시나리오 (day4~6)

```bash
# 1) 개발 모드로 앱 실행 (디버깅 포트 9222)
WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9222" npm run tauri dev
# 2) 다른 터미널에서
node tests/e2e/day4.cjs   # 링크 자동완성·이동·백링크·이름 변경 시 링크 갱신
node tests/e2e/day5.cjs   # 검색·필터, 빠른 열기, 속성 패널
node tests/e2e/day6.cjs   # 프리셋·업무일지·빠른 메모·아이디어 보드·첨부·히스토리·설정
node tests/e2e/ai.cjs     # AI 도우미 (Claude Code·Codex CLI로 실제 질의, 구독 사용량을 조금 씀)
node tests/e2e/ai-private.cjs  # #비공개 노트가 AI로 나가지 않는지 (AI 호출 없음)
node tests/e2e/ai-web-request.cjs claude # 입력 칸 하나로: 노트 질문은 확인, 웹 요청은 바로 검색, 작성은 열린 노트 제안, 템플릿 형식 (실제 AI·웹 검색)
node tests/e2e/ai-research.cjs claude  # 질문 하나로 노트+웹 조사 → 새 노트 저장 (실제 AI·웹 검색, codex도 가능)
node tests/e2e/format.cjs      # 서식 막대·읽기 모드 (웹 요청 없음 확인 포함)
node tests/e2e/ai-login.cjs    # 로그아웃·미설치일 때 로그인 버튼·설치 안내 (백엔드 응답을 흉내 냄, 실제 로그인 없음)
```

- 개발 모드에서만 열리는 `window.__notevine`(앱 상태)으로 폴더 선택 대화상자 같은 OS 창을 건너뛴다.
- 테스트 노트 폴더와 스크린샷은 `%TEMP%\notevine-e2e`에 만들어진다.

## 성능 측정 (NFR-PRF-01~05)

```bash
node scripts/gen-test-vault.mjs "%TEMP%\notevine-e2e\vault10k" 10000   # 1만 노트 + 1MB 노트
npm run tauri build                                                    # 릴리스 빌드
npm run test:e2e:perf                                                  # 릴리스 exe를 직접 띄워 측정
```

측정 항목: 최초 인덱싱(≤60초), 인덱스가 있을 때 시작(≤3초), 검색 20개 평균(≤200ms),
1MB 노트 입력 지연(≤50ms), 유휴 메모리(≤200MB), 설치 파일 크기(≤30MB).
