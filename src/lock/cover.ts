// 잠긴 동안 앱 화면을 보이지 않게 하고 입력을 받지 않게 한다. React를 기다리지 않고 바로 바꾼다 (NFR-SEC-04).

let covered = false;
let focused: HTMLElement | null = null;

export function setCovered(on: boolean) {
  if (on === covered) return;
  covered = on;
  if (on) {
    const active = document.activeElement;
    focused = active instanceof HTMLElement && active !== document.body ? active : null;
    // Ends a Korean composition: its text lands in the note before the save.
    focused?.blur();
  }
  // CSS hides everything beside the lock screen, also what is added to <body> later.
  document.body.classList.toggle("nv-locked", on);
  document.getElementById("root")?.toggleAttribute("inert", on);
  if (!on) {
    if (focused?.isConnected) focused.focus();
    focused = null;
  }
}
