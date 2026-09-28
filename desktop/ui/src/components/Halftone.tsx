import { useEffect, useRef } from "react";
import "./Halftone.css";

const smooth = (edge0: number, edge1: number, value: number) => {
  const t = Math.min(1, Math.max(0, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
};

/** Distance measure of an ellipse rotated by `angle`: below 1 inside, 1 on its edge. */
function ellipse(x: number, y: number, cx: number, cy: number, rx: number, ry: number, angle: number): number {
  const dx = x - cx;
  const dy = y - cy;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return ((dx * cos + dy * sin) / rx) ** 2 + ((dy * cos - dx * sin) / ry) ** 2;
}

/**
 * Ink density of a butterfly centred on the origin, in units of its half height: swept forewings with eyespots,
 * rounder scalloped hindwings, dense margins over lighter veined fill, a body and two antennae. 0 is paper, 1 a full dot.
 */
function butterfly(u: number, v: number): number {
  const x = Math.abs(u);
  const angle = Math.atan2(v - 0.02, x);
  const wings: Array<[number, Array<[number, number, number]>]> = [
    [ellipse(x, v, 0.52, -0.26, 0.56, 0.3, -0.5), [[0.78, -0.52, 0.07], [0.62, -0.36, 0.05]]],
    [ellipse(x, v, 0.36, 0.3, 0.36, 0.3, 0.55) * (1 - 0.06 * Math.cos(angle * 16)), [[0.46, 0.42, 0.06]]],
  ];
  let density = 0;
  for (const [wing, spots] of wings) {
    if (wing >= 1) continue;
    const fill = smooth(0, 0.5, 1 - wing);
    const margin = smooth(0.62, 0.86, wing) * (1 - smooth(0.97, 1, wing));
    const vein = 0.5 + 0.5 * Math.cos(angle * 11);
    let value = fill * (0.22 + 0.26 * vein) + margin * 0.72;
    for (const [sx, sy, radius] of spots) value = Math.max(value, (1 - smooth(radius * 0.6, radius, Math.hypot(x - sx, v - sy))) * 0.95);
    density = Math.max(density, value);
  }
  const body = (1 - smooth(0.018, 0.04, x)) * (1 - smooth(0.3, 0.42, Math.abs(v - 0.02)));
  const antenna = v < -0.3 && v > -0.78 ? 1 - smooth(0.006, 0.02, Math.abs(x + (v + 0.3) * 0.42)) : 0;
  return Math.min(1, Math.max(density * smooth(0.03, 0.09, x), body * 0.9, antenna * 0.8));
}

/**
 * A halftone butterfly drawn as dots on a canvas: generated rather than shipped as an image, so it stays crisp at
 * every scale. Purely decorative; the dot colour comes from the canvas's CSS `color`.
 */
export function Halftone({ className, pitch = 4.5 }: { className?: string; pitch?: number }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    let frame = 0;
    const draw = () => {
      const { width, height } = element.getBoundingClientRect();
      const context = element.getContext("2d");
      if (!context || width < 1 || height < 1) return;
      const ratio = window.devicePixelRatio || 1;
      element.width = Math.round(width * ratio);
      element.height = Math.round(height * ratio);
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.clearRect(0, 0, width, height);
      context.fillStyle = getComputedStyle(element).color;
      // The figure spans about 1.6 half-heights top to bottom and 2.2 across.
      const scale = Math.min(height / 1.62, width / 2.4);
      for (let y = pitch / 2; y < height; y += pitch) {
        // Alternate rows are offset by half a pitch, as in print halftone screens.
        const offset = (Math.round(y / pitch) % 2) * (pitch / 2);
        for (let x = pitch / 2 + offset; x < width; x += pitch) {
          const density = butterfly((x - width / 2) / scale, (y - height / 2) / scale);
          if (density < 0.04) continue;
          context.beginPath();
          context.arc(x, y, (pitch / 2) * 0.92 * Math.sqrt(density), 0, Math.PI * 2);
          context.fill();
        }
      }
    };
    draw();
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(draw);
    });
    observer.observe(element);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [pitch]);
  return <canvas ref={canvas} className={["halftone", className].filter(Boolean).join(" ")} aria-hidden />;
}
