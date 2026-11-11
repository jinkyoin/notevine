/** 저장소 주소 끝(`…/notes.git`)에서 받을 폴더 이름을 제안한다. */
export function suggestFolderName(url: string): string {
  const seg = url.trim().replace(/[\\/]+$/, "").split(/[/\\:]/).pop() ?? "";
  return seg.replace(/\.git$/i, "");
}
