/* The explainer video's slides: each one is drawn on a 1280 × 720 canvas and
   saved as a PNG. The local server's ffmpeg then shows each PNG for as long
   as its voice runs (server/explainer.mjs).

   layoutSlide() is pure (it gets a function that measures text), so the
   wrapping and the sizes are tested without a browser. drawSlide() and
   slideToPng() need a real canvas. */

import type { ExplainerSlide } from "../types";

export const SLIDE = { width: 1280, height: 720, margin: 96 } as const;
const FONT = '"Quicksand Variable", "Nunito", system-ui, -apple-system, "Segoe UI", sans-serif';
const COLORS = { bg: "#faf7f5", ink: "#1f1b24", dim: "#5b5563", accent: "#6923ff", soft: "#ece6ff" } as const;

/* The width of `text` in pixels at `px`, bold or not. */
export type Measure = (text: string, px: number, bold: boolean) => number;

export interface SlideLayout {
  title: { lines: string[]; px: number; lineHeight: number; y: number };
  bullets: { lines: string[]; y: number }[];
  bulletPx: number;
  bulletLineHeight: number;
  /* Where the bullet text starts (the dot sits left of it). */
  textX: number;
}

/* `text` broken into lines no wider than `maxWidth`. A single word that is
   too wide gets its own line (it is never dropped). */
export function wrapLines(text: string, maxWidth: number, measure: (t: string) => number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const next = line ? `${line} ${word}` : word;
    if (line && measure(next) > maxWidth) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/* Where every line of a slide goes. The text gets smaller, step by step,
   until the slide fits its height. */
export function layoutSlide(slide: ExplainerSlide, measure: Measure): SlideLayout {
  const width = SLIDE.width - 2 * SLIDE.margin;
  const top = 112;
  const bottom = SLIDE.height - 88;
  const indent = 40;
  let layout: SlideLayout | null = null;
  for (const scale of [1, 0.9, 0.8, 0.7, 0.6, 0.5]) {
    const titlePx = Math.round(60 * scale);
    const bulletPx = Math.round(36 * scale);
    const titleLh = Math.round(titlePx * 1.15);
    const bulletLh = Math.round(bulletPx * 1.35);
    const gap = Math.round(bulletPx * 0.7);
    const titleLines = wrapLines(slide.title, width, (t) => measure(t, titlePx, true));
    let y = top + titleLines.length * titleLh + Math.round(44 * scale);
    const bullets = slide.bullets.map((b) => {
      const lines = wrapLines(b, width - indent, (t) => measure(t, bulletPx, false));
      const at = y;
      y += lines.length * bulletLh + gap;
      return { lines, y: at };
    });
    layout = {
      title: { lines: titleLines, px: titlePx, lineHeight: titleLh, y: top },
      bullets,
      bulletPx,
      bulletLineHeight: bulletLh,
      textX: SLIDE.margin + indent,
    };
    if (y - gap <= bottom) break;
  }
  return layout!;
}

function font(px: number, bold: boolean): string {
  return `${bold ? 700 : 500} ${px}px ${FONT}`;
}

/* Draw one slide. `index` counts from 0. */
export function drawSlide(ctx: CanvasRenderingContext2D, slide: ExplainerSlide, index: number, total: number): void {
  const measure: Measure = (text, px, bold) => {
    ctx.font = font(px, bold);
    return ctx.measureText(text).width;
  };
  const layout = layoutSlide(slide, measure);

  ctx.fillStyle = COLORS.bg;
  ctx.fillRect(0, 0, SLIDE.width, SLIDE.height);
  ctx.fillStyle = COLORS.accent;
  ctx.fillRect(SLIDE.margin, 72, 72, 8);

  ctx.textBaseline = "top";
  ctx.fillStyle = COLORS.ink;
  ctx.font = font(layout.title.px, true);
  layout.title.lines.forEach((line, i) => ctx.fillText(line, SLIDE.margin, layout.title.y + i * layout.title.lineHeight));

  for (const bullet of layout.bullets) {
    ctx.fillStyle = COLORS.accent;
    ctx.beginPath();
    ctx.arc(SLIDE.margin + 10, bullet.y + layout.bulletPx * 0.55, Math.max(4, layout.bulletPx * 0.16), 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = COLORS.dim;
    ctx.font = font(layout.bulletPx, false);
    bullet.lines.forEach((line, i) => ctx.fillText(line, layout.textX, bullet.y + i * layout.bulletLineHeight));
  }

  // The footer: a progress line and "3 / 7".
  const barY = SLIDE.height - 56;
  const barW = SLIDE.width - 2 * SLIDE.margin - 96;
  ctx.fillStyle = COLORS.soft;
  ctx.fillRect(SLIDE.margin, barY, barW, 6);
  ctx.fillStyle = COLORS.accent;
  ctx.fillRect(SLIDE.margin, barY, Math.round((barW * (index + 1)) / total), 6);
  ctx.fillStyle = COLORS.dim;
  ctx.font = font(22, false);
  ctx.textAlign = "right";
  ctx.fillText(`${index + 1} / ${total}`, SLIDE.width - SLIDE.margin, barY - 10);
  ctx.textAlign = "left";
}

/* One slide as a PNG file (browser only). */
export async function slideToPng(slide: ExplainerSlide, index: number, total: number): Promise<Blob> {
  const canvas = document.createElement("canvas");
  canvas.width = SLIDE.width;
  canvas.height = SLIDE.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("This window cannot draw the slides (no canvas).");
  // The app's fonts are loaded by CSS; wait for them so the text is not drawn in a fallback.
  try {
    await document.fonts?.ready;
  } catch {
    /* draw with what is there */
  }
  drawSlide(ctx, slide, index, total);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("This window could not save a slide as a picture.");
  return blob;
}
