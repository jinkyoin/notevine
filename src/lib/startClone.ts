/** 명령 팔레트가 시작 화면에 "Git 저장소에서 받기" 창을 바로 열어 달라고 부탁하는 한 번짜리 표시. */
let wanted = false;

export function requestStartClone(): void {
  wanted = true;
}

export function takeStartClone(): boolean {
  const w = wanted;
  wanted = false;
  return w;
}
