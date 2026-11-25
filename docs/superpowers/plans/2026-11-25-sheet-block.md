# 시트 블록 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 노트 안의 ` ```sheet ` 블록을 엑셀처럼 입력하는 그리드로 보여 주고, 숫자 열 합계와 사칙연산 수식(`=B2*C2`)을 자동으로 계산한다.

**Architecture:** 계산(수식·합계)은 순수 함수 두 파일(`sheetFormula.ts`, `sheet.ts`)에 두고 에디터 위젯과 읽기 모드가 같이 쓴다. 에디터는 `frontmatterFold.ts`와 같은 블록 위젯(`StateField` + `Decoration.replace({block:true})`)이고, 읽기 모드는 `renderNote.ts`의 `code` 렌더러에 `sheet`를 더한다.

**Tech Stack:** TypeScript, CodeMirror 6, marked, vitest (새 라이브러리 없음)

**Spec:** `docs/superpowers/specs/2026-11-25-sheet-block-design.md`

## Global Constraints

- 노트를 잃으면 안 된다. 사용자가 고치지 않은 블록의 글자는 바뀌지 않는다. 문서에 쓰는 코드에는 테스트를 같이 둔다.
- 한글 IME 조합 중(`compositionstart`~`compositionend`)에는 문서에 쓰지 않는다.
- 화면 글은 `tx("…")`로 감싸고 `src/i18n/en.json`에 같은 키로 영어를 넣는다.
- `eval`·`Function`·새 npm 라이브러리·네트워크 접속 금지.
- 칸 글자는 읽기 모드 HTML에서 모두 `esc`를 거친다(기존 DOMPurify 정화도 그대로 거친다).
- 커밋·푸시는 사용자가 요청할 때만 한다. 이 계획에는 커밋 단계를 두지 않는다. 작업 트리에 이미 있는 다른 변경(`src/editor/livePreview.ts`, `docs/작업기록.md`, `.agents/`, `skills-lock.json`, `docs/superpowers/plans/2026-11-11-git-encryption.md`)은 건드리지 않는다.
- 버전 번호는 올리지 않는다(요청받았을 때만).
- 수정이 끝나면 `npm run tauri build`까지 하고, 빌드가 덮어쓰는 `src-tauri\target\release\notevine.exe`로 띄운 앱만 닫는다. 설치본(`%LOCALAPPDATA%\Notevine\notevine.exe`)과 MCP 서버 프로세스는 닫지 않는다.
- 수식 규칙(스펙 5.2-1): `=`로 시작, `+ - * /`·`×÷`·괄호·앞의 `-`, 칸 참조 `B2`(제목 행이 1행), 빈 칸은 0, 오류 문자열은 `#오류` `#나누기0` `#참조` `#순환` `#글자`.
- 합계 규칙(스펙 5.2): 첫 열은 이름 열(합치지 않고 "합계" 표시), 둘째 열부터 데이터 칸이 하나 이상이고 모두 숫자인 열만 합계, 오류 칸이 있는 열은 합계 칸에 `#오류`, 숫자 열이 없으면 합계 줄 없음.

## Review Focus

1. 칸에 `|`나 `\`를 입력한다 → `\|`·`\\`로 저장되고 다시 읽으면 같은 칸이 된다 (Task 2 테스트).
2. 아주 긴 식·깊게 겹친 괄호·`=alert(1)` 같은 글자 → 멈추거나 실행되지 않고 `#오류`가 된다 (Task 1 테스트).
3. 칸에 `<img src=x onerror=…>`를 넣는다 → 읽기 모드 HTML에서 글자로만 나온다 (Task 3 테스트).
4. 칸에 들어갔다 아무것도 안 바꾸고 나온다 → 문서가 바뀌지 않는다 (Task 4 테스트).
5. 500행짜리 시트와 서로 이어진 수식 사슬 → 합계 계산이 눈에 띄게 느려지지 않는다 (Task 1 테스트: 칸 값을 한 번씩만 계산).

---

### Task 1: 수식 계산기 `sheetFormula.ts`

**Files:**
- Create: `src/lib/sheetFormula.ts`
- Test: `src/lib/sheetFormula.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type SheetError = "#오류" | "#나누기0" | "#참조" | "#순환" | "#글자";
  export type Evaluated =
    | { kind: "empty" }
    | { kind: "text"; text: string }
    | { kind: "number"; value: number }
    | { kind: "error"; error: SheetError };
  /** "1,200" · "1200원" · "-5" · "3.5" → number. Anything else (including blank) → null. */
  export function parseNumber(text: string): number | null;
  /** Evaluates every cell of rows[r][c] (row 0 = header). Same shape as the input, ragged rows padded to the widest row. Each cell is computed once. */
  export function evaluateSheet(rows: string[][]): Evaluated[][];
  /** "B2" → { row: 1, col: 1 } (0-based, header row = 0); null if not a reference. */
  export function parseRef(ref: string): { row: number; col: number } | null;
  ```

- [ ] **Step 1: Write the failing tests** in `sheetFormula.test.ts` (vitest). Cases and expected values:
  - `parseNumber`: `"1,200"`→1200, `"1200원"`→1200, `"-5"`→-5, `"3.5"`→3.5, `""`→null, `"abc"`→null, `"1,2,3x"`→null.
  - `parseRef("B2")`→`{row:1,col:1}`, `parseRef("A1")`→`{row:0,col:0}`, `parseRef("AA10")`→`{row:9,col:26}`, `parseRef("2B")`→null.
  - Plain cells: `["항목","금액"],["a","1,200"],["b",""]` → header cells `text`, `1,200` → number 1200, blank → `empty`.
  - Arithmetic: `=1+2*3`→7, `=(1+2)*3`→9, `=-2*3`→-6, `=8/4/2`→1, `=2×3÷6`→1, `=1.5+1`→2.5.
  - 참조: rows `[["이름","수량","단가","금액"],["x","3","1,200","=B2*C2"]]` → 금액 칸 3600. 빈 칸 참조는 0(`=B3+1`이 빈 칸이면 1). 글자 칸 참조(`=A2+1`)→`#글자`. 없는 칸(`=Z99`)→`#참조`.
  - 오류: `=1/0`→`#나누기0`, `=1+`→`#오류`, `=alert(1)`→`#오류`, `=A2` 자기 자신→`#순환`, A→B→A→`#순환`, 괄호 10,000개 중첩과 길이 10,000자 식→`#오류`(예외를 던지지 않음).
  - 부동소수: `=0.1+0.2`→0.3 (소수 10자리 반올림 후 `Number`).
  - 성능: 500행 × 사슬(`=B{n-1}+1`) 시트가 100ms 안에 계산되고, 각 칸의 평가 함수는 한 번만 불린다(메모이제이션 확인은 결과 일치와 시간으로 한다).

- [ ] **Step 2: Run to verify fail** — `npx vitest run src/lib/sheetFormula.test.ts` → FAIL (모듈 없음).

- [ ] **Step 3: Implement `sheetFormula.ts`.** 토크나이저 + 재귀 하강 파서(식 → 항 → 인자, `eval` 없음). 칸은 `Evaluated | "visiting"`을 담는 메모 표로 한 번씩만 계산하고, 방문 중인 칸을 다시 만나면 `#순환`. 식 길이 상한 1,000자·괄호 깊이 상한 50을 넘으면 `#오류`. 칸 값이 오류이면 그 식도 같은 오류(연쇄)로 한다. 숫자 결과는 소수 10자리에서 반올림하고 `NaN`·`Infinity`는 `#오류`.

- [ ] **Step 4: Run to verify pass** — 같은 명령 → PASS.

### Task 2: 파싱·저장·합계 `sheet.ts`

**Files:**
- Create: `src/lib/sheet.ts`
- Test: `src/lib/sheet.test.ts`

**Interfaces:**
- Consumes: `evaluateSheet`, `Evaluated` from Task 1.
- Produces:
  ```ts
  export function parseSheet(body: string): string[][];            // 줄 = 행, ` | `로 칸 구분, 양 끝 `|` 허용, `\|`·`\\` 해석, 칸 앞뒤 공백 제거
  export function serializeSheet(rows: string[][]): string;        // 줄마다 `a | b | c`, `|`→`\|`, `\`→`\\`, 마지막 줄 뒤 개행 없음
  export type Total = { kind: "none" } | { kind: "sum"; value: number } | { kind: "error" };
  export function computeTotals(rows: string[][]): Total[] | null; // 열마다 하나, 숫자 열이 하나도 없으면 null, 첫 열은 항상 none
  export function formatNumber(n: number): string;                 // 천 단위 쉼표, 소수는 있는 만큼(최대 10자리)
  export function displayCell(e: Evaluated): string;               // number→formatNumber, error→error 문자열, text→text, empty→""
  ```

- [ ] **Step 1: Write the failing tests** in `sheet.test.ts`:
  - 왕복: `serializeSheet(parseSheet(x)) === x` — x는 `"항목 | 수량 | 단가\n인건비 | 3 | 1200000\n장비 | 2 | 500000"`, 양 끝 `|`가 있는 입력은 정규화된 글자로 나오고 두 번째 왕복부터 같다.
  - 이스케이프: 칸 `a|b`·`c\d`가 `a\|b`·`c\\d`로 저장되고 다시 읽으면 원래 칸. 한글·빈 칸·칸 수가 다른 행은 `parseSheet`가 모자란 칸을 만들지 않고 그대로 두며(`["a"]` 행은 길이 1) `serializeSheet`는 줄을 그대로 낸다.
  - 빈 문자열: `parseSheet("")`→`[]`.
  - 합계: 위 견적표(`=B2*C2` 열 추가) → 둘째 열 `sum 5`, 단가 열 `sum 1,700,000`, 금액 열 `sum 4,600,000`; 첫 열 `none`.
  - 첫 열이 숫자(번호 열)여도 합치지 않음. 숫자와 글자가 섞인 열은 `none`. 데이터 칸이 모두 빈 열은 `none`. 오류 칸이 있는 열은 `error`. 숫자 열이 없으면 `null`.
  - 부동소수: 열 `0.1`, `0.2` → `formatNumber`가 `0.3`.
  - `formatNumber(1234567.5)`→`"1,234,567.5"`, `formatNumber(-1200)`→`"-1,200"`.

- [ ] **Step 2: Run to verify fail** — `npx vitest run src/lib/sheet.test.ts` → FAIL.

- [ ] **Step 3: Implement `sheet.ts`.** 칸 구분은 이스케이프되지 않은 `|`. 합계는 `evaluateSheet` 결과를 한 번만 만들어 열별로 훑는다.

- [ ] **Step 4: Run to verify pass** — 같은 명령 → PASS.

### Task 3: 읽기 모드 렌더

**Files:**
- Modify: `src/lib/renderNote.ts` (`code` 렌더러, 약 `:222`)
- Modify: `src/App.css` (`.note-view .mermaid-block` 근처에 `.note-view .sheet-block` 스타일)
- Test: `src/lib/renderNote.test.ts`

**Interfaces:**
- Consumes: `parseSheet`, `computeTotals`, `displayCell`, `evaluateSheet` from Tasks 1–2.
- Produces: `renderNote.ts` 안의 `renderSheetHtml(body: string): string` (내보내지 않아도 됨). `lang`이 `sheet`이면 `<table class="sheet-block">` 반환. 숫자·계산 결과 칸은 `class="num"`(오른쪽 정렬), 오류 칸은 `class="err"`, 합계 줄은 `<tr class="sheet-total">` 첫 칸 "합계".

- [ ] **Step 1: Write the failing tests** in `renderNote.test.ts` (`noteToHtml`):
  - ` ```sheet\n항목 | 금액\n a | 1,200\n b | 800\n``` ` → HTML에 `class="sheet-block"`, `<th>항목</th>`, `sheet-total`, `2,000`.
  - `=B2*C2` 열 → 계산 결과(`3,600`)가 보이고 수식 글자는 `title` 없이 노출되지 않는다.
  - 칸에 `<img src=x onerror=alert(1)>` → HTML에 `<img`가 없고 `&lt;img`가 있다 (Review Focus 3).
  - ` ```js ` 블록과 ` ```mermaid ` 블록은 이전과 같은 출력.
  - 숫자 열이 없는 시트는 `sheet-total`이 없다.

- [ ] **Step 2: Run to verify fail** — `npx vitest run src/lib/renderNote.test.ts` → 새 테스트 FAIL.

- [ ] **Step 3: Implement** `code({ text, lang })`에서 `lang`이 `sheet`일 때 `renderSheetHtml(text)`를 반환(그 밖의 `lang`은 지금처럼 `mermaid` 판정 후 `false`). 모든 칸은 `esc`.

- [ ] **Step 4: Add CSS** `.note-view .sheet-block` — 표 선 1px `var(--border)`, 제목 행 `var(--bg-sidebar)`, `.num` 오른쪽 정렬, `.err` 빨강, `.sheet-total` 굵게. 기존 `.note-view table` 스타일을 확인해 따라간다.

- [ ] **Step 5: Run to verify pass** — 같은 명령 → PASS.

### Task 4: 에디터 그리드 위젯

**Files:**
- Create: `src/editor/sheetBlock.ts`
- Modify: `src/components/Editor.tsx` (`frontmatterFold,` 다음 줄에 `sheetBlock,` 추가, `:300`)
- Modify: `src/App.css` (`.cm-sheet*` 스타일)
- Test: `src/editor/sheetBlock.test.ts`

**Interfaces:**
- Consumes: `parseSheet`, `serializeSheet`, `computeTotals`, `evaluateSheet`, `displayCell` from Tasks 1–2.
- Produces:
  ```ts
  export type SheetBlockRange = { from: number; to: number; bodyFrom: number; bodyTo: number };
  /** 맨 바깥(목록·인용 안이 아닌) ```sheet 울타리 블록만. 빈 블록(글자 없음)은 제외. */
  export function findSheetBlocks(state: EditorState): SheetBlockRange[];
  /** rows를 body 자리에 쓰는 변경. serialize(rows)가 지금 본문과 같으면 null(문서를 바꾸지 않는다). */
  export function sheetEdit(state: EditorState, block: SheetBlockRange, rows: string[][]): TransactionSpec | null;
  export const sheetBlock: Extension;
  ```

- [ ] **Step 1: Write the failing tests** in `sheetBlock.test.ts` (`EditorState.create` + `markdown({ base: markdownLanguage })`, `ensureSyntaxTree`):
  - `findSheetBlocks`: 문서 `"앞\n\n```sheet\na | b\n1 | 2\n```\n\n뒤"` → 블록 1개, `bodyFrom`/`bodyTo`가 `a | b\n1 | 2`와 일치.
  - 목록 안 ` - ```sheet…``` `, `~~~sheet`, 네 개 백틱 울타리, ` ```js ` 블록은 찾지 않는다. 빈 ` ```sheet\n``` ` 은 찾지 않는다.
  - `sheetEdit`: 같은 rows → `null` (Review Focus 4). 한 칸이 바뀐 rows → 변경이 본문 범위(`bodyFrom~bodyTo`)만 바꾸고 울타리 줄·그 밖의 글자는 그대로. 적용한 문서의 `parseSheet`가 새 rows와 같다.
  - 정규화되지 않은 원문(`a|b\n1|2`)을 그대로 두고 rows가 같으면 `null`이다(글자만 달라도 "내용이 같으면" 쓰지 않는다 — `parseSheet(본문)`과 rows가 같은지로 판정).

- [ ] **Step 2: Run to verify fail** — `npx vitest run src/editor/sheetBlock.test.ts` → FAIL.

- [ ] **Step 3: Implement `findSheetBlocks` and `sheetEdit`** — `syntaxTree`를 돌며 부모가 `Document`인 `FencedCode`이고 `CodeInfo`가 `sheet`인 것을 찾는다(백틱 3개만: `CodeMark`가 ` ``` `).

- [ ] **Step 4: Implement the widget** (`class SheetWidget extends WidgetType`, `StateField<DecorationSet>` + `EditorView.decorations.from`, `frontmatterFold.ts` 패턴):
  - 커서·선택이 블록(`from..to`) 안이면 위젯 대신 `Decoration.line`으로 원문을 보여 준다(편집 모드).
  - 위젯 DOM: 가장자리에 열 글자 A,B,C…와 행 번호, 각 칸 `<input>`(수식 칸은 포커스 때 수식, 벗어나면 결과), 맨 아래 합계 줄(저장 안 함), 행 아래 `+`·행·열 `×` 단추, 위젯 위 "원문 편집" 단추(커서를 블록 첫 줄로 옮긴다). Tab은 다음 칸, 마지막 칸의 Enter/Tab은 새 행 추가, 방향키 위·아래는 칸 이동.
  - 입력 중에는 위젯 안의 합계·결과만 갱신(`input` 이벤트에서 `evaluateSheet` 재계산)하고, 문서에는 칸을 벗어날 때(blur·Enter·Tab)만 `sheetEdit`로 `view.dispatch`한다. `compositionstart`~`compositionend` 동안은 쓰지 않는다. `ignoreEvent()`는 위젯 안 이벤트를 에디터가 가로채지 않게 `true`를 돌려준다.
  - 위젯이 다시 만들어질 때(문서 변경) 포커스 중이던 칸과 커서 위치를 되돌린다. `eq()`는 rows와 선택 상태가 같으면 `true`.
  - 행·열 삭제 단추의 `title`: `tx("삭제하면 수식의 칸 참조가 어긋날 수 있습니다")`. 모든 화면 글은 `tx`.

- [ ] **Step 5: Register** `sheetBlock`을 `Editor.tsx`의 확장 목록에 추가. 위젯 CSS는 `frontmatterFold.ts`의 `baseTheme`가 아니라 `App.css`의 `.cm-sheet*`에 둔다(기존 `cm-fm-summary` 스타일 위치를 확인해 같은 쪽을 따른다). 라이트·다크 변수는 기존 변수(`--border`, `--bg-sidebar`, `--muted`)를 쓴다.

- [ ] **Step 6: Run to verify pass** — `npx vitest run src/editor/sheetBlock.test.ts` → PASS. `npm run typecheck` → 오류 0.

- [ ] **Step 7: 앱에서 확인** — `npm run tauri dev`로 띄워 노트에 ` ```sheet ` 블록을 쓰고 확인한다: 그리드 표시, 칸 입력 시 합계 실시간 갱신, 한글 입력(조합 중 Enter), `=B2*C2` 결과 표시, 칸 `|` 입력, 읽기 모드 표시, 블록을 눌러 원문 편집, Ctrl+Z 되돌리기. 확인 결과를 사용자에게 그대로 보고한다(못 해 본 항목은 못 했다고 쓴다).

### Task 5: 넣는 방법·도움말·문서·번역·최종 확인

**Files:**
- Modify: `src/components/FormatBar.tsx` (`:125` 표 단추 근처에 "시트(합계 표)" 단추 추가, `insertBlock(s, SHEET, …)`)
- Modify: `src/editor/format.ts` (`SHEET` 상수와 커서 위치)
- Modify: `src/components/MarkdownHelp.tsx` (`:60` 근처에 sheet 블록 예시)
- Modify: `src/i18n/en.json`
- Modify: `docs/사용자매뉴얼.md` (3장 서식 표·강조 상자 설명 근처에 절 추가), `docs/요구사항정의서.md`(새 FR 번호 부여), `docs/화면설계서.md`(시트 위젯 SCR 번호), 위젯 주석에 해당 번호를 적는다.
- Test: `src/editor/format.test.ts`

**Interfaces:**
- Consumes: `insertBlock` (`src/editor/format.ts:121`), `SheetBlockRange`는 쓰지 않는다.
- Produces: `export const SHEET: string` = ` ```sheet\n항목 | 수량 | 단가 | 금액\n |  |  | \n |  |  | \n``` ` (제목 행 + 빈 행 2개).

- [ ] **Step 1: Write the failing test** in `format.test.ts`: 빈 문서에서 `insertBlock(state, SHEET, offset)`을 적용하면 문서가 `SHEET + "\n"`이고 커서가 첫 데이터 행 첫 칸에 놓인다.
- [ ] **Step 2: Run to verify fail** — `npx vitest run src/editor/format.test.ts` → FAIL.
- [ ] **Step 3: Implement** `SHEET`와 FormatBar 단추(라벨 `tx("시트")`). 명령 팔레트(`appCommands.ts`)에 에디터 서식 명령이 이미 있는 경로가 있으면 같은 방식으로 "시트(합계 표) 넣기"를 등록하고, 없으면 FormatBar 단추만 둔다(이 경우 스펙 5.5의 팔레트 항목은 빌더 판단으로 생략하고 보고에 쓴다).
- [ ] **Step 4: 문서·번역** — `en.json`에 새 `tx` 키 전부 영어 추가(`npm test`의 `i18n.test.ts`가 누락을 잡는다). 매뉴얼에 문법, 합계 규칙, 수식 규칙, 오류 표시, "다른 마크다운 프로그램에서는 합계가 보이지 않는다"는 한계를 쓴다.
- [ ] **Step 5: 전체 검사** — 순서대로 실행하고 모두 통과해야 한다:
  - `npm run typecheck` → 오류 0
  - `npm test` → 전부 PASS
  - `cargo test --manifest-path src-tauri/Cargo.toml` → PASS (Rust는 바꾸지 않았으므로 회귀 확인용)
  - `npm run tauri build` → 성공. 빌드 전에 `src-tauri\target\release\notevine.exe`로 띄운 앱이 있으면 그것만 닫는다.
- [ ] **Step 6: 사용자에게 보고** — 변경 파일, 통과한 검사, 앱에서 직접 확인한 것과 못 한 것, 팔레트 명령 포함 여부를 한국어로 적는다. 커밋은 하지 않는다.

---

## Self-Review

- **스펙 범위**: 저장 형식·합계 규칙(Task 2), 수식·오류·순환(Task 1), 읽기 모드(Task 3), 에디터 위젯·IME·쓰기 규칙·원문 편집·삭제 경고(Task 4), 삽입·도움말·문서·번역·검사(Task 5). 스펙의 "빈 블록은 원문으로 둔다"는 Task 4 `findSheetBlocks`, 반대 목표 "보기만 해서는 노트가 안 바뀐다"는 `sheetEdit`가 `null`을 돌려주는 테스트로 덮는다.
- **이름 일치**: `evaluateSheet`/`Evaluated`/`parseNumber`/`parseRef`(Task 1) → `parseSheet`/`serializeSheet`/`computeTotals`/`Total`/`formatNumber`/`displayCell`(Task 2) → `findSheetBlocks`/`sheetEdit`/`SheetBlockRange`/`sheetBlock`(Task 4)를 뒤 작업이 같은 이름으로 쓴다.
- **스펙과 다르게 정한 것 두 가지**: (1) 스펙 5.5의 "명령 팔레트로 넣기"는 에디터 서식 명령의 팔레트 경로가 없으면 FormatBar 단추로 줄인다(Task 5 Step 3). (2) 식 길이 1,000자·괄호 깊이 50 상한은 스펙에 없는 안전장치로 이 계획이 정했다.
