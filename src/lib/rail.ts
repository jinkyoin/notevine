// 노트 폴더 막대 (FR-VLT-07): 화면과 상관없는 규칙만 둔다.

/** Same folder path, ignoring case and slash direction (as the backend compares them). */
export function samePath(a: string, b: string): boolean {
  return norm(a) === norm(b);
}

export const norm = (p: string) => p.replace(/\//g, "\\").toLowerCase();

/** The button's letter: the name's first character (an emoji counts as one), Latin upper-cased. */
export function railLetter(name: string): string {
  const first = Array.from(name.trim())[0];
  return first ? first.toUpperCase() : "?";
}

/** Folders to try after closing `closing`: the ones below it first, then the ones above, nearest first. */
export function nextAfterClose(paths: string[], closing: string): string[] {
  const i = paths.findIndex((p) => samePath(p, closing));
  if (i < 0) return paths;
  return [...paths.slice(i + 1), ...paths.slice(0, i).reverse()];
}
