// 주간·월간 회고 묶음 (FR-PRS-08): 기간 안의 업무일지·회의록·프로젝트·아이디어·자료를 링크 목록으로 모은 노트. AI 없이 만든다.
import type { VaultConfig } from "../api";
import { day, type TableRow } from "./folderTable";
import { BY_NAME, noteDate } from "./folderViews";

export type ReviewKind = "week" | "month";

export interface Period {
  from: string;
  to: string;
  /** "2026-W45" or "2026-11" */
  label: string;
}

const ymd = (d: Date) => day(d.getTime());

/** Monday–Sunday week (ISO week number) or calendar month around `d`. */
export function period(kind: ReviewKind, d: Date): Period {
  if (kind === "month") {
    const from = new Date(d.getFullYear(), d.getMonth(), 1);
    const to = new Date(d.getFullYear(), d.getMonth() + 1, 0);
    return { from: ymd(from), to: ymd(to), label: ymd(from).slice(0, 7) };
  }
  const mon = new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7));
  const sun = new Date(mon.getFullYear(), mon.getMonth(), mon.getDate() + 6);
  const thu = new Date(Date.UTC(mon.getFullYear(), mon.getMonth(), mon.getDate() + 3));
  const week = Math.ceil(((thu.getTime() - Date.UTC(thu.getUTCFullYear(), 0, 1)) / 86400000 + 1) / 7);
  return { from: ymd(mon), to: ymd(sun), label: `${thu.getUTCFullYear()}-W${String(week).padStart(2, "0")}` };
}

/** Folder review notes go to: under the Areas folder with the preset, else a top-level folder. */
export function reviewFolder(config: VaultConfig): string {
  return config.preset_enabled ? `${config.area_folder}/회고` : "회고";
}

export function reviewName(kind: ReviewKind, p: Period): string {
  return `${p.label} ${kind === "week" ? "주간" : "월간"} 회고`;
}

/** The note's own date: `created`/`date` property, else a date in its name, else when it was last changed. */
function created(r: TableRow): string {
  return noteDate(r, "created") ?? noteDate(r, "date") ?? noteDate(r, BY_NAME) ?? day(r.mtime);
}

/** Builds the review note's text from all notes (`rows`) with their properties. */
export function buildReview(kind: ReviewKind, p: Period, rows: TableRow[], config: VaultConfig, today: string): string {
  const inside = (d: string | null) => !!d && d >= p.from && d <= p.to;
  const under = (r: TableRow, folder: string) => !!folder && r.path.startsWith(folder + "/");
  const type = (r: TableRow) => r.props.type?.trim().toLowerCase() ?? "";
  const notes = rows.filter((r) => !under(r, config.template_folder) && !under(r, reviewFolder(config)) && type(r) !== "review");

  // [[이름]] when the name is unique, otherwise the path, so each link opens the right note.
  const count = new Map<string, number>();
  for (const r of rows) {
    const name = r.path.slice(r.path.lastIndexOf("/") + 1).replace(/\.md$/i, "").toLowerCase();
    count.set(name, (count.get(name) ?? 0) + 1);
  }
  const link = (r: TableRow) => {
    const name = r.path.slice(r.path.lastIndexOf("/") + 1).replace(/\.md$/i, "");
    return `[[${(count.get(name.toLowerCase()) ?? 0) > 1 ? r.path.replace(/\.md$/i, "") : name}]]`;
  };

  const used = new Set<string>();
  const pick = (test: (r: TableRow) => boolean) =>
    notes
      .filter((r) => !used.has(r.path) && test(r))
      .sort((a, b) => created(a).localeCompare(created(b)) || a.title.localeCompare(b.title, "ko"))
      .map((r) => (used.add(r.path), r));

  const journals = pick((r) => (under(r, config.journal_folder) || type(r) === "journal") && inside(created(r)));
  const meetings = pick((r) => type(r) === "meeting" && inside(created(r)));
  const done = pick((r) => type(r) === "project" && r.props.status === "완료" && inside(day(r.mtime)));
  const active = pick((r) => type(r) === "project" && r.props.status === "진행" && !under(r, config.archive_folder));
  const ideas = pick((r) => type(r) === "idea" && inside(created(r)));
  const research = pick((r) => type(r) === "research" && inside(created(r)));
  const other = pick((r) => inside(day(r.mtime)));

  const OTHER_MAX = 30;
  const section = (title: string, list: TableRow[], line: (r: TableRow) => string = link, max = Infinity) =>
    list.length
      ? [
          `## ${title} (${list.length})`,
          "",
          ...list.slice(0, max).map((r) => `- ${line(r)}`),
          ...(list.length > max ? [`- …그 밖에 ${list.length - max}개`] : []),
          "",
        ]
      : [];
  const short = (d: string) => d.slice(5).replace("-", "/");
  const [y, n] = p.label.split(/-W?/);
  const title = kind === "week" ? `${y}년 ${Number(n)}주차 주간 회고` : `${y}년 ${Number(n)}월 월간 회고`;

  return [
    "---",
    "type: review",
    `period: ${p.from} ~ ${p.to}`,
    `created: ${today}`,
    "---",
    "",
    `# ${title} (${short(p.from)} ~ ${short(p.to)})`,
    "",
    ...section("업무일지", journals),
    ...section("회의록", meetings),
    ...section("완료한 프로젝트", done),
    ...section("진행 중인 프로젝트", active, (r) => link(r) + (r.props.deadline ? ` · 마감 ${r.props.deadline}` : "")),
    ...section("새 아이디어", ideas, (r) => link(r) + (r.props.status ? ` · ${r.props.status}` : "")),
    ...section("새 자료", research),
    ...section("그 밖에 고친 노트", other, link, OTHER_MAX),
    ...(journals.length + meetings.length + done.length + ideas.length + research.length + other.length
      ? []
      : ["이 기간에 쓰거나 고친 노트가 없습니다.", ""]),
    "## 돌아보기",
    "",
    "- 잘된 점: ",
    "- 아쉬운 점: ",
    `- ${kind === "week" ? "다음 주" : "다음 달"}에 할 일: `,
    "",
  ].join("\n");
}
