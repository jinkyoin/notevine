const pptxgen = require('pptxgenjs');
const out = process.argv[2] || require('path').join(__dirname, '..', 'docs', '화면설계서.pptx');

const pres = new pptxgen();
pres.layout = 'LAYOUT_WIDE'; // 13.333 x 7.5
pres.title = 'Notevine 화면 설계서';

const F = 'Malgun Gothic';
const MONO = 'Courier New';
const C = {
  dark: '1E3A23', green: '2F855A', moss: '97BC62', tint: 'EAF4EC',
  bg: 'FFFFFF', side: 'F4F6F3', border: 'CFD8CD', text: '1F2A1F', muted: '6B776B',
  accent: 'E07A2F', red: 'C0392B', redbg: 'FDECEA', greenbg: 'E3F2E6', chrome: 'E7ECE6',
  slideBg: 'F7F9F6',
};

// ---------- primitives ----------
function box(s, x, y, w, h, o = {}) {
  const opts = {
    x, y, w, h,
    fill: { color: o.fill || C.bg },
    line: o.line === null ? { type: 'none' } : { color: o.line || C.border, width: o.lw || 0.75, dashType: o.dash || 'solid' },
  };
  if (o.r) { opts.rectRadius = o.r; s.addShape(pres.shapes.ROUNDED_RECTANGLE, opts); }
  else s.addShape(pres.shapes.RECTANGLE, opts);
}
function t(s, text, x, y, w, h, o = {}) {
  s.addText(text, {
    x, y, w, h, margin: o.margin ?? 0, fontFace: o.font || F, fontSize: o.size || 9,
    color: o.color || C.text, bold: !!o.bold, italic: !!o.italic, align: o.align || 'left',
    valign: o.valign || 'middle', fill: o.fill ? { color: o.fill } : undefined,
    underline: o.underline, strike: o.strike, paraSpaceAfter: o.psa, lineSpacingMultiple: o.lsm,
  });
}
function line(s, x1, y1, x2, y2, o = {}) {
  s.addShape(pres.shapes.LINE, {
    x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1),
    flipH: x2 < x1, flipV: y2 < y1,
    line: { color: o.color || C.muted, width: o.width || 1, dashType: o.dash || 'solid', endArrowType: o.arrow ? 'triangle' : undefined },
  });
}
function mk(s, n, cx, cy) {
  const d = 0.27;
  s.addShape(pres.shapes.OVAL, { x: cx - d / 2, y: cy - d / 2, w: d, h: d, fill: { color: C.accent }, line: { color: 'FFFFFF', width: 1 } });
  t(s, String(n), cx - d / 2, cy - d / 2, d, d, { size: 9, bold: true, color: 'FFFFFF', align: 'center' });
}
function check(s, x, y, on) {
  box(s, x, y, 0.13, 0.13, { fill: on ? C.green : C.bg, line: on ? C.green : C.muted, r: 0.02 });
  if (on) t(s, '√', x, y - 0.01, 0.13, 0.14, { size: 7, color: 'FFFFFF', bold: true, align: 'center' });
}
function frame(s, x, y, w, h, title) {
  s.addShape(pres.shapes.RECTANGLE, { x: x + 0.04, y: y + 0.05, w, h, fill: { color: 'DDE3DB' }, line: { type: 'none' } });
  box(s, x, y, w, h, { fill: C.bg, line: C.border });
  box(s, x, y, w, 0.3, { fill: C.chrome, line: C.border });
  ['E5776B', 'E9B949', '7BBF6A'].forEach((c, i) =>
    s.addShape(pres.shapes.OVAL, { x: x + 0.12 + i * 0.17, y: y + 0.09, w: 0.12, h: 0.12, fill: { color: c }, line: { type: 'none' } }));
  if (title) t(s, title, x + 0.7, y, w - 1.4, 0.3, { size: 8.5, color: C.muted, align: 'center' });
}
function popup(s, x, y, w, h, title) {
  s.addShape(pres.shapes.RECTANGLE, { x: x + 0.05, y: y + 0.06, w, h, fill: { color: 'D3DAD1' }, line: { type: 'none' } });
  box(s, x, y, w, h, { fill: C.bg, line: C.border, r: 0.06 });
  if (title) {
    t(s, title, x + 0.15, y + 0.06, w - 0.5, 0.32, { size: 10, bold: true });
    line(s, x, y + 0.44, x + w, y + 0.44, { color: C.border, width: 0.75 });
  }
}
function input(s, x, y, w, text, o = {}) {
  box(s, x, y, w, 0.3, { fill: C.bg, line: o.focus ? C.green : C.border, lw: o.focus ? 1.25 : 0.75, r: 0.04 });
  t(s, text, x + 0.1, y, w - 0.2, 0.3, { size: 9, color: o.ph ? C.muted : C.text });
}
function btn(s, x, y, w, text, primary) {
  box(s, x, y, w, 0.3, { fill: primary ? C.green : C.bg, line: primary ? C.green : C.border, r: 0.05 });
  t(s, text, x, y, w, 0.3, { size: 9, align: 'center', bold: !!primary, color: primary ? 'FFFFFF' : C.text });
}
function chip(s, x, y, w, text, o = {}) {
  box(s, x, y, w, 0.24, { fill: o.fill || C.tint, line: o.line || C.tint, r: 0.12 });
  t(s, text, x + 0.08, y, w - 0.16, 0.24, { size: 8, color: o.color || C.dark, align: o.align || 'left' });
}

// ---------- slide furniture ----------
function header(s, title, sub, badge) {
  s.background = { color: C.slideBg };
  t(s, title, 0.5, 0.32, 9.5, 0.6, { size: 26, bold: true, color: C.dark });
  if (sub) t(s, sub, 0.5, 0.9, 10.5, 0.35, { size: 12, color: C.muted });
  if (badge) {
    box(s, 10.9, 0.42, 1.93, 0.4, { fill: C.tint, line: C.tint, r: 0.2 });
    t(s, badge, 10.9, 0.42, 1.93, 0.4, { size: 11, bold: true, color: C.green, align: 'center' });
  }
}
function spec(s, rows, o = {}) {
  const x = o.x ?? 8.45, y = o.y ?? 1.45, w = o.w ?? 4.38;
  const colW = o.colW || [0.32, 1.05, 2.23, 0.78];
  const hdr = ['#', '요소', '동작', '요구사항'].map(v => ({ text: v, options: { bold: true, color: 'FFFFFF', fill: { color: C.dark }, fontSize: 9 } }));
  const body = rows.map(r => r.map((v, i) => ({
    text: v,
    options: i === 0 ? { bold: true, color: C.accent, align: 'center', fontSize: 10 }
      : i === 3 ? { color: C.muted, fontSize: 8 } : { fontSize: 9 },
  })));
  s.addTable([hdr, ...body], {
    x, y, w, colW, fontFace: F, color: C.text, valign: 'middle',
    border: { type: 'solid', pt: 0.5, color: C.border }, fill: { color: 'FFFFFF' }, margin: [0.04, 0.06, 0.04, 0.06],
  });
}
function note(s, text, y = 6.85) {
  t(s, text, 0.5, y, 12.3, 0.35, { size: 10, color: C.muted, italic: true });
}

// =====================================================================
// 1. 표지
// =====================================================================
{
  const s = pres.addSlide();
  s.background = { color: C.dark };
  // vine/network motif
  const nodes = [[9.3, 1.5], [10.6, 2.2], [11.9, 1.4], [9.9, 3.4], [11.4, 3.6], [12.4, 2.8], [10.3, 4.9], [11.8, 5.3], [9.0, 5.6], [12.5, 4.6]];
  const edges = [[0, 1], [1, 2], [1, 3], [1, 4], [2, 5], [4, 5], [3, 6], [4, 7], [6, 8], [6, 7], [7, 9], [5, 9], [3, 4]];
  edges.forEach(([a, b]) => line(s, nodes[a][0], nodes[a][1], nodes[b][0], nodes[b][1], { color: '4E7A52', width: 1.5 }));
  nodes.forEach(([x, y], i) => {
    const d = i === 1 || i === 4 ? 0.42 : 0.26;
    s.addShape(pres.shapes.OVAL, { x: x - d / 2, y: y - d / 2, w: d, h: d, fill: { color: i === 4 ? C.accent : C.moss }, line: { color: C.dark, width: 2 } });
  });
  t(s, 'Notevine', 0.8, 2.0, 7.5, 0.8, { size: 22, color: C.moss, bold: true });
  t(s, '화면 설계서', 0.8, 2.75, 7.5, 1.0, { size: 48, color: 'FFFFFF', bold: true });
  t(s, '노트가 덩굴처럼 이어지는 범용 로컬 마크다운 지식관리 앱', 0.8, 3.85, 7.8, 0.45, { size: 16, color: 'D7E6D4' });
  t(s, 'v0.1 MVP  ·  화면 17개  ·  2026-10-28', 0.8, 5.6, 7.5, 0.4, { size: 13, color: C.moss });
  t(s, '기준 문서: docs/개발계획서.md, docs/요구사항정의서.md', 0.8, 6.0, 7.5, 0.35, { size: 11, color: '9FB59C' });
}

// =====================================================================
// 2. 화면 목록
// =====================================================================
{
  const s = pres.addSlide();
  header(s, '화면 목록', 'v0.1에서 만드는 화면 17개와 관련 요구사항', '17 screens');
  const rows = [
    ['SCR-01', '시작 화면 (볼트 선택)', '전체 화면', 'FR-VLT-01~02, FR-PRS-01', 'M'],
    ['SCR-02', '메인 화면 (기본 레이아웃)', '전체 화면', 'FR-UI-01~02', 'M'],
    ['SCR-03', '파일 탐색기', '왼쪽 사이드바', 'FR-VLT-03~04', 'M'],
    ['SCR-04', '편집기', '가운데 영역', 'FR-EDT-01~06, FR-LNK-01·02·04, FR-ATT-01·02·04·05', 'M'],
    ['SCR-05', '검색·필터', '왼쪽 사이드바', 'FR-SRC-02~05', 'M'],
    ['SCR-06', '아이디어 보드 (프리셋)', '왼쪽 사이드바', 'FR-PRS-05~06', 'M'],
    ['SCR-07', '백링크 패널', '오른쪽 패널', 'FR-LNK-03', 'M'],
    ['SCR-08', '속성 패널', '오른쪽 패널', 'FR-PRP-01~03, FR-PRS-07', 'M'],
    ['SCR-09', '히스토리 패널', '오른쪽 패널', 'FR-HIS-03~04', 'M'],
    ['SCR-10', '버전 보기·비교', '모달', 'FR-HIS-04~06', 'M (비교 S)'],
    ['SCR-11', '빠른 열기', '팝업', 'FR-SRC-01', 'M'],
    ['SCR-12', '명령 팔레트', '팝업', 'FR-UI-04, FR-EXT-01', 'S'],
    ['SCR-13', '빠른 메모', '팝업', 'FR-PRS-04', 'M'],
    ['SCR-14', '템플릿 선택', '팝업', 'FR-PRP-04, FR-PRS-03', 'M'],
    ['SCR-15', '이름 변경 확인', '대화상자', 'FR-LNK-05', 'S'],
    ['SCR-16', '설정', '모달', 'FR-UI-02~03, FR-PRS-01·02·05', 'M'],
    ['SCR-17', '알림 (토스트)', '오버레이', 'NFR-REL-01~03, FR-ATT-05', 'M'],
  ];
  const hdr = ['화면 ID', '화면명', '형태', '관련 요구사항', '우선순위'].map(v => ({ text: v, options: { bold: true, color: 'FFFFFF', fill: { color: C.dark } } }));
  const body = rows.map((r, i) => r.map((v, j) => ({
    text: v,
    options: {
      fill: { color: i % 2 ? 'FFFFFF' : 'F1F6F0' },
      bold: j === 0, color: j === 0 ? C.green : (j === 4 && v.startsWith('S') ? C.accent : C.text),
      align: j === 4 ? 'center' : 'left',
    },
  })));
  s.addTable([hdr, ...body], {
    x: 0.5, y: 1.4, w: 12.33, colW: [1.2, 3.3, 1.7, 4.83, 1.3], fontFace: F, fontSize: 10.5, rowH: 0.29,
    valign: 'middle', border: { type: 'solid', pt: 0.5, color: C.border }, margin: [0.02, 0.1, 0.02, 0.1],
  });
  note(s, 'M = v0.1 필수  ·  S = 3일 차 점검에서 일정이 하루 이상 밀리면 v0.2로 이동', 6.95);
}

// =====================================================================
// 3. 화면 흐름
// =====================================================================
{
  const s = pres.addSlide();
  header(s, '화면 흐름', '시작 화면에서 메인 화면으로 들어가고, 나머지는 메인 화면의 패널과 팝업으로 연다');
  const node = (x, y, w, h, id, name, o = {}) => {
    box(s, x, y, w, h, { fill: o.fill || C.bg, line: o.line || C.border, r: 0.06, lw: o.lw });
    t(s, id, x + 0.1, y, 0.75, h, { size: 9, bold: true, color: o.idc || C.green });
    t(s, name, x + 0.82, y, w - 0.9, h, { size: 10.5, bold: !!o.bold, color: o.color || C.text });
  };
  // start & main
  node(0.5, 3.55, 2.0, 0.6, 'SCR-01', '시작 화면');
  node(3.0, 3.55, 2.0, 0.6, 'SCR-02', '메인 화면', { fill: C.green, line: C.green, idc: 'D7F0DC', color: 'FFFFFF', bold: true });
  line(s, 2.5, 3.85, 3.0, 3.85, { arrow: true, color: C.dark, width: 1.25 });
  t(s, '볼트 열기', 2.45, 3.25, 0.7, 0.3, { size: 8.5, color: C.muted, align: 'center' });

  // groups
  const group = (x, y, w, h, title) => {
    box(s, x, y, w, h, { fill: 'EEF3ED', line: C.border, r: 0.06 });
    t(s, title, x + 0.12, y + 0.04, w - 0.2, 0.3, { size: 9.5, bold: true, color: C.muted });
  };
  group(5.6, 1.45, 2.6, 1.85, '왼쪽 사이드바');
  node(5.75, 1.82, 2.3, 0.4, 'SCR-03', '파일 탐색기');
  node(5.75, 2.3, 2.3, 0.4, 'SCR-05', '검색·필터');
  node(5.75, 2.78, 2.3, 0.4, 'SCR-06', '아이디어 보드');
  node(5.6, 3.6, 2.6, 0.5, 'SCR-04', '편집기', { bold: true });
  group(5.6, 4.4, 2.6, 1.85, '오른쪽 패널');
  node(5.75, 4.77, 2.3, 0.4, 'SCR-07', '백링크');
  node(5.75, 5.25, 2.3, 0.4, 'SCR-08', '속성');
  node(5.75, 5.73, 2.3, 0.4, 'SCR-09', '히스토리');
  // main -> groups
  line(s, 5.0, 3.85, 5.3, 3.85, { color: C.dark });
  line(s, 5.3, 2.38, 5.3, 5.33, { color: C.dark });
  line(s, 5.3, 2.38, 5.6, 2.38, { arrow: true, color: C.dark });
  line(s, 5.3, 3.85, 5.6, 3.85, { arrow: true, color: C.dark });
  line(s, 5.3, 5.33, 5.6, 5.33, { arrow: true, color: C.dark });
  // history -> version
  node(8.75, 5.65, 2.6, 0.56, 'SCR-10', '버전 보기·비교');
  line(s, 8.05, 5.93, 8.75, 5.93, { arrow: true, color: C.dark });
  t(s, '버전 클릭', 8.08, 5.6, 0.7, 0.3, { size: 8, color: C.muted, align: 'center' });

  // popups
  group(8.75, 1.45, 4.08, 3.9, '팝업·모달 (어디서나 단축키로)');
  const pops = [
    ['SCR-11', '빠른 열기', 'Ctrl+O'], ['SCR-12', '명령 팔레트', 'Ctrl+P'], ['SCR-13', '빠른 메모', 'Ctrl+Shift+N'],
    ['SCR-14', '템플릿 선택', 'Ctrl+N'], ['SCR-15', '이름 변경 확인', 'F2 · 이동 시'], ['SCR-16', '설정', 'Ctrl+,'], ['SCR-17', '알림 (토스트)', '자동 표시'],
  ];
  pops.forEach(([id, name, key], i) => {
    const yy = 1.85 + i * 0.48;
    node(8.9, yy, 3.78, 0.4, id, name);
    t(s, key, 11.2, yy, 1.38, 0.4, { size: 8.5, color: C.muted, align: 'right', font: F });
  });
  // main -> popups (dashed route along bottom)
  line(s, 4.0, 4.15, 4.0, 6.75, { dash: 'dash', color: C.muted });
  line(s, 4.0, 6.75, 12.3, 6.75, { dash: 'dash', color: C.muted });
  line(s, 12.3, 6.75, 12.3, 5.35, { dash: 'dash', color: C.muted, arrow: true });
  t(s, '단축키 · 메뉴 · 명령 팔레트', 9.3, 6.78, 2.9, 0.3, { size: 8.5, color: C.muted, align: 'right' });
}

// =====================================================================
// 4. 공통 규칙
// =====================================================================
{
  const s = pres.addSlide();
  header(s, '공통 규칙', '모든 화면에 적용하는 크기·글꼴·색·단축키 기준');
  // card 1: layout
  box(s, 0.5, 1.45, 3.9, 5.3, { fill: 'FFFFFF', line: C.border, r: 0.08 });
  t(s, '레이아웃', 0.75, 1.6, 3.4, 0.4, { size: 15, bold: true, color: C.dark });
  // schematic
  const sx = 0.75, sy = 2.15;
  box(s, sx, sy, 3.4, 1.7, { fill: C.bg, line: C.border });
  box(s, sx, sy, 0.22, 1.7, { fill: C.chrome, line: C.border });
  box(s, sx + 0.22, sy, 0.85, 1.7, { fill: C.side, line: C.border });
  box(s, sx + 1.07, sy, 1.43, 1.7, { fill: C.bg, line: C.border });
  box(s, sx + 2.5, sy, 0.9, 1.7, { fill: C.side, line: C.border });
  t(s, '260px', sx + 0.22, sy + 0.7, 0.85, 0.3, { size: 9, align: 'center', color: C.muted });
  t(s, '편집기\n최대 760px', sx + 1.07, sy + 0.6, 1.43, 0.5, { size: 9, align: 'center', color: C.muted });
  t(s, '300px', sx + 2.5, sy + 0.7, 0.9, 0.3, { size: 9, align: 'center', color: C.muted });
  s.addText([
    { text: '최소 창 크기 960 × 600 px', options: { bullet: true, breakLine: true } },
    { text: '사이드바 200~480px, 오른쪽 패널 240~520px 조절·접기', options: { bullet: true, breakLine: true } },
    { text: '창 폭 1100px 미만이면 오른쪽 패널 자동 접기', options: { bullet: true, breakLine: true } },
    { text: '간격은 4px 배수 (4·8·12·16·24)', options: { bullet: true, breakLine: true } },
    { text: '키보드만으로 모든 화면 사용, 포커스 테두리 항상 표시', options: { bullet: true } },
  ], { x: 0.75, y: 4.0, w: 3.5, h: 2.6, fontFace: F, fontSize: 10.5, color: C.text, paraSpaceAfter: 6, valign: 'top', margin: 0 });

  // card 2: type & color
  box(s, 4.65, 1.45, 3.9, 5.3, { fill: 'FFFFFF', line: C.border, r: 0.08 });
  t(s, '글꼴·색', 4.9, 1.6, 3.4, 0.4, { size: 15, bold: true, color: C.dark });
  const fonts = [['UI·본문', 'Pretendard → 시스템 산세리프', '본문 16px · 줄 간격 1.7'], ['코드', 'D2Coding → JetBrains Mono', '고정폭']];
  fonts.forEach(([k, v, d], i) => {
    const yy = 2.15 + i * 0.62;
    t(s, k, 4.9, yy, 0.8, 0.28, { size: 10, bold: true, color: C.muted });
    t(s, v, 5.7, yy, 2.7, 0.28, { size: 10.5 });
    t(s, d, 5.7, yy + 0.27, 2.7, 0.25, { size: 9, color: C.muted });
  });
  t(s, '색 토큰 (라이트 / 다크)', 4.9, 3.5, 3.4, 0.3, { size: 10, bold: true, color: C.muted });
  const sw = [['--bg', 'FFFFFF', '1B1F1B'], ['--bg-sidebar', 'F4F6F3', '232823'], ['--text', '1F2A1F', 'E6ECE5'], ['--accent', '2F855A', '68D391'], ['--danger', 'C0392B', 'F07167']];
  sw.forEach(([name, l, d], i) => {
    const yy = 3.88 + i * 0.5;
    box(s, 4.9, yy, 0.38, 0.38, { fill: l, line: C.border, r: 0.05 });
    box(s, 5.35, yy, 0.38, 0.38, { fill: d, line: C.border, r: 0.05 });
    t(s, name, 5.85, yy, 1.3, 0.38, { size: 10, font: MONO });
    t(s, `#${l} / #${d}`, 7.0, yy, 1.5, 0.38, { size: 8, color: C.muted });
  });
  t(s, '강조색은 덩굴을 연상하는 녹색 (시안)', 4.9, 6.4, 3.5, 0.28, { size: 9, color: C.muted, italic: true });

  // card 3: shortcuts
  box(s, 8.8, 1.45, 4.03, 5.3, { fill: 'FFFFFF', line: C.border, r: 0.08 });
  t(s, '단축키', 9.05, 1.6, 3.5, 0.4, { size: 15, bold: true, color: C.dark });
  const keys = [['Ctrl+O', '빠른 열기'], ['Ctrl+P', '명령 팔레트'], ['Ctrl+Shift+N', '빠른 메모'], ['Ctrl+N', '새 노트 (템플릿)'], ['Ctrl+Shift+D', '오늘 업무일지'], ['Ctrl+Shift+F', '검색 탭'], ['Ctrl+S', '수동 저장 (스냅샷)'], ['Ctrl+\\', '왼쪽 사이드바 접기'], ['Ctrl+Shift+\\', '오른쪽 패널 접기'], ['Ctrl+,', '설정'], ['F2', '이름 변경'], ['Alt+← / →', '이전 / 다음 노트']];
  keys.forEach(([k, v], i) => {
    const yy = 2.12 + i * 0.36;
    box(s, 9.05, yy + 0.03, 1.45, 0.27, { fill: C.side, line: C.border, r: 0.05 });
    t(s, k, 9.05, yy + 0.03, 1.45, 0.27, { size: 9, font: MONO, align: 'center', bold: true });
    t(s, v, 10.65, yy, 2.0, 0.33, { size: 10 });
  });
  t(s, 'v0.1은 Windows 기준 · 조합은 확정 전', 9.05, 6.4, 3.6, 0.28, { size: 9, color: C.muted, italic: true });
}

// =====================================================================
// 5. SCR-01 시작 화면
// =====================================================================
{
  const s = pres.addSlide();
  header(s, '시작 화면', '볼트가 없거나 마지막 볼트를 찾지 못할 때 보이는 첫 화면', 'SCR-01 · M');
  const X = 0.5, Y = 1.45, W = 7.6, H = 5.25;
  frame(s, X, Y, W, H, 'Notevine');
  // logo
  s.addShape(pres.shapes.OVAL, { x: X + 3.15, y: Y + 0.6, w: 0.42, h: 0.42, fill: { color: C.green }, line: { type: 'none' } });
  s.addShape(pres.shapes.OVAL, { x: X + 3.55, y: Y + 0.75, w: 0.26, h: 0.26, fill: { color: C.moss }, line: { type: 'none' } });
  t(s, 'Notevine', X + 3.9, Y + 0.55, 2.0, 0.5, { size: 20, bold: true, color: C.dark });
  t(s, '노트가 이어지는 나만의 지식 공간', X, Y + 1.1, W, 0.3, { size: 10, color: C.muted, align: 'center' });
  // options
  const ox = X + 1.3, ow = 5.0;
  box(s, ox, Y + 1.6, ow, 0.55, { fill: C.bg, line: C.green, lw: 1.25, r: 0.06 });
  t(s, '▤  폴더를 볼트로 열기', ox + 0.25, Y + 1.6, 3.5, 0.55, { size: 11, bold: true });
  t(s, '기존 .md 폴더도 그대로', ox + 3.0, Y + 1.6, 1.85, 0.55, { size: 8.5, color: C.muted, align: 'right' });
  box(s, ox, Y + 2.3, ow, 0.85, { fill: C.bg, line: C.border, r: 0.06 });
  t(s, '＋  새 볼트 만들기', ox + 0.25, Y + 2.33, 3.5, 0.45, { size: 11, bold: true });
  check(s, ox + 0.55, Y + 2.86, true);
  t(s, '기록 관리 프리셋 사용 (업무·아이디어·자료)', ox + 0.75, Y + 2.78, 3.9, 0.3, { size: 9, color: C.text });
  // recent
  t(s, '최근 볼트', ox, Y + 3.35, 2, 0.3, { size: 9.5, bold: true, color: C.muted });
  line(s, ox, Y + 3.67, ox + ow, Y + 3.67, { color: C.border, width: 0.75 });
  const rec = [['업무노트', 'D:\\Notes\\업무노트', '2026-10-27', false], ['개인위키', 'C:\\Users\\me\\wiki', '2026-10-20', false], ['예전노트', 'E:\\old\\notes  (찾을 수 없음)', '2026-08-02', true]];
  rec.forEach(([n, p, d, miss], i) => {
    const yy = Y + 3.75 + i * 0.33;
    const col = miss ? 'A9B2A8' : C.text;
    t(s, n, ox + 0.1, yy, 1.1, 0.3, { size: 9.5, bold: !miss, color: col });
    t(s, p, ox + 1.2, yy, 2.6, 0.3, { size: 8.5, color: miss ? 'A9B2A8' : C.muted });
    t(s, d, ox + 3.85, yy, 1.05, 0.3, { size: 8.5, color: miss ? 'A9B2A8' : C.muted, align: 'right' });
  });
  chip(s, X + W - 2.15, Y + H - 0.42, 0.9, '한국어 ▾', { fill: C.side, line: C.border, color: C.text, align: 'center' });
  chip(s, X + W - 1.15, Y + H - 0.42, 0.9, '라이트 ◐', { fill: C.side, line: C.border, color: C.text, align: 'center' });
  mk(s, 1, ox - 0.05, Y + 1.6); mk(s, 2, ox - 0.05, Y + 2.3); mk(s, 3, ox - 0.25, Y + 3.5); mk(s, 4, X + W - 2.2, Y + H - 0.45);
  spec(s, [
    ['1', '폴더를 볼트로 열기', 'OS 폴더 선택 창 → 메인 화면. Obsidian 볼트 등 기존 .md 폴더도 그대로 연다', 'FR-VLT-01'],
    ['2', '새 볼트 만들기', '위치·이름 입력 후 폴더 생성. 프리셋을 켜면 기본 폴더·템플릿 4종 생성', 'FR-PRS-01~02'],
    ['3', '최근 볼트', '클릭해 열기. 경로가 없으면 흐리게 + "찾을 수 없음", 우클릭으로 목록에서 제거', 'FR-VLT-02'],
    ['4', '언어·테마', '한국어/English, 라이트/다크/시스템 즉시 전환', 'FR-UI-02~03'],
  ]);
  t(s, '첫 인덱싱 중에도 바로 메인 화면에 들어가 편집할 수 있고, 진행률은 상태바에 보인다.', 8.45, 5.55, 4.38, 0.8, { size: 10, color: C.muted, valign: 'top' });
}

// =====================================================================
// main screen drawer (used on SCR-02)
// =====================================================================
function drawMain(s, X, Y, W, H) {
  frame(s, X, Y, W, H, 'Notevine — 업무노트');
  const top = Y + 0.3, bar = 0.34, stat = 0.28;
  const bodyY = top + bar, bodyH = H - 0.3 - bar - stat;
  // topbar
  box(s, X, top, W, bar, { fill: C.bg, line: C.border });
  t(s, '◀  ▶', X + 0.12, top, 0.5, bar, { size: 9, color: C.muted });
  t(s, '업무노트 / 10 업무일지 / 2026 / 2026-10-28.md', X + 0.7, top, 4.5, bar, { size: 9, color: C.muted });
  t(s, '◎    ※', X + W - 0.75, top, 0.6, bar, { size: 10, color: C.muted });
  // activity bar
  const ab = 0.36;
  box(s, X, bodyY, ab, bodyH, { fill: C.chrome, line: C.border });
  ['▤', '◎', '◆'].forEach((g, i) => {
    if (i === 0) box(s, X + 0.05, bodyY + 0.1 + i * 0.42, 0.26, 0.3, { fill: C.tint, line: C.tint, r: 0.04 });
    t(s, g, X, bodyY + 0.1 + i * 0.42, ab, 0.3, { size: 11, color: i === 0 ? C.green : C.muted, align: 'center' });
  });
  t(s, '※', X, bodyY + bodyH - 0.4, ab, 0.3, { size: 11, color: C.muted, align: 'center' });
  // sidebar
  const sbx = X + ab, sbw = 1.85;
  box(s, sbx, bodyY, sbw, bodyH, { fill: C.side, line: C.border });
  t(s, '파일 탐색기', sbx + 0.12, bodyY + 0.05, 1.3, 0.3, { size: 9, bold: true });
  const tree = [['▾ 00 Inbox', 0], ['▾ 10 업무일지', 0], ['▾ 2026', 1], ['2026-10-28', 2, true], ['2026-10-27', 2], ['▸ 20 아이디어', 0], ['▸ 30 조사자료', 0], ['▸ 90 템플릿', 0], ['▸ 첨부', 0]];
  tree.forEach(([n, lv, cur], i) => {
    const yy = bodyY + 0.4 + i * 0.28;
    if (cur) box(s, sbx + 0.05, yy, sbw - 0.1, 0.26, { fill: C.tint, line: C.tint, r: 0.03 });
    t(s, n, sbx + 0.15 + lv * 0.18, yy, sbw - 0.3, 0.26, { size: 8.5, color: cur ? C.green : C.text, bold: !!cur });
  });
  // right panel
  const rpw = 1.9, rpx = X + W - rpw;
  box(s, rpx, bodyY, rpw, bodyH, { fill: C.side, line: C.border });
  ['백링크', '속성', '히스토리'].forEach((n, i) => {
    const tx = rpx + 0.08 + i * 0.6;
    if (i === 0) box(s, tx, bodyY + 0.08, 0.56, 0.26, { fill: C.bg, line: C.border, r: 0.04 });
    t(s, n, tx, bodyY + 0.08, 0.56, 0.26, { size: 8, align: 'center', bold: i === 0, color: i === 0 ? C.text : C.muted });
  });
  t(s, '백링크 (2)', rpx + 0.12, bodyY + 0.45, 1.6, 0.25, { size: 8.5, bold: true });
  [['회의록 1027', '…[[2026-10-28]] 참고'], ['주간보고 W44', '…월요일 업무일지에서…']].forEach(([n, c], i) => {
    const yy = bodyY + 0.78 + i * 0.62;
    box(s, rpx + 0.1, yy, rpw - 0.2, 0.52, { fill: C.bg, line: C.border, r: 0.04 });
    t(s, n, rpx + 0.18, yy + 0.04, rpw - 0.35, 0.22, { size: 8.5, bold: true, color: C.green });
    t(s, c, rpx + 0.18, yy + 0.26, rpw - 0.35, 0.22, { size: 7.5, color: C.muted });
  });
  // editor
  const ex = sbx + sbw + 0.3, ew = rpx - ex - 0.3;
  t(s, '2026-10-28 업무일지', ex, bodyY + 0.2, ew, 0.4, { size: 15, bold: true });
  chip(s, ex, bodyY + 0.68, 1.1, 'type: journal', { fill: C.side, line: C.border, color: C.muted });
  chip(s, ex + 1.18, bodyY + 0.68, 1.3, 'date: 2026-10-28', { fill: C.side, line: C.border, color: C.muted });
  t(s, '한 일', ex, bodyY + 1.1, ew, 0.32, { size: 12, bold: true });
  check(s, ex + 0.05, bodyY + 1.58, true);
  t(s, '요구사항 정의서 작성', ex + 0.28, bodyY + 1.5, ew, 0.28, { size: 9.5, strike: 'sngStrike', color: C.muted });
  check(s, ex + 0.05, bodyY + 1.9, false);
  s.addText([{ text: '화면 설계', options: { color: C.green, underline: { style: 'sng' } } }, { text: ' 검토', options: {} }], { x: ex + 0.28, y: bodyY + 1.82, w: ew, h: 0.28, fontFace: F, fontSize: 9.5, color: C.text, margin: 0, valign: 'middle' });
  t(s, '회의', ex, bodyY + 2.3, ew, 0.32, { size: 12, bold: true });
  t(s, '· 오후 2시 기획 회의 — 결정 사항은 회의록 1027에 정리', ex + 0.05, bodyY + 2.68, ew, 0.28, { size: 9.5 });
  t(s, '· 다음 할 일: 1일 차 작업 목록 만들기', ex + 0.05, bodyY + 2.98, ew, 0.28, { size: 9.5 });
  // status bar
  const sy = Y + H - stat;
  box(s, X, sy, W, stat, { fill: C.chrome, line: C.border });
  t(s, '√ 저장됨  ·  1,284 단어  ·  노트 10,000개  ·  인덱싱 완료', X + 0.15, sy, 4.5, stat, { size: 8, color: C.muted });
  t(s, 'Ln 12, Col 4', X + W - 1.3, sy, 1.15, stat, { size: 8, color: C.muted, align: 'right' });
  return { top, bodyY, bodyH, ab, sbx, sbw, rpx, rpw, ex, ew, sy };
}

// =====================================================================
// 6. SCR-02 메인 화면
// =====================================================================
{
  const s = pres.addSlide();
  header(s, '메인 화면', '왼쪽 사이드바 · 가운데 편집기 · 오른쪽 패널의 3단 구성', 'SCR-02 · M');
  const X = 0.5, Y = 1.45, W = 7.6, H = 5.25;
  const m = drawMain(s, X, Y, W, H);
  mk(s, 1, X + 5.6, m.top + 0.17);
  mk(s, 2, X + 0.18, m.bodyY + 1.5);
  mk(s, 3, m.sbx + m.sbw - 0.2, m.bodyY + 0.2);
  mk(s, 4, m.ex + m.ew - 0.1, m.bodyY + 0.4);
  mk(s, 5, m.rpx + m.rpw - 0.2, m.bodyY + 0.55);
  mk(s, 6, X + 4.9, m.sy + 0.14);
  spec(s, [
    ['1', '상단바', '뒤로/앞으로, 현재 노트 경로(클릭 시 폴더 선택), 검색·설정', 'FR-UI-01'],
    ['2', '활동 막대', '탐색기 · 검색 · 아이디어 보드(프리셋 켬일 때) · 설정 전환', 'FR-UI-01, FR-PRS-06'],
    ['3', '왼쪽 사이드바', '활동 막대에서 고른 탭. 200~480px 조절, Ctrl+\\로 접기', 'SCR-03/05/06'],
    ['4', '편집기', '열린 노트 편집. 노트가 없으면 빈 상태 화면', 'SCR-04'],
    ['5', '오른쪽 패널', '백링크 · 속성 · 히스토리 탭. 창 폭 1100px 미만이면 자동 접기', 'SCR-07/08/09'],
    ['6', '상태바', '저장 상태, 단어 수, 노트 수, 인덱싱 진행률, 커서 위치', 'FR-EDT-03'],
  ]);
  box(s, 8.45, 5.45, 4.38, 1.25, { fill: C.tint, line: C.tint, r: 0.06 });
  t(s, '빈 상태 (열린 노트 없음)', 8.6, 5.52, 4.1, 0.3, { size: 10, bold: true, color: C.dark });
  btn(s, 8.6, 5.92, 1.3, '새 노트', false);
  btn(s, 10.0, 5.92, 1.3, '빠른 열기', false);
  btn(s, 11.4, 5.92, 1.3, '오늘 업무일지', true);
  t(s, 'Ctrl+N            Ctrl+O            Ctrl+Shift+D', 8.6, 6.3, 4.1, 0.28, { size: 8, color: C.muted, font: MONO });
}

// =====================================================================
// 7. SCR-03 파일 탐색기
// =====================================================================
{
  const s = pres.addSlide();
  header(s, '파일 탐색기', '볼트의 폴더·노트를 트리로 보여 주고 파일을 다룬다', 'SCR-03 · M');
  const X = 0.5, Y = 1.45, W = 3.4, H = 5.25;
  box(s, X, Y, W, H, { fill: C.side, line: C.border, r: 0.04 });
  t(s, '파일 탐색기', X + 0.15, Y + 0.1, 1.6, 0.35, { size: 11, bold: true });
  ['＋N', '＋F', '⇅'].forEach((g, i) => {
    box(s, X + 1.95 + i * 0.47, Y + 0.12, 0.4, 0.3, { fill: C.bg, line: C.border, r: 0.04 });
    t(s, g, X + 1.95 + i * 0.47, Y + 0.12, 0.4, 0.3, { size: 8.5, align: 'center', color: C.muted });
  });
  line(s, X, Y + 0.55, X + W, Y + 0.55, { color: C.border, width: 0.75 });
  const tree = [['▾ 00 Inbox', 0, '', 0], ['아이디어 메모 1028', 1, '', 0], ['▾ 10 업무일지', 0, '', 0], ['▾ 2026', 1, '', 0], ['2026-10-28', 2, '', 1], ['2026-10-27', 2, '', 0], ['▸ 20 아이디어', 0, '12', 0], ['▸ 30 조사자료', 0, '34', 0], ['▸ 90 템플릿', 0, '4', 0], ['▸ 첨부', 0, '', 0]];
  tree.forEach(([n, lv, cnt, cur], i) => {
    const yy = Y + 0.7 + i * 0.36;
    if (cur) box(s, X + 0.08, yy, W - 0.16, 0.32, { fill: C.tint, line: C.tint, r: 0.04 });
    if (i === 5) box(s, X + 0.08, yy, W - 0.16, 0.32, { fill: C.bg, line: C.green, dash: 'dash', r: 0.04 });
    t(s, n, X + 0.2 + lv * 0.25, yy, 2.3, 0.32, { size: 10, bold: !!cur, color: cur ? C.green : C.text });
    if (cnt) t(s, cnt, X + W - 0.6, yy, 0.45, 0.32, { size: 9, color: C.muted, align: 'right' });
  });
  t(s, '[새 노트 추가 중…]', X + 0.2, Y + 4.4, 2.5, 0.3, { size: 9, color: C.muted, italic: true });
  // context menu
  const cx = 4.3, cy = 3.45;
  popup(s, cx, cy, 2.3, 2.75);
  const menu = ['새 노트', '이름 변경          F2', '복제', '히스토리 보기', '탐색기에서 보기', '경로 복사', '삭제 (휴지통)'];
  menu.forEach((n, i) => {
    const yy = cy + 0.12 + i * 0.36;
    if (i === 1) box(s, cx + 0.06, yy, 2.18, 0.32, { fill: C.tint, line: C.tint, r: 0.03 });
    t(s, n, cx + 0.18, yy, 2.0, 0.32, { size: 9.5, color: i === 6 ? C.red : C.text });
  });
  // drag hint
  box(s, 4.3, 1.45, 3.8, 1.75, { fill: 'FFFFFF', line: C.border, r: 0.06 });
  t(s, '드래그 앤 드롭으로 이동', 4.45, 1.55, 3.5, 0.32, { size: 10.5, bold: true, color: C.dark });
  t(s, '노트를 다른 폴더에 놓으면 이동하고, 이 노트를 가리키는 링크가 있으면 SCR-15(이름 변경 확인)로 링크 갱신을 묻는다. 놓을 수 있는 곳은 녹색 점선으로 표시.', 4.45, 1.9, 3.5, 1.2, { size: 9.5, color: C.text, valign: 'top' });
  mk(s, 1, X + W + 0.14, Y + 0.27); mk(s, 2, X + 0.12, Y + 0.7 + 4 * 0.36 + 0.16); mk(s, 3, X + W - 0.85, Y + 0.7 + 6 * 0.36 + 0.16); mk(s, 4, cx + 2.25, cy + 0.05); mk(s, 5, 4.25, 1.5);
  spec(s, [
    ['1', '도구 버튼', '새 노트 · 새 폴더(선택 폴더 안, 이름 입력 상태로) · 정렬(이름/수정일/생성일)', 'FR-VLT-03'],
    ['2', '현재 노트', '편집기에 열린 노트를 녹색으로 강조. 클릭하면 편집기에서 연다', '—'],
    ['3', '노트 수', '접힌 폴더 오른쪽에 노트 수 표시', '—'],
    ['4', '우클릭 메뉴', '새 노트 · 이름 변경 · 복제 · 히스토리 · 탐색기에서 보기 · 경로 복사 · 삭제', 'FR-VLT-03, FR-HIS-07'],
    ['5', '드래그 이동', '노트·폴더 이동 후 링크 갱신 확인', 'FR-LNK-05'],
  ]);
  t(s, '· .app/ 와 점(.)으로 시작하는 폴더는 숨긴다 (FR-VLT-05)\n· 외부에서 추가·삭제된 파일은 1초 안에 트리에 반영 (FR-VLT-04)', 8.45, 5.2, 4.38, 0.9, { size: 10, color: C.muted, valign: 'top' });
}

// =====================================================================
// 8. SCR-04 편집기
// =====================================================================
{
  const s = pres.addSlide();
  header(s, '편집기', '라이브 미리보기 마크다운 편집기 — 위키링크 자동완성과 자동 저장', 'SCR-04 · M');
  const X = 0.5, Y = 1.45, W = 7.6, H = 5.25;
  box(s, X, Y, W, H, { fill: C.bg, line: C.border, r: 0.04 });
  const ex = X + 0.5, ew = W - 1.0;
  t(s, '2026-10-28 업무일지', ex, Y + 0.2, ew, 0.5, { size: 18, bold: true });
  chip(s, ex, Y + 0.78, 1.15, 'type: journal', { fill: C.side, line: C.border, color: C.muted });
  chip(s, ex + 1.23, Y + 0.78, 1.35, 'date: 2026-10-28', { fill: C.side, line: C.border, color: C.muted });
  t(s, '▾ 속성 2개', ex + 2.68, Y + 0.78, 1.0, 0.24, { size: 8, color: C.muted });
  t(s, '한 일', ex, Y + 1.2, ew, 0.38, { size: 14, bold: true });
  check(s, ex + 0.05, Y + 1.75, true);
  t(s, '요구사항 정의서 작성', ex + 0.3, Y + 1.66, 3, 0.3, { size: 10.5, strike: 'sngStrike', color: C.muted });
  check(s, ex + 0.05, Y + 2.1, false);
  s.addText([{ text: '화면 설계서', options: { color: C.green, underline: { style: 'sng' } } }, { text: ' 검토 — ', options: {} }, { text: '디자인 가이드', options: { color: C.green, underline: { style: 'dash' } } }, { text: '는 아직 없음', options: { color: C.muted } }], { x: ex + 0.3, y: Y + 2.01, w: ew, h: 0.3, fontFace: F, fontSize: 10.5, color: C.text, margin: 0, valign: 'middle' });
  // raw line with cursor (current line shows markdown)
  box(s, ex - 0.1, Y + 2.38, ew + 0.2, 0.32, { fill: 'F6F9F5', line: 'F6F9F5' });
  t(s, '- 참고: [[화면|', ex + 0.05, Y + 2.38, 3, 0.32, { size: 10.5, font: MONO, color: C.text });
  // autocomplete
  const ax = ex + 1.25, ay = Y + 2.75;
  popup(s, ax, ay, 2.9, 1.2);
  [['화면 설계서', 'docs', true], ['화면 설계 회의록 1027', '30 조사자료', false], ['＋ "화면" 새 노트 만들기', '', false]].forEach(([n, p, sel], i) => {
    const yy = ay + 0.08 + i * 0.35;
    if (sel) box(s, ax + 0.06, yy, 2.78, 0.32, { fill: C.tint, line: C.tint, r: 0.03 });
    t(s, n, ax + 0.15, yy, 1.9, 0.32, { size: 9.5, bold: sel, color: i === 2 ? C.green : C.text });
    if (p) t(s, p, ax + 1.95, yy, 0.82, 0.32, { size: 8, color: C.muted, align: 'right' });
  });
  // code block
  box(s, ex, Y + 4.08, 3.4, 0.82, { fill: '1F2A1F', line: '1F2A1F', r: 0.05 });
  t(s, 'sql', ex + 2.9, Y + 4.1, 0.4, 0.22, { size: 7, color: '9FB59C', align: 'right' });
  s.addText([
    { text: 'SELECT', options: { color: 'E9B949', breakLine: false } }, { text: ' path, title', options: { color: 'E6ECE5', breakLine: true } },
    { text: 'FROM', options: { color: 'E9B949' } }, { text: ' notes ', options: { color: 'E6ECE5' } }, { text: 'WHERE', options: { color: 'E9B949' } }, { text: " status='검토';", options: { color: '97BC62' } },
  ], { x: ex + 0.15, y: Y + 4.25, w: 3.2, h: 0.55, fontFace: MONO, fontSize: 9, margin: 0, valign: 'top' });
  // image
  box(s, ex + 3.6, Y + 4.08, 2.6, 0.82, { fill: C.side, line: C.border, r: 0.05 });
  t(s, '구조도.png (미리보기)', ex + 3.6, Y + 4.08, 2.6, 0.82, { size: 9, color: C.muted, align: 'center' });
  // non-image attachment
  box(s, ex + 4.35, Y + 3.62, 2.1, 0.32, { fill: C.side, line: C.border, r: 0.05 });
  box(s, ex + 4.45, Y + 3.68, 0.34, 0.2, { fill: C.green, line: C.green, r: 0.03 });
  t(s, 'xlsx', ex + 4.45, Y + 3.68, 0.34, 0.2, { size: 6.5, bold: true, color: 'FFFFFF', align: 'center' });
  t(s, '견적서.xlsx  ↗', ex + 4.87, Y + 3.62, 1.5, 0.32, { size: 9.5, color: C.green });
  // status
  t(s, '√ 저장됨', X + W - 1.2, Y + H - 0.32, 1.05, 0.25, { size: 8.5, color: C.green, align: 'right' });
  mk(s, 1, ex - 0.25, Y + 0.45); mk(s, 2, ex - 0.25, Y + 0.9); mk(s, 3, ex - 0.25, Y + 1.39); mk(s, 4, ax + 3.0, ay + 0.15); mk(s, 5, ex + 3.95, Y + 2.0); mk(s, 6, ex - 0.25, Y + 4.3); mk(s, 7, ex + 6.3, Y + 4.3); mk(s, 8, X + W - 1.35, Y + H - 0.2); mk(s, 9, ex + 4.35, Y + 3.5);
  spec(s, [
    ['1', '제목', '파일명을 크게 표시. 클릭해 바꾸면 이름 변경', 'FR-VLT-03'],
    ['2', '속성 요약', 'frontmatter를 한 줄 칩으로 접어 표시, 클릭하면 YAML 편집', 'FR-PRP-01'],
    ['3', '라이브 미리보기', '커서 없는 줄은 서식, 커서 줄은 원문(회색 배경)', 'FR-EDT-02'],
    ['4', '위키링크 자동완성', '[[ 입력 시 팝업, 한글 부분 일치, ↑↓·Enter, 없으면 새 노트', 'FR-LNK-01'],
    ['5', '링크', '녹색 밑줄 = 있는 노트, 점선 = 없는 노트(클릭 시 생성)', 'FR-LNK-02'],
    ['6', '코드 블록', '언어별 문법 강조', 'FR-EDT-06'],
    ['7', '이미지', '미리보기 표시. 파일(형식 제한 없음)을 끌어 놓거나 캡처를 Ctrl+V로 붙여넣으면 첨부/에 저장 후 링크 삽입', 'FR-ATT-01, 02, 04'],
    ['8', '자동 저장', '입력 멈춘 뒤 1초에 저장, "저장 중…" → "√ 저장됨"', 'FR-EDT-03'],
    ['9', '파일 첨부', 'PDF·xlsx 등은 아이콘 칩으로 표시, 클릭 시 OS 기본 프로그램으로 열기. 없으면 토스트', 'FR-ATT-05'],
  ]);
  t(s, '한글 조합(IME) 중에는 자동완성·단축키 처리를 보류한다 (FR-EDT-05)', 8.45, 6.35, 4.38, 0.4, { size: 9.5, color: C.muted });
}

// =====================================================================
// 9. SCR-05 검색·필터
// =====================================================================
{
  const s = pres.addSlide();
  header(s, '검색·필터', '한글 부분 일치 전문 검색과 임의 속성 필터', 'SCR-05 · M');
  const X = 0.5, Y = 1.45, W = 3.7, H = 5.25;
  box(s, X, Y, W, H, { fill: C.side, line: C.border, r: 0.04 });
  input(s, X + 0.15, Y + 0.15, W - 0.3, '◎  무개', { focus: true });
  t(s, '필터', X + 0.15, Y + 0.55, 0.6, 0.28, { size: 9, bold: true, color: C.muted });
  t(s, '＋ 조건', X + W - 0.9, Y + 0.55, 0.75, 0.28, { size: 9, color: C.green, align: 'right' });
  ['status = 검토   ×', 'type = idea   ×', '수정일 최근 7일   ×'].forEach((c, i) => chip(s, X + 0.15, Y + 0.9 + i * 0.3, 1.8, c));
  t(s, '결과 12개 · 38ms', X + 0.15, Y + 1.85, 2, 0.26, { size: 8.5, color: C.muted });
  line(s, X, Y + 2.15, X + W, Y + 2.15, { color: C.border, width: 0.75 });
  const res = [['업무개선 아이디어', '…반복 보고를 줄이는 업', '무개', '선 방안…', '20 아이디어 · 10-27'], ['자동화 도구 조사', '…업', '무개', '선 효과가 큰 영역은…', '30 조사자료 · 10-25'], ['회의록 1027', '…공정 업', '무개', '편 일정 확인…', '30 조사자료 · 10-27']];
  res.forEach(([title, a, hit, b, meta], i) => {
    const yy = Y + 2.25 + i * 0.92;
    box(s, X + 0.1, yy, W - 0.2, 0.84, { fill: i === 0 ? C.bg : C.side, line: i === 0 ? C.border : C.side, r: 0.04 });
    t(s, title, X + 0.22, yy + 0.05, W - 0.4, 0.26, { size: 10, bold: true });
    s.addText([{ text: a }, { text: hit, options: { highlight: 'FFE58F', bold: true } }, { text: b }], { x: X + 0.22, y: yy + 0.32, w: W - 0.4, h: 0.24, fontFace: F, fontSize: 8.5, color: C.text, margin: 0 });
    t(s, meta, X + 0.22, yy + 0.56, W - 0.4, 0.22, { size: 8, color: C.muted });
  });
  // filter builder popover
  const px = 4.55, py = 1.45;
  popup(s, px, py, 3.55, 2.65, '조건 추가');
  t(s, '속성', px + 0.15, py + 0.55, 0.8, 0.28, { size: 9, color: C.muted });
  input(s, px + 0.95, py + 0.55, 2.45, 'status ▾');
  t(s, '연산자', px + 0.15, py + 0.95, 0.8, 0.28, { size: 9, color: C.muted });
  input(s, px + 0.95, py + 0.95, 2.45, '= ▾   (=, ≠, 포함, 비어 있음)');
  t(s, '값', px + 0.15, py + 1.35, 0.8, 0.28, { size: 9, color: C.muted });
  input(s, px + 0.95, py + 1.35, 2.45, '검토 ▾   (기존 값 제안)');
  btn(s, px + 1.45, py + 2.15, 0.9, '취소', false);
  btn(s, px + 2.45, py + 2.15, 0.95, '추가', true);
  // syntax card
  box(s, px, 4.35, 3.55, 2.35, { fill: 'FFFFFF', line: C.border, r: 0.06 });
  t(s, '검색창에서 바로 쓰는 문법', px + 0.15, 4.45, 3.3, 0.3, { size: 10, bold: true, color: C.dark });
  [['#자동화', '태그'], ['status:검토', '속성 값'], ['"정확한 구"', '구 일치'], ['modified:7d', '최근 7일 수정']].forEach(([k, v], i) => {
    const yy = 4.85 + i * 0.42;
    box(s, px + 0.15, yy, 1.6, 0.32, { fill: C.side, line: C.border, r: 0.04 });
    t(s, k, px + 0.15, yy, 1.6, 0.32, { size: 9, font: MONO, align: 'center' });
    t(s, v, px + 1.9, yy, 1.5, 0.32, { size: 9.5 });
  });
  mk(s, 1, X + W - 0.05, Y + 0.3); mk(s, 2, X + 2.1, Y + 1.05); mk(s, 3, X + 2.2, Y + 1.98); mk(s, 4, X + W - 0.05, Y + 2.35); mk(s, 5, px + 3.5, py + 0.1);
  spec(s, [
    ['1', '검색창', '입력 후 200ms 뒤 검색. 한글 부분 일치(무개 → 업무개선)', 'FR-SRC-02'],
    ['2', '조건 칩', '여러 조건을 AND로 결합, ×로 제거', 'FR-SRC-03~04'],
    ['3', '결과 요약', '결과 수와 응답 시간 표시', 'NFR-PRF-02'],
    ['4', '결과 항목', '제목, 일치 문맥(노란 강조), 폴더·수정일. 클릭 시 해당 위치로', 'FR-SRC-05'],
    ['5', '조건 추가', '속성 → 연산자 → 값. 속성 목록은 인덱스의 모든 key, 값은 기존 값 제안', 'FR-SRC-04'],
  ]);
  t(s, '결과가 없으면 "결과 없음 · 조건을 줄여 보세요"를 표시한다.', 8.45, 5.2, 4.38, 0.5, { size: 10, color: C.muted });
}

// =====================================================================
// 10. SCR-06 아이디어 보드
// =====================================================================
{
  const s = pres.addSlide();
  header(s, '아이디어 보드', '기록 관리 프리셋이 켜져 있을 때만 활동 막대에 나타난다', 'SCR-06 · M');
  const X = 0.5, Y = 1.45, W = 3.7, H = 5.25;
  box(s, X, Y, W, H, { fill: C.side, line: C.border, r: 0.04 });
  t(s, '◆ 아이디어', X + 0.15, Y + 0.1, 1.6, 0.35, { size: 11, bold: true });
  btn(s, X + W - 1.25, Y + 0.12, 1.1, '＋ 빠른 메모', true);
  chip(s, X + 0.15, Y + 0.55, 1.35, '정렬: 수정일 ▾', { fill: C.bg, line: C.border, color: C.text });
  chip(s, X + 1.6, Y + 0.55, 1.35, '태그: 전체 ▾', { fill: C.bg, line: C.border, color: C.text });
  const groups = [['▾ 아이디어', '5', [['회의록 자동 요약', '10-28'], ['주간보고 템플릿화', '10-26']]], ['▾ 검토', '3', [['업무개선 아이디어', '10-27']]], ['▸ 진행', '2', []], ['▸ 완료', '8', []], ['▸ 보류', '1', []], ['▸ Inbox 미분류', '3', []]];
  let yy = Y + 0.95;
  groups.forEach(([g, n, items], gi) => {
    t(s, g, X + 0.15, yy, 2.2, 0.3, { size: 10, bold: true, color: gi === 5 ? C.accent : C.text });
    t(s, n, X + W - 0.55, yy, 0.4, 0.3, { size: 9, color: C.muted, align: 'right' });
    yy += 0.32;
    items.forEach(([name, d], ii) => {
      const drag = gi === 0 && ii === 1;
      box(s, X + 0.25, yy, W - 0.4, 0.34, { fill: C.bg, line: drag ? C.green : C.border, r: 0.04, dash: drag ? 'dash' : 'solid' });
      t(s, name, X + 0.38, yy, 2.2, 0.34, { size: 9.5 });
      t(s, d, X + W - 0.75, yy, 0.55, 0.34, { size: 8.5, color: C.muted, align: 'right' });
      yy += 0.4;
    });
    yy += 0.06;
  });
  // drag ghost
  box(s, X + W + 0.35, Y + 1.85, 2.1, 0.36, { fill: C.tint, line: C.green, r: 0.04 });
  t(s, '주간보고 템플릿화', X + W + 0.45, Y + 1.85, 1.9, 0.36, { size: 9.5, bold: true, color: C.green });
  line(s, X + W + 0.02, Y + 1.84, X + W + 0.33, Y + 2.03, { arrow: true, color: C.green, dash: 'dash' });
  t(s, '검토 그룹으로 끌어 놓는 중', X + W + 0.35, Y + 1.5, 2.6, 0.3, { size: 8.5, color: C.green });
  // frontmatter result card
  box(s, 4.8, 4.2, 3.3, 2.5, { fill: 'FFFFFF', line: C.border, r: 0.06 });
  t(s, '상태를 바꾸면 frontmatter가 바로 바뀐다', 4.95, 4.3, 3.1, 0.3, { size: 10, bold: true, color: C.dark });
  box(s, 4.95, 4.7, 3.0, 1.8, { fill: '1F2A1F', line: '1F2A1F', r: 0.05 });
  s.addText([
    { text: '---', options: { breakLine: true } },
    { text: 'type: idea', options: { breakLine: true } },
    { text: 'status: ', options: {} }, { text: '검토', options: { color: 'E9B949', bold: true, breakLine: true } },
    { text: 'tags: [보고, 자동화]', options: { breakLine: true } },
    { text: '---', options: {} },
  ], { x: 5.1, y: 4.8, w: 2.8, h: 1.6, fontFace: MONO, fontSize: 10, color: 'E6ECE5', margin: 0, valign: 'top' });
  mk(s, 1, X + 0.1, Y + 0.97); mk(s, 2, X + 2.0, Y + 1.47); mk(s, 3, X + W + 0.35, Y + 1.85); mk(s, 4, X + 0.1, Y + 4.25); mk(s, 5, X + W - 0.05, Y + 0.12);
  spec(s, [
    ['1', '상태 그룹', '프리셋의 status 값 순서대로 묶고 개수 표시. 그룹 접기·펴기', 'FR-PRS-05~06'],
    ['2', '아이디어 항목', '제목·수정일. 클릭하면 편집기에서 연다', 'FR-PRS-06'],
    ['3', '상태 변경', '다른 그룹으로 끌어 놓거나 우클릭 → 상태 변경. frontmatter 즉시 반영', 'FR-PRP-02'],
    ['4', 'Inbox 미분류', '00 Inbox 중 status가 없는 메모. 상태를 주면 해당 그룹으로', 'FR-PRS-04'],
    ['5', '빠른 메모', 'SCR-13 팝업 열기', 'FR-PRS-04'],
  ]);
  t(s, '상태 값과 순서는 설정 > 프리셋에서 바꿀 수 있다. v0.2에서 칸반형 보기 검토.', 8.45, 5.2, 4.38, 0.6, { size: 10, color: C.muted, valign: 'top' });
}

// =====================================================================
// 11. SCR-07 백링크 + SCR-08 속성
// =====================================================================
{
  const s = pres.addSlide();
  header(s, '백링크 · 속성 패널', '오른쪽 패널의 두 탭 — 연결을 보고, 노트 속성을 편집한다', 'SCR-07·08 · M');
  // backlinks
  const X = 0.5, Y = 1.45, W = 3.6, H = 5.25;
  box(s, X, Y, W, H, { fill: C.side, line: C.border, r: 0.04 });
  t(s, '백링크 (3)', X + 0.15, Y + 0.1, 2, 0.35, { size: 11, bold: true });
  const bl = [['2026-10-28 업무일지', ['- [ ] ', '[[화면 설계서]]', ' 검토']], ['회의록 1027', ['결정: ', '[[화면 설계서]]', '는 PPT로']], ['요구사항 메모', ['UI 기준은 ', '[[화면 설계서]]', ' 참고']]];
  bl.forEach(([n, [a, l, b]], i) => {
    const yy = Y + 0.55 + i * 0.95;
    box(s, X + 0.12, yy, W - 0.24, 0.82, { fill: C.bg, line: C.border, r: 0.05 });
    t(s, n, X + 0.25, yy + 0.07, W - 0.5, 0.3, { size: 10, bold: true, color: C.green });
    s.addText([{ text: a }, { text: l, options: { color: C.green, bold: true } }, { text: b }], { x: X + 0.25, y: yy + 0.42, w: W - 0.5, h: 0.3, fontFace: F, fontSize: 9, color: C.text, margin: 0 });
  });
  line(s, X + 0.12, Y + 3.5, X + W - 0.12, Y + 3.5, { color: C.border, width: 0.75 });
  t(s, '연결되지 않은 언급 (v0.2)', X + 0.15, Y + 3.6, 3, 0.3, { size: 9.5, color: C.muted });
  t(s, '링크가 없을 때:\n"이 노트를 가리키는 링크가 없습니다"', X + 0.15, Y + 4.2, W - 0.3, 0.6, { size: 9, color: C.muted, italic: true });

  // properties
  const PX = 4.4, PW = 3.7;
  box(s, PX, Y, PW, H, { fill: C.side, line: C.border, r: 0.04 });
  t(s, '속성', PX + 0.15, Y + 0.1, 2, 0.35, { size: 11, bold: true });
  const props = [['type', 'idea ▾'], ['status', '검토 ▾'], ['tags', null], ['source', 'https://example.com/…  ↗'], ['created', '2026-10-27  (날짜 선택)']];
  props.forEach(([k, v], i) => {
    const yy = Y + 0.6 + i * 0.5;
    t(s, k, PX + 0.15, yy, 0.8, 0.32, { size: 9.5, color: C.muted, font: MONO });
    if (v) input(s, PX + 1.0, yy, PW - 1.15, v);
    else { chip(s, PX + 1.0, yy + 0.04, 0.95, '업무개선 ×'); chip(s, PX + 2.0, yy + 0.04, 0.85, '자동화 ×'); t(s, '＋', PX + 2.95, yy, 0.3, 0.32, { size: 11, color: C.green }); }
  });
  // value suggestions dropdown under status
  popup(s, PX + 1.0, Y + 1.43, 2.55, 1.5);
  ['아이디어', '검토  √', '진행', '완료', '보류'].forEach((v, i) => {
    const yy = Y + 1.48 + i * 0.28;
    if (i === 1) box(s, PX + 1.05, yy, 2.45, 0.27, { fill: C.tint, line: C.tint, r: 0.03 });
    t(s, v, PX + 1.15, yy, 2.2, 0.27, { size: 9, bold: i === 1 });
  });
  t(s, '＋ 속성 추가', PX + 0.15, Y + 3.25, 2, 0.32, { size: 10, color: C.green, bold: true });
  box(s, PX + 0.12, Y + 3.8, PW - 0.24, 0.75, { fill: C.redbg, line: 'F3C1BB', r: 0.05 });
  t(s, '! frontmatter 문법 오류 (3번째 줄)\n편집기에서 해당 줄을 강조합니다', PX + 0.25, Y + 3.82, PW - 0.45, 0.7, { size: 9, color: C.red });
  mk(s, 1, X + W - 0.05, Y + 0.6); mk(s, 2, X + 3.0, Y + 3.62); mk(s, 3, PX + PW - 0.05, Y + 0.75); mk(s, 4, PX + 3.6, Y + 1.5); mk(s, 5, PX + 1.85, Y + 3.41); mk(s, 6, PX + PW - 0.05, Y + 3.85);
  spec(s, [
    ['1', '백링크 목록', '이 노트를 가리키는 노트와 링크가 있는 문장. 클릭 시 그 위치로 이동, 1초 안에 갱신', 'FR-LNK-03'],
    ['2', '연결 안 된 언급', '링크 없이 이름만 쓴 곳 (v0.2)', 'FR-LNK-07'],
    ['3', '속성 행', '유형별 입력: 텍스트, 날짜 선택기, 목록 칩, URL(↗ 브라우저)', 'FR-PRP-02~03'],
    ['4', '값 제안', '같은 속성에 쓰인 기존 값을 드롭다운으로 제안', 'FR-PRP-02'],
    ['5', '속성 추가', '이름 입력(기존 이름 자동완성) → 유형 자동 추정', 'FR-PRP-02'],
    ['6', 'YAML 오류', '문법 오류 경고, 편집기에서 해당 줄 강조', 'FR-PRP-01'],
  ]);
  t(s, '패널에서 바꾼 값은 frontmatter에, YAML을 직접 고친 값은 패널에 바로 반영된다.', 8.45, 5.75, 4.38, 0.6, { size: 10, color: C.muted, valign: 'top' });
}

// =====================================================================
// 12. SCR-09 히스토리 + SCR-10 버전 보기·비교
// =====================================================================
{
  const s = pres.addSlide();
  header(s, '히스토리 · 버전 보기', '저장 시점별 버전을 보고, 비교하고, 복원한다', 'SCR-09·10 · M');
  const X = 0.5, Y = 1.45, W = 2.55, H = 5.25;
  box(s, X, Y, W, H, { fill: C.side, line: C.border, r: 0.04 });
  t(s, '히스토리 (24)', X + 0.15, Y + 0.1, 2, 0.35, { size: 11, bold: true });
  const items = [['오늘', null], ['14:32', '현재 버전', 'cur'], ['14:05', '+120 −8 단어', 'sel'], ['13:40', '외부 변경', 'ext'], ['09:12', '수동 저장', ''], ['어제', null], ['18:20', '+410 단어', ''], ['2026-10-25', null], ['11:03', '처음 생성', '']];
  let yy = Y + 0.55;
  items.forEach(([a, b, k]) => {
    if (b === null) { t(s, a, X + 0.15, yy, 2, 0.26, { size: 8.5, bold: true, color: C.muted }); yy += 0.3; return; }
    if (k === 'sel') box(s, X + 0.08, yy - 0.02, W - 0.16, 0.32, { fill: C.tint, line: C.tint, r: 0.03 });
    s.addShape(pres.shapes.OVAL, { x: X + 0.2, y: yy + 0.08, w: 0.12, h: 0.12, fill: { color: k === 'cur' ? C.green : C.bg }, line: { color: C.green, width: 1 } });
    t(s, a, X + 0.42, yy, 0.6, 0.28, { size: 9, bold: k === 'sel' });
    if (k === 'ext') chip(s, X + 1.05, yy + 0.02, 1.2, '외부 변경', { fill: 'FDEBD9', line: 'FDEBD9', color: 'A35A1F' });
    else t(s, b, X + 1.05, yy, 1.4, 0.28, { size: 8.5, color: C.muted });
    yy += 0.36;
  });
  t(s, '히스토리는 .app/history.db에 저장됩니다. 볼트와 함께 백업하세요.', X + 0.12, Y + H - 0.75, W - 0.24, 0.6, { size: 8, color: C.muted, italic: true });
  // version modal
  const MX = 3.3, MW = 4.8;
  popup(s, MX, Y, MW, H, '2026-10-28 업무일지 · 버전 기록');
  t(s, '×', MX + MW - 0.4, Y + 0.08, 0.3, 0.3, { size: 12, color: C.muted, align: 'center' });
  // mode toggle
  ['이 버전만', '현재와 비교', '이전과 비교'].forEach((m, i) => {
    const bx = MX + 0.15 + i * 1.12;
    box(s, bx, Y + 0.58, 1.06, 0.28, { fill: i === 1 ? C.green : C.bg, line: i === 1 ? C.green : C.border, r: 0.04 });
    t(s, m, bx, Y + 0.58, 1.06, 0.28, { size: 8.5, align: 'center', color: i === 1 ? 'FFFFFF' : C.text, bold: i === 1 });
  });
  // diff
  const dx = MX + 0.15, dy = Y + 1.05, dw = MW - 0.3;
  box(s, dx, dy, dw, 3.35, { fill: C.bg, line: C.border, r: 0.03 });
  const diff = [[' ', '## 한 일', ''], [' ', '- [x] 요구사항 정의서 작성', ''], ['+', '- [ ] [[화면 설계서]] 검토', 'add'], ['−', '- [ ] 화면 설계 시작', 'del'], [' ', '', ''], [' ', '## 회의', ''], ['+', '· 오후 2시 기획 회의 — 결정 사항은', 'add'], ['+', '  회의록 1027에 정리', 'add'], [' ', '· 다음 할 일: 1일 차 작업 목록', '']];
  diff.forEach(([sg, txt, k], i) => {
    const ry = dy + 0.08 + i * 0.35;
    if (k) box(s, dx + 0.04, ry, dw - 0.08, 0.32, { fill: k === 'add' ? C.greenbg : C.redbg, line: k === 'add' ? C.greenbg : C.redbg });
    t(s, sg, dx + 0.1, ry, 0.2, 0.32, { size: 10, bold: true, color: k === 'add' ? C.green : k === 'del' ? C.red : C.muted, align: 'center' });
    t(s, txt, dx + 0.35, ry, dw - 0.45, 0.32, { size: 9.5, color: k === 'del' ? C.red : C.text, strike: k === 'del' ? 'sngStrike' : undefined });
  });
  btn(s, MX + MW - 3.05, Y + H - 0.5, 1.1, '내용 복사', false);
  btn(s, MX + MW - 1.85, Y + H - 0.5, 1.7, '이 버전으로 복원', true);
  mk(s, 1, X + W - 0.05, Y + 0.6); mk(s, 2, X + W - 0.05, Y + 1.88); mk(s, 3, MX + 3.55, Y + 0.6); mk(s, 4, MX + MW - 0.05, Y + 2.0); mk(s, 5, MX + MW - 1.9, Y + H - 0.5);
  spec(s, [
    ['1', '버전 목록', '날짜별로 묶어 최신순. 변경량과 표식(수동 저장·외부 변경·복원·처음 생성)', 'FR-HIS-03~04'],
    ['2', '버전 선택', '클릭하면 오른쪽 버전 기록 창을 연다', 'FR-HIS-04'],
    ['3', '보기 모드', '이 버전만(읽기 전용) · 현재와 비교 · 이전 버전과 비교', 'FR-HIS-04, 06'],
    ['4', '줄 단위 비교', '추가는 녹색 +, 삭제는 빨강 − 와 취소선', 'FR-HIS-06 (S)'],
    ['5', '복원', '"현재 내용은 새 버전으로 저장된 뒤 복원됩니다" 확인 후 복원', 'FR-HIS-05'],
  ]);
  t(s, '비교 기능(FR-HIS-06)이 v0.2로 밀리면 보기 모드는 "이 버전만"만 남긴다. 삭제한 노트의 히스토리는 탐색기 우클릭·명령 팔레트에서 연다.', 8.45, 5.15, 4.38, 1.0, { size: 10, color: C.muted, valign: 'top' });
}

// =====================================================================
// 13. SCR-11 빠른 열기 · SCR-12 명령 팔레트 · SCR-13 빠른 메모
// =====================================================================
{
  const s = pres.addSlide();
  header(s, '빠른 열기 · 명령 팔레트 · 빠른 메모', '키보드로 부르는 세 팝업', 'SCR-11·12·13');
  // quick open
  const qx = 0.5, qy = 1.45, qw = 3.75;
  popup(s, qx, qy, qw, 2.3);
  input(s, qx + 0.15, qy + 0.15, qw - 0.3, '◎  화면', { focus: true });
  [['화면 설계서', 'docs', 1], ['화면 설계 회의록 1027', '30 조사자료', 0], ['＋ "화면" 새 노트 만들기', 'Shift+Enter', 0]].forEach(([n, p, sel], i) => {
    const yy = qy + 0.6 + i * 0.4;
    if (sel) box(s, qx + 0.1, yy, qw - 0.2, 0.36, { fill: C.tint, line: C.tint, r: 0.03 });
    t(s, n, qx + 0.22, yy, 2.2, 0.36, { size: 9.5, bold: !!sel, color: i === 2 ? C.green : C.text });
    t(s, p, qx + 2.4, yy, qw - 2.55, 0.36, { size: 8, color: C.muted, align: 'right' });
  });
  t(s, '↑↓ 이동 · Enter 열기 · Esc 닫기', qx + 0.2, qy + 1.88, qw - 0.4, 0.3, { size: 8, color: C.muted });
  t(s, 'SCR-11 빠른 열기  Ctrl+O', qx, qy - 0.02 + 2.35, qw, 0.3, { size: 9, bold: true, color: C.green });
  // palette
  const py = 4.3;
  popup(s, qx, py, qw, 2.15);
  input(s, qx + 0.15, py + 0.15, qw - 0.3, '>  업무', { focus: true });
  [['오늘 업무일지 열기', 'Ctrl+Shift+D', 1], ['업무일지 템플릿으로 새 노트', '', 0], ['이전 업무일지', '', 0]].forEach(([n, k, sel], i) => {
    const yy = py + 0.6 + i * 0.4;
    if (sel) box(s, qx + 0.1, yy, qw - 0.2, 0.36, { fill: C.tint, line: C.tint, r: 0.03 });
    t(s, n, qx + 0.22, yy, 2.4, 0.36, { size: 9.5, bold: !!sel });
    if (k) t(s, k, qx + 2.45, yy, qw - 2.6, 0.36, { size: 8, color: C.muted, align: 'right', font: MONO });
  });
  t(s, 'SCR-12 명령 팔레트  Ctrl+P', qx, py + 2.18, qw, 0.3, { size: 9, bold: true, color: C.green });
  // memo
  const mx = 4.5, my = 1.45, mw = 3.6, mh = 3.3;
  popup(s, mx, my, mw, mh, '◆ 빠른 메모 → 00 Inbox');
  box(s, mx + 0.15, my + 0.6, mw - 0.3, 1.95, { fill: C.bg, line: C.green, lw: 1.25, r: 0.04 });
  t(s, '회의록을 자동으로 요약해\n업무일지에 붙이기\n#자동화', mx + 0.28, my + 0.7, mw - 0.55, 1.0, { size: 10, valign: 'top' });
  t(s, 'Ctrl+Enter 저장 · Esc 취소', mx + 0.15, my + 2.72, 2, 0.3, { size: 8, color: C.muted });
  btn(s, mx + mw - 0.95, my + 2.72, 0.8, '저장', true);
  t(s, 'SCR-13 빠른 메모  Ctrl+Shift+N', mx, my + mh + 0.05, mw, 0.3, { size: 9, bold: true, color: C.green });
  // toast result
  box(s, mx, 5.3, mw, 0.55, { fill: C.dark, line: C.dark, r: 0.06 });
  t(s, 'Inbox에 저장됨', mx + 0.2, 5.3, 2, 0.55, { size: 10, color: 'FFFFFF' });
  t(s, '열기', mx + mw - 0.7, 5.3, 0.5, 0.55, { size: 10, bold: true, color: C.moss, align: 'right' });
  t(s, '저장 후 토스트', mx, 5.9, mw, 0.3, { size: 8.5, color: C.muted });
  mk(s, 1, qx + qw + 0.12, qy + 0.3); mk(s, 2, qx + qw + 0.12, qy + 1.58); mk(s, 3, qx + qw + 0.12, py + 0.3); mk(s, 4, mx + mw - 0.05, my + 0.75); mk(s, 5, mx + mw - 0.05, 5.35);
  spec(s, [
    ['1', '빠른 열기', '파일명 퍼지 검색(한글 부분 일치), 최근 연 노트 우선, Enter로 열기', 'FR-SRC-01'],
    ['2', '새 노트', 'Shift+Enter: 입력한 이름으로 새 노트 생성', 'FR-VLT-03'],
    ['3', '명령 팔레트', '> 표시. 명령 레지스트리의 모든 명령과 단축키 표시', 'FR-UI-04, FR-EXT-01'],
    ['4', '빠른 메모', '여러 줄 입력. 첫 줄이 제목, 비면 "메모 날짜 시각"', 'FR-PRS-04'],
    ['5', '저장 결과', '00 Inbox에 type: idea, status: 아이디어로 저장 후 토스트', 'FR-PRS-04~05'],
  ]);
  t(s, '프리셋이 꺼져 있으면 빠른 메모는 볼트 루트(또는 설정한 폴더)에 일반 노트로 저장한다.', 8.45, 5.2, 4.38, 0.6, { size: 10, color: C.muted, valign: 'top' });
}

// =====================================================================
// 14. SCR-14 템플릿 선택 · SCR-15 이름 변경 확인
// =====================================================================
{
  const s = pres.addSlide();
  header(s, '템플릿 선택 · 이름 변경 확인', '새 노트를 만들 때와, 링크가 걸린 노트 이름을 바꿀 때', 'SCR-14·15');
  const X = 0.5, Y = 1.45, W = 3.6, H = 4.75;
  popup(s, X, Y, W, H, '새 노트');
  const tpls = [['빈 노트', ''], ['업무일지', '10 업무일지'], ['회의록', '10 업무일지'], ['아이디어', '20 아이디어'], ['조사 자료', '30 조사자료'], ['(90 템플릿의 사용자 템플릿…)', '']];
  tpls.forEach(([n, f], i) => {
    const yy = Y + 0.55 + i * 0.36;
    if (i === 4) box(s, X + 0.1, yy, W - 0.2, 0.33, { fill: C.tint, line: C.tint, r: 0.03 });
    t(s, n, X + 0.25, yy, 2.2, 0.33, { size: 9.5, bold: i === 4, color: i === 5 ? C.muted : C.text, italic: i === 5 });
    if (f) t(s, f, X + 2.2, yy, W - 2.35, 0.33, { size: 8, color: C.muted, align: 'right' });
  });
  line(s, X, Y + 2.75, X + W, Y + 2.75, { color: C.border, width: 0.75 });
  t(s, '이름', X + 0.2, Y + 2.9, 0.6, 0.3, { size: 9, color: C.muted });
  input(s, X + 0.8, Y + 2.9, W - 1.0, '자동화 도구 조사', { focus: true });
  t(s, '위치', X + 0.2, Y + 3.32, 0.6, 0.3, { size: 9, color: C.muted });
  input(s, X + 0.8, Y + 3.32, W - 1.0, '30 조사자료 ▾');
  btn(s, X + W - 2.15, Y + H - 0.5, 0.9, '취소', false);
  btn(s, X + W - 1.15, Y + H - 0.5, 1.0, '만들기', true);
  // rename dialog
  const RX = 4.4, RW = 3.7, RH = 3.6;
  popup(s, RX, Y, RW, RH, '이름 변경: 화면 설계 → 화면 설계서');
  t(s, '이 노트를 가리키는 링크 5개(노트 3개)를\n함께 고칩니다.', RX + 0.2, Y + 0.55, RW - 0.4, 0.6, { size: 9.5, valign: 'top' });
  [['2026-10-28 업무일지', '2곳', true], ['회의록 1027', '2곳', true], ['요구사항 메모', '1곳', false]].forEach(([n, c, on], i) => {
    const yy = Y + 1.3 + i * 0.4;
    check(s, RX + 0.25, yy + 0.1, on);
    t(s, n, RX + 0.5, yy, 2.2, 0.34, { size: 9.5, color: on ? C.text : C.muted });
    t(s, c, RX + RW - 0.8, yy, 0.6, 0.34, { size: 9, color: C.muted, align: 'right' });
  });
  btn(s, RX + RW - 2.75, Y + RH - 0.5, 0.8, '취소', false);
  btn(s, RX + RW - 1.85, Y + RH - 0.5, 1.7, '링크도 바꾸고 변경', true);
  box(s, RX, Y + RH + 0.25, RW, 0.9, { fill: 'FDF3E7', line: 'F3D3AE', r: 0.05 });
  t(s, '링크 갱신(FR-LNK-05)이 v0.2로 밀리면: 이름만 바꾸고 "링크 N개는 직접 고쳐야 합니다"라고 경고', RX + 0.15, Y + RH + 0.3, RW - 0.3, 0.8, { size: 9, color: 'A35A1F' });
  mk(s, 1, X + W - 0.05, Y + 0.6); mk(s, 2, X + W - 0.05, Y + 3.4); mk(s, 3, RX + RW - 0.05, Y + 1.4); mk(s, 4, RX + RW - 0.05, Y + RH - 0.4);
  spec(s, [
    ['1', '템플릿 목록', '빈 노트 + 템플릿 폴더의 모든 노트', 'FR-PRP-04'],
    ['2', '이름·위치', '템플릿의 folder 값을 기본 위치로 제안. {{date}} {{time}} {{title}} 치환', 'FR-PRP-04, FR-PRS-02'],
    ['3', '바뀔 노트 목록', '링크가 있는 노트와 개수. 체크 해제한 노트는 바꾸지 않음', 'FR-LNK-05'],
    ['4', '실행', '이름 변경 + 링크 일괄 치환, 바뀐 노트마다 스냅샷 생성', 'FR-LNK-05, FR-HIS-01'],
  ]);
  t(s, '· Ctrl+Shift+D(오늘 업무일지)는 이 창 없이 바로 열거나 만든다 (FR-PRS-03)\n· 링크가 없는 노트는 확인 창 없이 바로 이름을 바꾼다', 8.45, 4.85, 4.38, 1.0, { size: 10, color: C.muted, valign: 'top' });
}

// =====================================================================
// 15. SCR-16 설정 · SCR-17 알림
// =====================================================================
{
  const s = pres.addSlide();
  header(s, '설정 · 알림', '설정은 탭으로 나누고, 알림은 오른쪽 아래 토스트로 보여 준다', 'SCR-16·17');
  const X = 0.5, Y = 1.45, W = 7.6, H = 3.45;
  popup(s, X, Y, W, H, '설정');
  t(s, '×', X + W - 0.4, Y + 0.08, 0.3, 0.3, { size: 12, color: C.muted, align: 'center' });
  box(s, X, Y + 0.45, 1.75, H - 0.45, { fill: C.side, line: C.border });
  ['일반', '편집기', '파일·링크', '프리셋', '히스토리', '단축키 (v0.2)', '정보'].forEach((n, i) => {
    const yy = Y + 0.55 + i * 0.38;
    if (i === 3) box(s, X + 0.08, yy, 1.6, 0.33, { fill: C.tint, line: C.tint, r: 0.04 });
    t(s, n, X + 0.2, yy, 1.45, 0.33, { size: 9.5, bold: i === 3, color: i === 5 ? C.muted : i === 3 ? C.green : C.text });
  });
  const cx = X + 2.0;
  t(s, '기록 관리 프리셋', cx, Y + 0.6, 2.5, 0.3, { size: 10.5, bold: true });
  box(s, X + W - 0.85, Y + 0.63, 0.55, 0.26, { fill: C.green, line: C.green, r: 0.13 });
  s.addShape(pres.shapes.OVAL, { x: X + W - 0.55, y: Y + 0.66, w: 0.2, h: 0.2, fill: { color: 'FFFFFF' }, line: { type: 'none' } });
  t(s, '아이디어 상태 값 (끌어서 순서 변경)', cx, Y + 1.05, 4, 0.28, { size: 9, color: C.muted });
  ['아이디어', '검토', '진행', '완료', '보류'].forEach((v, i) => chip(s, cx + i * 0.95, Y + 1.38, 0.88, '≡ ' + v, { fill: C.bg, line: C.border, color: C.text }));
  t(s, '＋', cx + 4.8, Y + 1.38, 0.3, 0.24, { size: 11, color: C.green });
  t(s, '업무일지 경로', cx, Y + 1.85, 1.3, 0.3, { size: 9, color: C.muted });
  input(s, cx + 1.35, Y + 1.85, 3.9, '10 업무일지/{{YYYY}}/{{YYYY-MM-DD}}.md');
  t(s, '템플릿 폴더', cx, Y + 2.27, 1.3, 0.3, { size: 9, color: C.muted });
  input(s, cx + 1.35, Y + 2.27, 3.9, '90 템플릿');
  t(s, '폴더 이름', cx, Y + 2.69, 1.3, 0.3, { size: 9, color: C.muted });
  input(s, cx + 1.35, Y + 2.69, 3.9, '00 Inbox · 10 업무일지 · 20 아이디어 · 30 조사자료');
  // toasts
  const toasts = [
    ['정보', 'Inbox에 저장됨', '열기', C.dark, 'FFFFFF'],
    ['충돌', '다른 프로그램이 동시에 고쳐서 내 변경을 별도 파일로 저장했습니다', '비교', 'FDF3E7', 'A35A1F'],
    ['복구', '검색 인덱스를 다시 만드는 중 (35%)', '', 'FFFFFF', C.text],
    ['오류', '저장하지 못했습니다: 읽기 전용 파일', '다시 시도', C.redbg, C.red],
  ];
  toasts.forEach(([k, msg, act, bg, fg], i) => {
    const tx = X + (i % 2) * 3.85, ty = 5.1 + Math.floor(i / 2) * 0.8;
    box(s, tx, ty, 3.75, 0.65, { fill: bg, line: bg === 'FFFFFF' ? C.border : bg, r: 0.06 });
    t(s, k, tx + 0.15, ty, 0.5, 0.65, { size: 9, bold: true, color: fg });
    t(s, msg, tx + 0.65, ty, act ? 2.25 : 2.95, 0.65, { size: 8.5, color: fg });
    if (act) t(s, act, tx + 2.95, ty, 0.7, 0.65, { size: 9, bold: true, color: fg === 'FFFFFF' ? C.moss : fg, align: 'right' });
  });
  mk(s, 1, X + 1.7, Y + 0.6); mk(s, 2, X + W - 0.05, Y + 0.75); mk(s, 3, cx + 4.95, Y + 1.25); mk(s, 4, X + 3.75, 5.1);
  spec(s, [
    ['1', '설정 탭', '일반(언어·테마·시작) · 편집기 · 파일·링크 · 프리셋 · 히스토리 · 정보', 'FR-UI-02~03'],
    ['2', '프리셋 켬/끔', '끄면 코어 기능만. 기존 노트·폴더는 그대로 둔다', 'FR-PRS-01'],
    ['3', '프리셋 설정', '상태 값·순서, 업무일지 경로 규칙, 템플릿·폴더 이름', 'FR-PRS-02, 05'],
    ['4', '알림 토스트', '오른쪽 아래 4초 표시. 충돌·오류는 닫을 때까지 유지. 첨부 파일 없음도 여기에 표시', 'NFR-REL-01~03, FR-ATT-05'],
  ]);
  t(s, '· 히스토리 탭: 스냅샷 묶음 간격(기본 5분), history.db 위치\n· 정보 탭: 버전, MIT 라이선스, GitHub, "인덱스 다시 만들기"\n· 충돌본 이름: "이름 (충돌 2026-10-28 1432).md"', 8.45, 4.75, 4.38, 1.5, { size: 10, color: C.muted, valign: 'top' });
}

// =====================================================================
// 16. 요구사항 대응 · 확인 필요 사항
// =====================================================================
{
  const s = pres.addSlide();
  header(s, '요구사항 대응 · 확인 필요 사항', 'v0.1 기능 요구사항(M·S)이 모두 화면에 대응한다');
  const rows = [
    ['볼트', 'FR-VLT-01~05', 'SCR-01, 02, 03'], ['편집기', 'FR-EDT-01~06', 'SCR-04'], ['링크', 'FR-LNK-01~06', 'SCR-04, 07, 15'],
    ['속성·템플릿', 'FR-PRP-01~04', 'SCR-04, 08, 14'], ['검색', 'FR-SRC-01~05', 'SCR-05, 11'], ['히스토리', 'FR-HIS-01~07', 'SCR-09, 10, 15'],
    ['프리셋', 'FR-PRS-01~07', 'SCR-01, 06, 08, 13, 14, 16'], ['첨부', 'FR-ATT-01·02·04·05', 'SCR-04, 17'], ['화면', 'FR-UI-01~04', 'SCR-02, 12, 16'], ['확장', 'FR-EXT-01', 'SCR-12'],
  ];
  const hdr = ['영역', '요구사항', '대응 화면'].map(v => ({ text: v, options: { bold: true, color: 'FFFFFF', fill: { color: C.dark } } }));
  const body = rows.map((r, i) => r.map((v, j) => ({ text: v, options: { fill: { color: i % 2 ? 'FFFFFF' : 'F1F6F0' }, bold: j === 0, color: j === 2 ? C.green : C.text } })));
  s.addTable([hdr, ...body], { x: 0.5, y: 1.45, w: 6.6, colW: [1.4, 2.3, 2.9], fontFace: F, fontSize: 11, rowH: 0.42, valign: 'middle', border: { type: 'solid', pt: 0.5, color: C.border }, margin: [0.02, 0.12, 0.02, 0.12] });

  box(s, 7.5, 1.45, 5.33, 4.75, { fill: 'FFFFFF', line: C.border, r: 0.08 });
  t(s, '정해 주실 것', 7.75, 1.6, 4.8, 0.45, { size: 16, bold: true, color: C.dark });
  const qs = ['강조색과 로고 (지금은 녹색 계열·임시 로고)', '단축키 조합 확정 (Ctrl+Shift+N 충돌 여부)', '링크 이동 기본값: 클릭 또는 Ctrl+클릭', '삭제 시 Windows 휴지통 사용', '아이디어 보드: 목록형 유지 또는 v0.2 칸반형'];
  qs.forEach((q, i) => {
    const yy = 2.2 + i * 0.75;
    s.addShape(pres.shapes.OVAL, { x: 7.75, y: yy + 0.04, w: 0.42, h: 0.42, fill: { color: C.tint }, line: { color: C.green, width: 1 } });
    t(s, String(i + 1), 7.75, yy + 0.04, 0.42, 0.42, { size: 12, bold: true, color: C.green, align: 'center' });
    t(s, q, 8.35, yy, 4.3, 0.5, { size: 12 });
  });
  note(s, '상세 동작은 docs/화면설계서.md, 요구사항 ID는 docs/요구사항정의서.md 기준', 6.55);
}

pres.writeFile({ fileName: out }).then(f => console.log('written', f));
