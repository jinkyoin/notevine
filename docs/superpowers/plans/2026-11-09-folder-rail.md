# 노트 폴더 막대 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 창 왼쪽 끝 "노트 폴더 막대"로 여러 노트 폴더를 열어 두고 클릭·Ctrl+1~9로 오가며, 돌아오면 탭·마지막 노트·스크롤이 그대로 있게 한다.

**Architecture:** 백엔드는 지금처럼 한 번에 한 폴더만 연다. 막대 목록은 앱 설정 폴더의 `vault-rail.json`(Rust `RailStore`)에 저장하고, 폴더를 바꿀 때 프런트가 지금 폴더의 화면 상태(탭·분할·펼친 폴더·AI 대화 등)를 메모리 스냅숏으로 떼어 두었다가 돌아올 때 되살린다. 탐색기에서 연 막대 밖 폴더는 저장하지 않는 "잠깐 연 폴더"로 다룬다.

**Tech Stack:** Tauri 2, Rust(serde_json, tempfile 테스트), React 18 + TypeScript, zustand, vitest, Playwright(e2e, CDP).

**Spec:** `docs/superpowers/specs/2026-11-09-folder-rail-design.md` — 계획은 이 문서를 근거로 한다. 구현하는 사람은 둘 다 읽는다.

## Global Constraints

- 대답·문서·UI 문구는 한국어. 새 `tx("…")` 문구는 모두 `src/i18n/en.json`에 영어를 넣는다(`src/i18n.test.ts`가 검사).
- 공개 저장소: 문서·커밋·테스트 데이터에 회사 이름·메일·내부 정보를 넣지 않는다.
- 커밋·푸시는 사용자가 요청할 때만 한다. 각 Task 끝은 "검증"까지이고 커밋 단계는 없다.
- 백엔드는 한 번에 한 폴더만 연다(`open_vault`는 지금 폴더를 먼저 닫는다). 뒤에서 여러 폴더를 동시에 열거나 감시하지 않는다.
- 닫기·순서 바꾸기에 확인 창을 띄우지 않는다. 막대에서 닫아도 폴더·노트·`.app`·최근 목록은 그대로다.
- 단추 글자는 폴더 이름의 첫 글자(문자 단위, 이모지 포함) 고정. 바꾸는 기능은 만들지 않는다.
- 막대 경로 비교는 대소문자 무시(`recent.rs`와 같음).
- 시작할 때 막대 폴더들의 존재를 확인하지 않는다. 누를 때 `folder_exists`로 확인한다.
- Ctrl+1~9: 막대 위에서부터 1~9번째 폴더. 잠깐 연 폴더는 번호 없음. 대화상자가 열려 있으면 동작하지 않는다(`noModal`).
- 수정이 끝나면 실행 중인 notevine.exe를 닫고 `npm run tauri build`, 설치 파일 경로를 보고한다.

## Review Focus

1. **같은 상대 경로의 노트가 두 폴더에 있을 때** — 스크롤·커서·탭·AI 제안이 다른 폴더 것으로 섞이지 않아야 한다. → Task 2 `vaultMemory` 테스트, Task 3 `store.rail.test.ts` "AI edits stay with their folder", Task 6 e2e.
2. **편집 중(자동 저장 전)에 폴더를 바꾸거나 Ctrl+N을 누름** — 내용이 저장된 뒤 바뀌어야 한다. → Task 3 "flushes before switching" 테스트, Task 6 e2e.
3. **확인은 통과했는데 `open_vault`가 실패**(권한, `.app` 생성 실패) — 보던 폴더로 되돌아가고, 되돌리기도 실패하면 시작 화면. 프런트 `vault`와 백엔드가 어긋난 채 남지 않는다. → Task 3 "reopens the previous folder when opening fails" 테스트.
4. **빠르게 두 번 누름(네트워크 폴더 확인 중)** — 마지막에 누른 폴더만 열린다. 앞의 확인 결과가 늦게 와도 무시. → Task 3 "latest switch wins" 테스트.
5. **잠깐 연 폴더가 막대 파일에 새어 들어감**(시작 시 자동 열기, 최근 목록 touch 경로) — 탐색기에서 연 막대 밖 폴더는 `vault-rail.json`에 절대 쓰이지 않고, 재시작 시 열리지 않는다. → Task 3 "temporary folder is not saved" 테스트, Task 6 `open-file.cjs` 확장.

---

## File Structure

| 파일 | 할 일 |
|---|---|
| `src-tauri/src/rail.rs` (새) | `RailStore`: `vault-rail.json` 읽기·쓰기, 추가·빼기·옮기기·active |
| `src-tauri/src/commands.rs` | `AppState.rail` 필드, `rail_*` 명령 5개 |
| `src-tauri/src/lib.rs` | `mod rail`, `RailStore::new(&config_dir)`, 명령 등록 |
| `src/api.ts` | `RailEntry`, `RailFile` 타입, `api.rail*` 바인딩 |
| `src/lib/rail.ts` (새) | 순수 규칙: `railLetter`, `nextAfterClose`, `samePath` |
| `src/lib/vaultMemory.ts` (새) | 폴더별 메모리 스냅숏 저장소 |
| `src/store.ts` | `rail`·`tempVault`·`switching`·`adding` 상태, `openVault` 성공 여부 반환, `switchVault`·`closeRailVault`·`pinTempVault`·`moveRail`·`setAdding`·`loadRail` |
| `src/aiStore.ts` | `snapshot()`/`restore()` (chat·edits·preview), 바꾸기 전 `stop()` |
| `src/components/Editor.tsx` | `viewMemory` 키를 `root + "\n" + path`로 |
| `src/components/StartScreen.tsx` | 막대 기준 자동 열기, `adding` 모드(취소 단추) |
| `src/components/VaultRail.tsx` (새) | 막대 UI, 말풍선, 오른쪽 클릭 메뉴 |
| `src/components/MainLayout.tsx` | 막대 배치, `VaultMenu` 항목 변경 |
| `src/App.tsx` | `adding`이면 StartScreen을 메인 위에 띄움 |
| `src/appCommands.ts` | `vault.switch` 동작 변경, `vault.close`, `vault.go1`~`vault.go9` |
| `src/App.css` | 막대 스타일(라이트·다크 토큰) |
| `src/i18n/en.json` | 새 문구 |
| `tests/e2e/vault-rail.cjs` (새), `tests/e2e/open-file.cjs` | e2e |
| `docs/요구사항정의서.md`, `docs/화면설계서.md`, `docs/사용자매뉴얼.md`, `tests/e2e/README.md` | 문서 |

---

### Task 1: 막대 목록 저장소 (Rust) + API 바인딩

**Files:**
- Create: `src-tauri/src/rail.rs`
- Modify: `src-tauri/src/commands.rs:19-32` (AppState), 명령 추가 / `src-tauri/src/lib.rs:120-126, 141-` / `src/api.ts:348-352` 근처

**Interfaces:**
- Produces (Rust):
  - `#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)] pub struct RailEntry { pub path: String, pub name: String }`
  - `#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)] pub struct RailFile { pub entries: Vec<RailEntry>, pub active: Option<String> }`
  - `impl RailStore { pub fn new(config_dir: &Path) -> Self; pub fn load(&self) -> Option<RailFile>; pub fn add(&self, path: &str, name: &str) -> AppResult<RailFile>; pub fn remove(&self, path: &str) -> AppResult<RailFile>; pub fn move_by(&self, path: &str, delta: i32) -> AppResult<RailFile>; pub fn set_active(&self, path: &str) -> AppResult<()> }`
  - 명령: `rail_list() -> Option<RailFile>`, `rail_add(path, name) -> RailFile`, `rail_remove(path) -> RailFile`, `rail_move(path, delta: i32) -> RailFile`, `rail_set_active(path)`
- Produces (TS, `src/api.ts`): `export interface RailEntry { path: string; name: string }`, `export interface RailFile { entries: RailEntry[]; active: string | null }`, `api.railList(): Promise<RailFile | null>`, `api.railAdd(path, name): Promise<RailFile>`, `api.railRemove(path): Promise<RailFile>`, `api.railMove(path, delta): Promise<RailFile>`, `api.railSetActive(path): Promise<void>`

규칙: 파일 `vault-rail.json`. 파일이 없거나 읽을 수 없으면 `load()`는 `None`(= 처음). `add`는 이미 있으면(대소문자 무시) 그대로 두고, 없으면 맨 뒤에 붙인다. `add`·`remove`·`move_by`는 파일이 없으면 빈 목록에서 시작해 저장한다(빈 목록도 파일로 남김 → 이후 `load()`는 `Some(빈 목록)`). `remove`로 active인 항목을 빼면 `active = None`. `move_by`는 범위 밖이면 끝에 고정. `set_active`는 목록에 없는 경로면 무시. 저장 방식은 `recent.rs`의 `save` 그대로.

- [ ] **Step 1: `rail.rs`에 실패하는 테스트 작성**

```rust
#[test] fn load_is_none_until_saved_then_empty_list_stays() {
    let d = tempfile::tempdir().unwrap(); let s = RailStore::new(d.path());
    assert_eq!(s.load(), None);
    s.add("C:\\a", "a").unwrap(); s.remove("c:\\A").unwrap();
    assert_eq!(s.load(), Some(RailFile::default()));
}
#[test] fn add_appends_once_ignoring_case() {
    // add a, b, then "c:\\A" → names ["a","b"]
}
#[test] fn move_by_clamps_and_keeps_others() {
    // a,b,c: move_by("C:\\c", -1) → a,c,b ; move_by("C:\\a", -5) → a,c,b ; move_by("C:\\a", 9) → c,b,a
}
#[test] fn removing_the_active_clears_it_and_set_active_ignores_unknown() {
    // add a,b; set_active("c:\\b") → active Some("C:\\b"); set_active("C:\\z") → unchanged; remove b → active None
}
```

- [ ] **Step 2: 실패 확인** — Run: `cd src-tauri; cargo test rail::` / Expected: 컴파일 실패(`RailStore` 없음)
- [ ] **Step 3: `rail.rs` 구현, `lib.rs`에 `mod rail;`**
- [ ] **Step 4: 통과 확인** — Run: `cargo test rail::` / Expected: 4 passed
- [ ] **Step 5: 명령·등록·TS 바인딩** — `AppState`에 `pub rail: crate::rail::RailStore` 추가, `lib.rs`에서 `rail: RailStore::new(&config_dir)`, `generate_handler!`에 5개 명령. `src/api.ts`에 타입과 `invoke("rail_list")` 등(인자 이름 `path`, `name`, `delta`).
- [ ] **Step 6: 검증** — Run: `cd src-tauri; cargo test` 와 `npm run typecheck` / Expected: 모두 통과

---

### Task 2: 순수 규칙과 폴더별 메모리

**Files:**
- Create: `src/lib/rail.ts`, `src/lib/rail.test.ts`, `src/lib/vaultMemory.ts`, `src/lib/vaultMemory.test.ts`
- Modify: `src/components/Editor.tsx:50, 356, 424`

**Interfaces:**
- Produces (`src/lib/rail.ts`):
  - `samePath(a: string, b: string): boolean` — 대소문자 무시, `/`와 `\` 같게 봄
  - `railLetter(name: string): string` — 앞뒤 공백 뺀 첫 글자(`Array.from`의 첫 원소; 이모지 하나가 한 글자). 빈 이름이면 `"?"`. 라틴 문자는 대문자.
  - `nextAfterClose(paths: string[], closing: string): string[]` — 닫은 뒤 시도할 순서: 바로 아래 → 그 아래들 → 바로 위 → 그 위들. 닫는 경로는 빠짐.
- Produces (`src/lib/vaultMemory.ts`):
  - `export interface VaultSnapshot { tabs: Tab[]; openPath: string | null; closedTabs: ClosedTab[]; splitPath: string | null; expanded: string[]; tableView: string | null; pdfView: { path: string; page: number; seq: number } | null; canvasView: string | null; ai: unknown }`
  - `keepSnapshot(root: string, s: VaultSnapshot): void`, `takeSnapshot(root: string): VaultSnapshot | undefined`(꺼내면서 지움), `dropSnapshot(root: string): void`, `clearSnapshots(): void`(테스트용) — 키는 `samePath` 기준(소문자·구분자 정규화)
  - `export const viewKey = (root: string, path: string) => root.toLowerCase() + "\n" + path`

- [ ] **Step 1: 실패하는 테스트**

```ts
// rail.test.ts
expect(railLetter("회사 노트")).toBe("회");
expect(railLetter("  notes")).toBe("N");
expect(railLetter("📘 공부")).toBe("📘");
expect(railLetter("")).toBe("?");
expect(nextAfterClose(["a", "b", "c", "d"], "b")).toEqual(["c", "d", "a"]);
expect(nextAfterClose(["a", "b", "c"], "c")).toEqual(["b", "a"]);
expect(nextAfterClose(["a"], "a")).toEqual([]);
expect(samePath("C:\\Notes\\A", "c:/notes/a")).toBe(true);
// vaultMemory.test.ts
keepSnapshot("C:\\A", snap); expect(takeSnapshot("c:/a")).toEqual(snap); expect(takeSnapshot("C:\\A")).toBeUndefined();
expect(viewKey("C:\\A", "x.md")).not.toBe(viewKey("C:\\B", "x.md"));
```

- [ ] **Step 2: 실패 확인** — Run: `npx vitest run src/lib/rail.test.ts src/lib/vaultMemory.test.ts` / Expected: FAIL (모듈 없음)
- [ ] **Step 3: 구현**
- [ ] **Step 4: `Editor.tsx`의 `viewMemory.get/set`을 `viewKey(useApp.getState().vault?.root ?? "", path)`로** — 메모리 맵 자체는 그대로 두고(폴더별 키라서 비울 필요 없음) 키만 바꾼다.
- [ ] **Step 5: 검증** — Run: `npx vitest run` 와 `npm run typecheck` / Expected: 모두 통과

---

### Task 3: 스토어 — 폴더 바꾸기·닫기·잠깐 연 폴더

**Files:**
- Modify: `src/store.ts` (AppStore 인터페이스 113-291, `openVault` 464-511, `openFileFromOs` 513-532, `closeVault` 534-540), `src/aiStore.ts`
- Test: `src/store.rail.test.ts` (새, `store.tabs.test.ts`처럼 `api`를 `vi.spyOn`으로 흉내)

**Interfaces:**
- Consumes: Task 1 `api.rail*`, `RailEntry`, `RailFile`; Task 2 `samePath`, `nextAfterClose`, `keepSnapshot`/`takeSnapshot`/`dropSnapshot`, `VaultSnapshot`
- Produces (AppStore에 추가):
  - `rail: RailEntry[]` — 막대 목록(저장된 것)
  - `tempVault: string | null` — 잠깐 연 폴더의 root
  - `switching: string | null` — 확인·여는 중인 대상 경로
  - `adding: boolean` — ＋/"노트 폴더 더 열기…"로 StartScreen을 띄운 상태
  - `loadRail(): Promise<RailFile | null>` — `api.railList()` 결과로 `rail` 채우고 그대로 반환
  - `openVault(path: string, opts?: { temporary?: boolean }): Promise<boolean>` — **반환형 변경**(성공 true). 성공 후 `temporary`가 아니면 `api.railAdd(info.root, info.name)` → `rail` 갱신, `api.railSetActive(info.root)`, `tempVault = null`. `temporary`면 `tempVault = info.root`, 막대 파일에 쓰지 않음. 같은 경로가 이미 `rail`에 있으면 temporary 요청이어도 보통 폴더로 연다.
  - `switchVault(path: string, opts?: { temporary?: boolean }): Promise<boolean>`
  - `closeRailVault(path?: string): Promise<void>` — 기본은 지금 폴더
  - `pinTempVault(): Promise<void>`
  - `moveRail(path: string, delta: -1 | 1): Promise<void>`
  - `setAdding(on: boolean): void`
- Produces (`aiStore.ts`): `snapshot(): unknown` (`{ chat, edits, preview }`), `restore(s: unknown | undefined): void` (없으면 `chat: [], edits: null, preview: null`)

**`switchVault` 순서** (spec 4.1, 4.6):
1. 대상이 지금 폴더면 `true` 반환. `const mine = ++switchSeq; set({ switching: path })`.
2. `await api.folderExists(path)`; `mine !== switchSeq`면 `false`(더 나중 요청이 이김). 없으면 `switching: null`, 오류 알림 `tx("노트 폴더를 찾을 수 없습니다: {0}", path)`, `false`.
3. `await get().flushEditor()`; 지금 폴더가 있으면 `keepSnapshot(cur.root, {...store 필드, expanded: [...expanded], ai: useAi.getState().snapshot()})`, `useAi.getState().stop()`. 지금 폴더가 잠깐 연 폴더면 스냅숏을 남기지 않는다(`dropSnapshot`).
4. `ok = await get().openVault(path, opts)`. `openVault`는 성공 직후, workspace 복원 **대신** `takeSnapshot(info.root)`가 있으면 그걸로 `tabs/openPath/closedTabs/splitPath/expanded/views`를 되살리고(`applyTabs`로, `api.setWorkspace` 저장도 그대로) `useAi.getState().restore(snap.ai)`; 없으면 지금처럼 workspace 복원 + `restore(undefined)`.
5. 실패하면(`ok === false`) 이전 root로 `openVault(prev, { temporary: prevWasTemp })` 재시도. 그것도 실패하면 `set({ vault: null, ... })`로 시작 화면. `switching: null`.
- 여는 동작은 `switchSeq`와 별개로 promise 체인(`let chain = Promise.resolve()`)에 줄 세워 겹쳐 실행되지 않게 한다. 체인 차례가 왔을 때 `mine !== switchSeq`면 건너뛴다.

**`closeRailVault(path)`** (spec 4.3, 4.7): 잠깐 연 폴더면 `tempVault = null`, `dropSnapshot`, 대상 = 막대 active(`loadRail().active`) → 막대 첫 항목 → 없으면 `closeVault()`. 보통 폴더면 `api.railRemove(path)` → `rail` 갱신, `dropSnapshot(path)`; 지금 폴더가 아니면 끝. 지금 폴더면 `nextAfterClose(railBefore, path)` 차례로 `switchVault` 시도, 다 실패하거나 없으면 `closeVault()`.

**`openFileFromOs`** (spec 4.7): 지금 폴더면 그대로. 아니면 `const inRail = rail.some(e => samePath(e.path, found.root))`; 물어보는 규칙은 그대로이고, 기존 `closeVault()+openVault()` 대신 `await get().switchVault(found.root, { temporary: !inRail })`.

**다른 곳:** 기존 `closeVault()`는 그대로(시작 화면으로) 두되, 다른 폴더로 갈 때는 `switchVault`를 쓴다. `tempVault`인 동안 다른 막대 폴더로 바꾸면 `tempVault = null`이 된다(4번에서 `openVault`가 보통 폴더로 열며 설정).

- [ ] **Step 1: `store.rail.test.ts`에 실패하는 테스트 작성** — `api.openVault`, `getConfig`, `deviceTrust`, `listTree`, `listNotes`, `getWorkspace`, `setWorkspace`, `folderExists`, `rail*`, `closeVault`를 흉내 낸다. `listen`은 `@tauri-apps/api/event`를 `vi.mock`.

```ts
it("adds an opened folder to the rail and sets it active", ...)
  // openVault("D:/a") → railAdd("D:/a","a"), railSetActive("D:/a"), state.rail has a
it("brings back tabs and AI chat when switching back", ...)
  // open a, openNote x.md, useAi chat=[m]; switchVault b; expect tabs []; switchVault a → tabs [x.md], openPath x.md, chat [m]
it("AI edits stay with their folder", ...)
  // a has edits proposal; switch to b → useAi.edits null
it("flushes before switching", ...)
  // flushEditor spy called before api.openVault("D:/b")
it("stays when the folder is missing", ...)
  // folderExists false → api.openVault not called, vault still a, error toast
it("reopens the previous folder when opening fails", ...)
  // api.openVault rejects for b → called again with a; vault.root a
it("goes to the start screen when reopening also fails", ...)
  // both reject → vault null
it("latest switch wins", ...)
  // folderExists for b resolves late; switchVault(b) then switchVault(c) → only c opened
it("closing the current folder goes to the one below, then above, then the start screen", ...)
  // rail a,b,c on b: close → c; close c → a (b gone); close a → vault null
it("temporary folder is not saved", ...)
  // openFileFromOs for a root outside rail → railAdd not called, tempVault set; switchVault(a) → tempVault null
it("pinning the temporary folder adds it to the rail", ...)
```

- [ ] **Step 2: 실패 확인** — Run: `npx vitest run src/store.rail.test.ts` / Expected: FAIL (`switchVault` 없음 등)
- [ ] **Step 3: `aiStore.ts`에 `snapshot`/`restore`**
- [ ] **Step 4: `store.ts` 구현** (위 순서대로). `openVault` 반환형 변경에 맞춰 호출부(`StartScreen.tsx`, 테스트, e2e의 `window.__notevine.getState().openVault`) 확인 — 기존 호출은 반환값을 안 쓰므로 그대로 동작한다.
- [ ] **Step 5: 통과 확인** — Run: `npx vitest run` / Expected: 기존 테스트 포함 모두 통과
- [ ] **Step 6: 검증** — Run: `npm run typecheck` / Expected: 오류 없음

---

### Task 4: 시작 화면 — 막대 기준 자동 열기, 폴더 더 열기 모드

**Files:**
- Modify: `src/components/StartScreen.tsx:41-62`, `src/App.tsx:60-66`
- Test: `src/components/StartScreen.test.tsx` (기존 파일에 추가)

**Interfaces:**
- Consumes: Task 3 `loadRail`, `adding`, `setAdding`, `switchVault`, `openVault`

동작 (spec 4.2, 4.5):
- 앱 시작 자동 열기(`autoOpenTried`가 처음이고 `startedWithFile`이 아닐 때): `loadRail()`이 `null`이면 지금처럼 `recent[0]`; 목록이 있으면 `active`(목록에 있을 때) 아니면 첫 항목; 빈 목록이면 자동으로 열지 않는다.
- `adding` 모드: App은 `vault && adding`이면 `<MainLayout />` 위에 `<div className="start-overlay"><StartScreen adding /></div>`를 띄운다. `adding`이면 자동 열기를 하지 않고, 카드 위쪽에 `tx("취소")` 단추(누르거나 Esc → `setAdding(false)`). 폴더를 고르면(최근 목록·폴더 선택·드라이브 버튼) `setAdding(false)` 후 `switchVault(path)`; 폴더 선택 대화상자를 취소하면 그대로 남는다.
- 일반 시작 화면(폴더 없음)에서 고르면 지금처럼 `openVault(path)`(막대에 추가됨).

- [ ] **Step 1: 실패하는 테스트** — `it("opens the rail's active folder at start, not recent[0]")`, `it("does not open anything when the rail was emptied")`(`railList` → `{entries: [], active: null}`), `it("falls back to recent[0] when there is no rail file yet")`, `it("adding mode switches instead of opening and can be cancelled")`
- [ ] **Step 2: 실패 확인** — Run: `npx vitest run src/components/StartScreen.test.tsx` / Expected: FAIL
- [ ] **Step 3: 구현**
- [ ] **Step 4: 통과 확인** — Run: `npx vitest run` / Expected: PASS

---

### Task 5: 막대 화면, 메뉴, 단축키

**Files:**
- Create: `src/components/VaultRail.tsx`
- Modify: `src/components/MainLayout.tsx:69-104 (VaultMenu), 183-`, `src/appCommands.ts:261`, `src/App.css`, `src/i18n/en.json`
- Test: `src/appCommands.test.ts` (기존에 추가)

**Interfaces:**
- Consumes: Task 2 `railLetter`; Task 3 `rail`, `tempVault`, `switching`, `vault`, `switchVault`, `closeRailVault`, `pinTempVault`, `moveRail`, `setAdding`
- Produces: 명령 id `vault.switch`(제목 `tx("노트 폴더 더 열기")`, 실행 `setAdding(true)`), `vault.close`(`tx("노트 폴더 닫기")`), `vault.go1`~`vault.go9`(`tx("노트 폴더 {0}로 가기", n)`, keys `"Ctrl+1"`~`"Ctrl+9"`, when: `hasVault() && noModal() && rail.length >= n`)

화면 (spec 3장, 시안 `folder-rail-final.html`):
- `MainLayout` 최상위를 `<div className="shell"><VaultRail /><div className="main">…기존…</div></div>`로 감싼다. 막대 폭 52px, 세로 꽉 참, 배경은 `--bg-sidebar`보다 한 단계 진한 새 토큰 `--bg-rail`(라이트 `#efedf5`, 다크 `#141416`), 두 다크 블록(@media와 `[data-theme=dark]`) 모두에 정의.
- 단추(`button.rail-btn`, 34×34, radius 9px): 글자 `railLetter(name)`. 지금 폴더 `.on`(`--accent` 채움 + 왼쪽 4px 표시). `switching === path`면 `.pending`(투명도 0.5, `aria-busy`). 잠깐 연 폴더는 목록 아래 `.temp`(점선 테두리) 하나. 맨 아래 `＋`(`aria-label={tx("노트 폴더 더 열기")}`). 넘치면 목록 부분만 `overflow-y: auto`.
- 말풍선: `title` 속성으로 충분 — `name\npath` + 앞 9개는 `\nCtrl+N`, 잠깐 연 폴더는 `\n` + `tx("잠깐 연 폴더")`.
- 클릭: `switchVault(path)`. 오른쪽 클릭 메뉴(기존 `.menu` 스타일과 `src/lib/menuPos.ts` 사용): 보통 폴더 — `tx("위로 옮기기")`(맨 위면 disabled), `tx("아래로 옮기기")`(맨 아래면 disabled), `tx("탐색기에서 노트 폴더 열기")`(`revealItemInDir`), 구분선, `tx("막대에서 닫기")`. 잠깐 연 폴더 — `tx("막대에 추가")`, `tx("탐색기에서 노트 폴더 열기")`, 구분선, `tx("닫기")`.
- `VaultMenu`: `tx("노트 폴더 바꾸기…")` → `tx("노트 폴더 더 열기…")`(`setAdding(true)`), 새 항목 `tx("이 노트 폴더 닫기")`(`closeRailVault()`), 탐색기 항목은 그대로. 버튼 title `tx("{0}\n눌러서 노트 폴더 바꾸기", root)` → `tx("{0}\n노트 폴더 메뉴", root)`.
- 쓰지 않게 된 en.json 키(`"노트 폴더 바꾸기"`, `"노트 폴더 바꾸기…"`, `"{0}\n눌러서 노트 폴더 바꾸기"`)는 다른 곳에서 안 쓰면 지운다.

- [ ] **Step 1: 실패하는 테스트** (`appCommands.test.ts`) — `it("Ctrl+2 switches to the second rail folder")`: `rail` 두 개, `dispatchKey(Ctrl+2)` → `switchVault` spy가 두 번째 path로 호출. `it("Ctrl+3 does nothing with two rail folders")`. `it("vault.switch opens adding mode")`.
- [ ] **Step 2: 실패 확인** — Run: `npx vitest run src/appCommands.test.ts` / Expected: FAIL
- [ ] **Step 3: 명령, `VaultRail.tsx`, `MainLayout`, CSS, en.json 구현**
- [ ] **Step 4: 통과 확인** — Run: `npx vitest run` 와 `npm run typecheck` / Expected: 모두 통과 (`i18n.test.ts` 포함)
- [ ] **Step 5: 눈으로 확인** — `npm run tauri dev`로 띄워 라이트·다크 테마에서 막대·말풍선·메뉴가 시안과 같은지, 사이드바를 닫아도(Ctrl+\) 막대가 남는지 본다.

---

### Task 6: E2E, 문서, 빌드

**Files:**
- Create: `tests/e2e/vault-rail.cjs`
- Modify: `tests/e2e/open-file.cjs`, `tests/e2e/README.md`, `docs/요구사항정의서.md:87`, `docs/화면설계서.md`, `docs/사용자매뉴얼.md`

**Interfaces:**
- Consumes: 모든 앞 Task. e2e는 `window.__notevine.getState()`(기존 노출)과 `.rail-btn` 선택자를 쓴다.

- [ ] **Step 1: `vault-rail.cjs`** (개발 모드, 포트 9222, `tabs.cjs`와 같은 접속 방식). 임시 폴더 A, B를 만들고 둘 다 `같은 이름.md`(80줄 이상)를 넣는다. 확인 항목:
  1. A, B를 열면 막대 단추 2개, B가 `.on`.
  2. A로 가서 `같은 이름` 열고 스크롤 아래로 → B에서 `같은 이름` 열고 맨 위 → A로 돌아오면 스크롤이 아래 그대로, B로 가면 맨 위 그대로.
  3. A에서 타이핑 직후 바로 Ctrl+2 → A 파일에 타이핑한 글이 저장돼 있음(디스크 확인).
  4. A에 탭 2개 → B → A: 탭 2개와 지금 탭 그대로.
  5. 막대 순서 "아래로 옮기기" 후 Ctrl+1이 B로 감.
  6. 없는 폴더 C를 `rail_add`로 넣고 누름 → 오류 알림, 보던 폴더 그대로.
  7. 지금 폴더 닫기 → 다음 폴더, 마지막 닫기 → 시작 화면(`.start-card`).
  8. 끝나면 `rail_remove`·`forget_vault`로 테스트 폴더를 막대와 최근 목록에서 지운다(`finally`).
- [ ] **Step 2: `open-file.cjs` 확장** — 막대 밖 노트 폴더의 파일을 넘기면 `.rail-btn.temp`가 보이고 `rail_list()`에 그 폴더가 없음; 막대의 다른 폴더를 누르면 `.temp`가 사라짐; "노트 폴더로 열까요?"에서 열기를 고른 경우도 같은지. 정리 단계에 `rail_remove` 추가.
- [ ] **Step 3: 실행** — `npm run tauri dev`(디버깅 포트 9222) 띄우고 `node tests/e2e/vault-rail.cjs` / Expected: 모든 `ok -` 줄, 종료 코드 0. `npm run tauri build` 후 `node tests/e2e/open-file.cjs` / Expected: 모든 `ok -` 줄.
- [ ] **Step 4: 문서**
  - `요구사항정의서.md` FR-VLT-07 수용 기준을 "구현(2026-11-09): 왼쪽 끝 노트 폴더 막대(폴더별 첫 글자 단추, Ctrl+1~9), 바꿔도 탭·마지막 노트·스크롤 유지, 막대에서 닫아도 폴더는 그대로, 탐색기에서 연 막대 밖 폴더는 잠깐 연 폴더로 표시(저장 안 함). 목록은 PC별 `vault-rail.json`"으로 바꾼다. FR-VLT-10 끝에 "막대에 없는 폴더면 잠깐 연 폴더로 연다" 추가.
  - `화면설계서.md` 메인 화면 구성에 막대 추가(Mermaid 있으면 갱신).
  - `사용자매뉴얼.md` 노트 폴더 장에 "여러 노트 폴더 열어 두기" 절(추가·바꾸기·닫기·순서·잠깐 연 폴더), 단축키 표에 Ctrl+1~9, "노트 폴더 바꾸기" 언급을 "노트 폴더 더 열기"로 바꾼다. 앱 안 매뉴얼은 이 파일을 묶으므로 `src/lib/manual.test.ts`가 통과하는지 확인.
  - `tests/e2e/README.md`에 `vault-rail.cjs` 한 줄.
- [ ] **Step 5: 최종 검증** — Run: `npx vitest run`, `npm run typecheck`, `cd src-tauri; cargo test` / Expected: 모두 통과
- [ ] **Step 6: 빌드** — 실행 중인 notevine.exe 종료 후 `npm run tauri build` / Expected: `src-tauri/target/release/bundle/nsis/Notevine_0.1.6_x64-setup.exe`, `.../msi/Notevine_0.1.6_x64_ko-KR.msi` 생성
