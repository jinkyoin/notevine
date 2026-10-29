# 화면 자동 테스트 (Windows 11)

실제 앱 창을 Playwright로 조작해 확인한다. 앱의 WebView2에 원격 디버깅 포트를 열고 붙는다.

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
node tests/e2e/ai-research.cjs claude  # 질문 하나로 노트+웹 조사 → 새 노트 저장 (실제 AI·웹 검색, codex도 가능)
node tests/e2e/format.cjs      # 서식 막대·읽기 모드 (웹 요청 없음 확인 포함)
node tests/e2e/ai-login.cjs    # 로그아웃·미설치일 때 로그인 버튼·설치 안내 (백엔드 응답을 흉내 냄, 실제 로그인 없음)
```

- 개발 모드에서만 열리는 `window.__notevine`(앱 상태)으로 폴더 선택 대화상자 같은 OS 창을 건너뛴다.
- 테스트 볼트와 스크린샷은 `%TEMP%\notevine-e2e`에 만들어진다.

## 성능 측정 (NFR-PRF-01~05)

```bash
node scripts/gen-test-vault.mjs "%TEMP%\notevine-e2e\vault10k" 10000   # 1만 노트 + 1MB 노트
npm run tauri build                                                    # 릴리스 빌드
npm run test:e2e:perf                                                  # 릴리스 exe를 직접 띄워 측정
```

측정 항목: 최초 인덱싱(≤60초), 인덱스가 있을 때 시작(≤3초), 검색 20개 평균(≤200ms),
1MB 노트 입력 지연(≤50ms), 유휴 메모리(≤200MB), 설치 파일 크기(≤30MB).
