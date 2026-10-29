// 읽기 모드의 수식(KaTeX)과 Mermaid 다이어그램 그리기 (FR-EDT-08).
// 두 라이브러리는 크므로 그런 블록이 있는 노트를 열 때만 불러온다. 둘 다 네트워크를 쓰지 않는다.
// 원문은 정화된 HTML의 data-tex 속성과 data-mermaid 블록의 <code> 글자에 있고, 그리지 못하면 원문을 그대로 둔다.

let mermaidSeq = 0;

function isDark(): boolean {
  const t = document.documentElement.dataset.theme;
  if (t === "dark") return true;
  if (t === "light") return false;
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
}

async function drawMath(els: HTMLElement[], live: () => boolean) {
  const [{ default: katex }] = await Promise.all([import("katex"), import("katex/dist/katex.min.css")]);
  if (!live()) return;
  for (const el of els) {
    const display = el.classList.contains("math-block");
    // trust: false keeps \href, \includegraphics and friends from making links or loading files.
    katex.render(decodeURIComponent(el.dataset.tex!), el, { displayMode: display, throwOnError: false, trust: false, output: "htmlAndMathml" });
  }
}

async function drawMermaid(els: HTMLElement[], live: () => boolean) {
  const { default: mermaid } = await import("mermaid");
  if (!live()) return;
  // "strict" sanitizes labels and turns off click handlers and scripts in diagrams.
  mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: isDark() ? "dark" : "default" });
  for (const el of els) {
    try {
      const source = el.querySelector("code")?.textContent ?? "";
      const { svg } = await mermaid.render(`nv-mermaid-${++mermaidSeq}`, source);
      if (!live()) return;
      el.innerHTML = svg;
      // Mermaid sizes the diagram with an inline max-width that our color-only style rule
      // (shared DOMPurify hook) strips, so put its natural width back from the viewBox.
      const drawn = el.querySelector("svg");
      const width = drawn?.viewBox.baseVal?.width;
      if (drawn && width) drawn.style.maxWidth = `${Math.ceil(width)}px`;
      el.classList.add("drawn");
    } catch (e) {
      if (!live()) return;
      const msg = document.createElement("p");
      msg.className = "mermaid-error";
      msg.textContent = `다이어그램을 그리지 못했습니다: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`;
      el.append(msg);
    }
  }
}

/** Draws the formulas and diagrams under `root`. `live()` turns false once the view changed. */
export async function drawRichBlocks(root: HTMLElement, live: () => boolean): Promise<void> {
  const math = [...root.querySelectorAll<HTMLElement>("[data-tex]")];
  const diagrams = [...root.querySelectorAll<HTMLElement>("[data-mermaid]")];
  await Promise.all([
    math.length ? drawMath(math, live).catch(() => {}) : null,
    diagrams.length ? drawMermaid(diagrams, live).catch(() => {}) : null,
  ]);
}
