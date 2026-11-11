/** 복구 코드 입력칸용: 공백·`-`는 버리고 대문자로 바꿔 6자마다 `-`를 넣는다. */
export function formatRecoveryInput(s: string): string {
  const clean = s.replace(/[\s-]+/g, "").toUpperCase();
  return clean.match(/.{1,6}/g)?.join("-") ?? "";
}
