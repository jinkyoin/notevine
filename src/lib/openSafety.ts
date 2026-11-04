// 노트 링크는 표시 이름을 쓴 사람이 정하므로("회의록 보기" → 회의록.bat), 다른 사람에게서 받은
// 폴더의 링크를 누르면 프로그램이 실행될 수 있다. 문서·그림·소리처럼 흔한 파일만 바로 열고,
// 나머지는 전체 파일 이름을 보여 주고 묻는다. 빠진 형식이 있어도 한 번 더 물을 뿐이라 허용 목록으로 둔다.
const OPENS_FREELY = /\.(xlsx?|docx?|pptx?|hwpx?|csv|txt|rtf|png|jpe?g|gif|webp|bmp|mp3|wav|m4a|mp4|mov|webm|zip)$/i;

/** Whether the OS may open this file without asking the user first. */
export function opensWithoutAsking(path: string): boolean {
  return OPENS_FREELY.test(path);
}
