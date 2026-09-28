import { useEffect, useState } from "react";

/** The greeting types itself out once per session; later visits show it whole, with the cursor still blinking. */
let greeted = false;

function prefersReducedMotion(): boolean {
  try { return window.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch { return false; }
}

export function Greeting({ lines, speed = 75 }: { lines: string[]; speed?: number }) {
  const split = lines.map(line => [...line]);
  const total = split.reduce((sum, characters) => sum + characters.length, 0);
  const [typed, setTyped] = useState(() => greeted || prefersReducedMotion() ? total : 0);
  useEffect(() => {
    if (typed >= total) { greeted = true; return; }
    const timer = setTimeout(() => setTyped(count => count + 1), speed);
    return () => clearTimeout(timer);
  }, [typed, total, speed]);

  let start = 0;
  return <h1 className="greeting" aria-label={lines.join("，")}>
    {split.map((characters, index) => {
      const shown = Math.min(characters.length, Math.max(0, typed - start));
      // The cursor sits on the line being typed, and at the end of the last line once typing is done.
      const cursor = typed >= total ? index === split.length - 1 : typed >= start && typed < start + characters.length;
      start += characters.length;
      return <span key={index} className="greeting-line" aria-hidden>
        {characters.slice(0, shown).join("")}
        {cursor && <span className="greeting-cursor" />}
        {/* The untyped rest keeps its space so the line never reflows while typing. */}
        <span className="greeting-rest">{characters.slice(shown).join("")}</span>
      </span>;
    })}
  </h1>;
}
