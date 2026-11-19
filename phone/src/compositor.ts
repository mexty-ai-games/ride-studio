import type { StudioState, TileState } from "../../shared/protocol";
import { audio } from "./audio";
import { link } from "./link";
import { fmtClock, useApp } from "./store";

const ENTITY: Record<string, string> = { course: "COURS", program: "PARCOURS", evaluation: "ÉVALUATION", block: "BLOC", scene: "BLOC 3D" };
const C = { bg: "#070D2B", surface: "#0F1A45", line: "#22306A", text: "#F4F6FF", muted: "#A9B3D9", navy: "#0B1640", violet: "#7B3FE4", pink: "#E8388F", pinkSoft: "#FF6FB5", accent: "#B9A4FF", voice: "#16225A" };
const GRAD: [number, string][] = [[0, "#2F5BFF"], [0.4, "#7B3FE4"], [0.75, "#E8388F"], [1, "#FF8A3D"]];
const DISPLAY = "'Bricolage Grotesque', system-ui, sans-serif";
const SANS = "Inter, system-ui, sans-serif";

interface Rect { x: number; y: number; w: number; h: number }
/** Where things go, per output format. Everything is drawn from these boxes, so 9:16 and 16:9 share one painter. */
interface Layout {
  W: number; H: number; pad: number;
  head: Rect; ring: { cx: number; cy: number; r: number }; previews: Rect; cam: Rect; voice: Rect; foot: Rect;
  title: number; body: number;
  tall: boolean;
}
const TALL: Layout = { W: 1080, H: 1920, pad: 40, head: { x: 40, y: 56, w: 780, h: 170 }, ring: { cx: 950, cy: 142, r: 78 }, previews: { x: 40, y: 262, w: 1000, h: 860 }, cam: { x: 40, y: 1158, w: 440, h: 560 }, voice: { x: 508, y: 1158, w: 532, h: 560 }, foot: { x: 40, y: 1750, w: 1000, h: 120 }, title: 62, body: 34, tall: true };
const WIDE: Layout = { W: 1280, H: 720, pad: 24, head: { x: 24, y: 20, w: 620, h: 84 }, ring: { cx: 1196, cy: 78, r: 54 }, previews: { x: 24, y: 116, w: 860, h: 540 }, cam: { x: 908, y: 150, w: 348, h: 290 }, voice: { x: 908, y: 454, w: 348, h: 202 }, foot: { x: 24, y: 668, w: 1232, h: 36 }, title: 34, body: 20, tall: false };

/** Showing a content to someone: the content (portrait, as on a phone) takes most of the picture. */
const TALL_SHOW: Layout = { ...TALL, previews: { x: 40, y: 250, w: 1000, h: 1180 }, cam: { x: 40, y: 1460, w: 330, h: 260 }, voice: { x: 396, y: 1460, w: 644, h: 260 } };
const WIDE_SHOW: Layout = { ...WIDE, head: { x: 24, y: 20, w: 280, h: 84 }, previews: { x: 320, y: 16, w: 560, h: 690 }, foot: { x: 24, y: 668, w: 280, h: 36 } };

const TILE_ASPECT = 960 / 600;

function rr(ctx: CanvasRenderingContext2D, r: Rect, radius: number) {
  ctx.beginPath();
  ctx.roundRect(r.x, r.y, r.w, r.h, radius);
}
function grad(ctx: CanvasRenderingContext2D, r: Rect) {
  const g = ctx.createLinearGradient(r.x, r.y, r.x + r.w, r.y + r.h * 0.6);
  for (const [o, c] of GRAD) g.addColorStop(o, c);
  return g;
}
function wrap(ctx: CanvasRenderingContext2D, text: string, maxW: number, maxLines: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    const t = cur ? `${cur} ${w}` : w;
    if (ctx.measureText(t).width <= maxW) cur = t;
    else {
      if (cur) lines.push(cur);
      cur = w;
    }
  }
  if (cur) lines.push(cur);
  if (lines.length > maxLines) {
    // Keep the end of long speech: the latest words are the ones being heard.
    const kept = lines.slice(-maxLines);
    kept[0] = "… " + kept[0];
    return kept;
  }
  return lines;
}
function fit(ctx: CanvasRenderingContext2D, text: string, maxW: number): string {
  if (ctx.measureText(text).width <= maxW) return text;
  let t = text;
  while (t.length > 3 && ctx.measureText(t + "…").width > maxW) t = t.slice(0, -1);
  return t + "…";
}

/** Tile rectangles for the current layout: one fills, two split, three or four put the freshest tile on top. */
export function tileRects(area: Rect, tiles: TileState[], layout: StudioState["layout"], focus: number | null, aspectOf: (slot: number) => number = () => TILE_ASPECT): Map<number, Rect> {
  const out = new Map<number, Rect>();
  const gap = Math.round(area.w * 0.02);
  const contain = (box: Rect, slot = -1): Rect => {
    const a = slot >= 0 ? aspectOf(slot) : TILE_ASPECT;
    const w = Math.min(box.w, box.h * a);
    const h = w / a;
    return { x: box.x + (box.w - w) / 2, y: box.y + (box.h - h) / 2, w, h };
  };
  const focused = focus != null ? tiles.find((t) => t.slot === focus) : undefined;
  let list = tiles;
  if (focused) list = [focused];
  else if (layout === "single" && tiles.length) list = [[...tiles].sort((a, b) => b.lastChangeTs - a.lastChangeTs)[0]];
  if (list.length === 0) return out;
  if (list.length === 1) {
    out.set(list[0].slot, contain(area, list[0].slot));
    return out;
  }
  const tall = area.h > area.w * 0.75;
  if (list.length === 2 || layout === "split") {
    const two = [...list].sort((a, b) => b.lastChangeTs - a.lastChangeTs).slice(0, 2).sort((a, b) => a.slot - b.slot);
    two.forEach((t, i) => out.set(t.slot, contain(tall ? { x: area.x, y: area.y + i * ((area.h + gap) / 2), w: area.w, h: (area.h - gap) / 2 } : { x: area.x + i * ((area.w + gap) / 2), y: area.y, w: (area.w - gap) / 2, h: area.h })));
    return out;
  }
  if (layout === "grid" && !tall) {
    list.forEach((t, i) => out.set(t.slot, contain({ x: area.x + (i % 2) * ((area.w + gap) / 2), y: area.y + Math.floor(i / 2) * ((area.h + gap) / 2), w: (area.w - gap) / 2, h: (area.h - gap) / 2 })));
    return out;
  }
  // Auto with 3–4 targets: the most recently changed tile is enlarged, the others line up beside or below it.
  const [big, ...rest] = [...list].sort((a, b) => b.lastChangeTs - a.lastChangeTs);
  rest.sort((a, b) => a.slot - b.slot);
  if (tall) {
    const smallH = (area.w - gap * (rest.length - 1)) / rest.length / TILE_ASPECT;
    out.set(big.slot, contain({ x: area.x, y: area.y, w: area.w, h: area.h - smallH - gap }));
    const bw = (area.w - gap * (rest.length - 1)) / rest.length;
    rest.forEach((t, i) => out.set(t.slot, { x: area.x + i * (bw + gap), y: area.y + area.h - smallH, w: bw, h: smallH }));
  } else {
    const sw = area.w * 0.26;
    out.set(big.slot, contain({ x: area.x, y: area.y, w: area.w - sw - gap, h: area.h }));
    const sh = sw / TILE_ASPECT;
    rest.forEach((t, i) => out.set(t.slot, { x: area.x + area.w - sw, y: area.y + i * (sh + gap), w: sw, h: sh }));
  }
  return out;
}

/**
 * Draws the video. The phone cannot screen-record itself, so the picture is composed here on a canvas —
 * preview frames, facecam, overlays — and the canvas is what gets recorded.
 */
export class Compositor {
  private frames = new Map<number, ImageBitmap>();
  private anim = new Map<number, Rect>(); // tile rectangles ease between layouts
  private bars: number[] = new Array(18).fill(0.1);
  private wideBars = 11;
  private raf = 0;
  private last = 0;
  cam: HTMLVideoElement | null = null;
  /** Selfie camera is mirrored; the rear camera is not. */
  mirror = true;
  private qr = new Map<string, HTMLImageElement>();
  targets: { canvas: HTMLCanvasElement; layout: Layout }[] = [];

  constructor() {
    link.handlers.frame = (slot, jpeg) => {
      // Decode off the main thread; the newest frame for a slot always wins.
      void createImageBitmap(jpeg).then((bmp) => {
        this.frames.get(slot)?.close();
        this.frames.set(slot, bmp);
      }).catch(() => {});
    };
  }

  static canvas(variant: "tall" | "wide"): { canvas: HTMLCanvasElement; layout: Layout } {
    const layout = variant === "tall" ? TALL : WIDE;
    const canvas = document.createElement("canvas");
    canvas.width = layout.W;
    canvas.height = layout.H;
    return { canvas, layout };
  }

  start() {
    cancelAnimationFrame(this.raf);
    const loop = (t: number) => {
      this.raf = requestAnimationFrame(loop);
      if (t - this.last < 1000 / 31) return; // 30 fps
      this.last = t;
      const app = useApp.getState();
      audio.levels(audio.speaking ? audio.ttsAnalyser : audio.micAnalyser, this.bars.length, this.bars);
      for (const { canvas, layout } of this.targets) this.draw(canvas.getContext("2d", { alpha: false })!, layout, app);
    };
    this.raf = requestAnimationFrame(loop);
  }
  stop() {
    cancelAnimationFrame(this.raf);
  }
  clearFrames() {
    for (const b of this.frames.values()) b.close();
    this.frames.clear();
    this.anim.clear();
  }

  private draw(ctx: CanvasRenderingContext2D, base: Layout, app: ReturnType<typeof useApp.getState>) {
    const s = app.studio;
    // On the road, showing a content is just the full-size screen; the portrait layout is for once arrived.
    const shown = s?.show.key && s.episode?.phase === "arrived" ? s.contents.find((c) => c.key === s.show.key) : undefined;
    const L = shown && shown.slot != null ? (base.tall ? TALL_SHOW : WIDE_SHOW) : base;
    const ep = s?.episode;
    const now = Date.now();
    const u = L.tall ? 1 : 0.62; // scale unit for radii, strokes and paddings

    // Backdrop
    ctx.fillStyle = C.bg;
    ctx.fillRect(0, 0, L.W, L.H);
    const glow = ctx.createRadialGradient(L.W * 0.85, L.H * 0.05, 0, L.W * 0.85, L.H * 0.05, L.W * 0.9);
    glow.addColorStop(0, "rgba(123,63,228,0.28)");
    glow.addColorStop(1, "rgba(123,63,228,0)");
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, L.W, L.H);

    // Header: where we are going and what will be delivered
    ctx.textBaseline = "top";
    ctx.textAlign = "left";
    ctx.fillStyle = C.accent;
    ctx.font = `700 ${Math.round(L.body * 0.62)}px ${SANS}`;
    const eyebrow = ep ? `TOP CHRONO · ÉPISODE ${ep.no}${ep.setup.destination ? ` · ${ep.setup.destination.toUpperCase()}` : ""}` : "RIDE STUDIO";
    ctx.fillText(fit(ctx, eyebrow, L.head.w), L.head.x, L.head.y);
    ctx.fillStyle = C.text;
    // Long company names shrink (down to 70 %) before they are cut.
    const company = ep?.setup.company || "Ride Studio";
    ctx.font = `800 ${L.title}px ${DISPLAY}`;
    const shrink = Math.max(0.7, Math.min(1, L.head.w / ctx.measureText(company).width));
    ctx.font = `800 ${Math.floor(L.title * shrink)}px ${DISPLAY}`;
    ctx.fillText(fit(ctx, company, L.head.w), L.head.x, L.head.y + L.body * 0.9 + (L.title * (1 - shrink)) / 2);
    ctx.fillStyle = C.muted;
    ctx.font = `500 ${Math.round(L.body * 0.8)}px ${SANS}`;
    if (ep?.setup.topic && L.tall) ctx.fillText(fit(ctx, `Formation : ${ep.setup.topic}`, L.head.w), L.head.x, L.head.y + L.body * 0.9 + L.title * 1.18);

    // Countdown ring
    const total = (ep?.setup.etaMin ?? 25) * 60;
    const arrived = ep?.phase === "arrived";
    const elapsed = ep ? ((ep.arrivedAt ?? ep.endedAt ?? now) - ep.startedAt) / 1000 : 0;
    const left = Math.max(0, total - elapsed);
    const { cx, cy, r } = L.ring;
    ctx.lineWidth = r * 0.17;
    ctx.strokeStyle = C.line;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = grad(ctx, { x: cx - r, y: cy - r, w: r * 2, h: r * 2 });
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * (arrived ? 1 : Math.max(0.001, left / total)));
    ctx.stroke();
    ctx.lineCap = "butt";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = C.text;
    ctx.font = `800 ${Math.round(r * 0.52)}px ${DISPLAY}`;
    ctx.fillText(fmtClock(arrived ? elapsed : ep ? (left > 0 ? left : elapsed - total) : total), cx, cy - r * 0.06);
    ctx.fillStyle = C.muted;
    ctx.font = `600 ${Math.round(r * 0.19)}px ${SANS}`;
    ctx.fillText(arrived ? "ARRIVÉS" : left > 0 || !ep ? "RESTANTES" : "DE RETARD", cx, cy + r * 0.38);
    ctx.textAlign = "left";
    ctx.textBaseline = "top";

    // Preview tiles
    const tiles = s?.tiles ?? [];
    const rects = tileRects(L.previews, tiles, s?.layout ?? "auto", shown?.slot ?? s?.focus ?? null, (slot) => {
      const b = this.frames.get(slot);
      return b ? b.width / b.height : TILE_ASPECT;
    });
    if (!tiles.length) {
      rr(ctx, L.previews, 28 * u);
      ctx.fillStyle = C.surface;
      ctx.fill();
      ctx.strokeStyle = C.line;
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.fillStyle = C.muted;
      ctx.textAlign = "center";
      ctx.font = `600 ${L.body}px ${SANS}`;
      ctx.fillText(ep ? "Claude prépare la formation…" : "Prêt à partir", L.previews.x + L.previews.w / 2, L.previews.y + L.previews.h / 2 - L.body / 2);
      ctx.textAlign = "left";
    }
    for (const t of tiles) {
      const target = rects.get(t.slot);
      if (!target) {
        this.anim.delete(L.W * 10 + t.slot);
        continue;
      }
      const key = L.W * 10 + t.slot;
      const cur = this.anim.get(key) ?? { ...target };
      // Ease towards the new rectangle so layout changes glide instead of jumping.
      for (const k of ["x", "y", "w", "h"] as const) cur[k] += (target[k] - cur[k]) * 0.22;
      this.anim.set(key, cur);
      this.tile(ctx, cur, t, u, now, app);
    }

    if (shown && s?.show.qr && shown.url) this.drawQr(ctx, L, shown.url, rects.get(shown.slot ?? -1));

    // Facecam
    rr(ctx, L.cam, 30 * u);
    ctx.save();
    ctx.clip();
    ctx.fillStyle = C.voice;
    ctx.fillRect(L.cam.x, L.cam.y, L.cam.w, L.cam.h);
    const v = this.cam;
    if (v && v.readyState >= 2 && v.videoWidth) {
      const scale = Math.max(L.cam.w / v.videoWidth, L.cam.h / v.videoHeight);
      const dw = v.videoWidth * scale, dh = v.videoHeight * scale;
      ctx.translate(L.cam.x + L.cam.w / 2, L.cam.y + L.cam.h / 2);
      if (this.mirror) ctx.scale(-1, 1); // mirror, like a selfie
      ctx.drawImage(v, -dw / 2, -dh / 2, dw, dh);
    }
    ctx.restore();
    rr(ctx, L.cam, 30 * u);
    ctx.lineWidth = 5 * u;
    ctx.strokeStyle = C.violet;
    ctx.stroke();

    // Voice panel: waveform, who is speaking, Claude's last line and the rider's
    rr(ctx, L.voice, 26 * u);
    ctx.fillStyle = C.voice;
    ctx.fill();
    const vp = 24 * u;
    const speaking = audio.speaking || !!s?.speaking;
    const barW = 6 * u, barGap = 5 * u, barMax = 44 * u;
    const nBars = L.tall ? this.bars.length : this.wideBars;
    for (let i = 0; i < nBars; i++) {
      const h = Math.max(6 * u, this.bars[i] * barMax);
      ctx.fillStyle = speaking ? C.pinkSoft : C.accent;
      ctx.beginPath();
      ctx.roundRect(L.voice.x + vp + i * (barW + barGap), L.voice.y + vp + (barMax - h) / 2, barW, h, barW / 2);
      ctx.fill();
    }
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    ctx.fillStyle = speaking ? "#FF9BCB" : C.muted;
    ctx.font = `700 ${Math.round(L.body * 0.58)}px ${SANS}`;
    ctx.fillText(speaking ? "CLAUDE PARLE" : app.partial ? "FABIEN PARLE" : "CLAUDE ÉCOUTE", L.voice.x + L.voice.w - vp, L.voice.y + vp + barMax / 2);
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    const innerW = L.voice.w - vp * 2;
    const bottom = L.voice.y + L.voice.h - vp;
    let y = L.voice.y + vp + barMax + 14 * u;
    // The rider's words sit at the bottom; Claude's line takes whatever height is left above them.
    const mine = app.partial || app.userLine;
    const mineFs = Math.round(L.body * 0.82);
    ctx.font = `500 ${mineFs}px ${SANS}`;
    const mineLines = mine ? wrap(ctx, `Fabien : ${mine}`, innerW, L.tall ? 3 : 1) : [];
    const mineH = mineLines.length * mineFs * 1.25;
    ctx.fillStyle = "rgba(244,246,255,0.72)";
    mineLines.forEach((line, i) => ctx.fillText(line, L.voice.x + vp, bottom - mineH + i * mineFs * 1.25));
    ctx.fillStyle = C.text;
    ctx.font = `600 ${L.body}px ${SANS}`;
    const room = Math.max(1, Math.floor((bottom - mineH - (mineH ? 10 * u : 0) - y) / (L.body * 1.3)));
    for (const line of wrap(ctx, app.claudeLine ? `« ${app.claudeLine} »` : "", innerW, room)) {
      ctx.fillText(line, L.voice.x + vp, y);
      y += L.body * 1.3;
    }

    // Footer: progress chips and the brand
    this.footer(ctx, L, s, u);
  }

  /** The QR code of the content shown, on a white card beside it (or over its corner when there is no room). */
  private drawQr(ctx: CanvasRenderingContext2D, L: Layout, url: string, content?: Rect) {
    let img = this.qr.get(url);
    if (!img) {
      img = new Image();
      img.src = `/api/qr.svg?u=${encodeURIComponent(url)}`;
      this.qr.set(url, img);
    }
    if (!img.complete || !img.naturalWidth) return;
    const size = L.tall ? 300 : 170;
    const pad = L.tall ? 18 : 10;
    const fs = L.tall ? 26 : 15;
    const area = L.previews;
    const right = content ? area.x + area.w - (content.x + content.w) : 0;
    const x = right >= size + pad * 2 ? area.x + area.w - size - pad * 2 : (content ? content.x + content.w : area.x + area.w) - size - pad * 3;
    const y = (content ? content.y + content.h : area.y + area.h) - size - pad * 2 - fs * 1.6;
    rr(ctx, { x, y, w: size + pad * 2, h: size + pad * 2 + fs * 1.6 }, 18);
    ctx.fillStyle = "#FFFFFF";
    ctx.shadowColor = "rgba(0,0,0,0.35)";
    ctx.shadowBlur = 24;
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.drawImage(img, x + pad, y + pad, size, size);
    ctx.fillStyle = C.navy;
    ctx.font = `700 ${fs}px ${SANS}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("Scannez pour tester", x + pad + size / 2, y + pad + size + fs * 0.9);
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
  }

  private tile(ctx: CanvasRenderingContext2D, r: Rect, t: TileState, u: number, now: number, app: ReturnType<typeof useApp.getState>) {
    const radius = Math.min(26 * u, r.w * 0.05);
    const change = [...app.changes].reverse().find((c) => c.slot === t.slot);
    const age = change ? now - change.at : Infinity;
    const hot = age < 2000;
    ctx.save();
    rr(ctx, r, radius);
    ctx.clip();
    ctx.fillStyle = "#FFFFFF";
    ctx.fillRect(r.x, r.y, r.w, r.h);
    const bmp = this.frames.get(t.slot);
    if (bmp) ctx.drawImage(bmp, r.x, r.y, r.w, r.h);
    else {
      ctx.fillStyle = "#535C80";
      ctx.font = `600 ${Math.round(r.w * 0.035)}px ${SANS}`;
      ctx.textAlign = "center";
      ctx.fillText("Ouverture de l'aperçu…", r.x + r.w / 2, r.y + r.h / 2);
      ctx.textAlign = "left";
    }
    ctx.restore();
    // Latest change: pink outline for two seconds
    rr(ctx, r, radius);
    ctx.lineWidth = hot ? 6 * u : 2;
    ctx.strokeStyle = hot ? C.pink : C.line;
    if (hot) {
      ctx.shadowColor = "rgba(232,56,143,0.7)";
      ctx.shadowBlur = 26 * u * (1 - age / 2000);
    }
    ctx.stroke();
    ctx.shadowBlur = 0;

    // Label: which Claude, which kind of content
    const fs = Math.max(13, Math.round(Math.min(22 * u, r.w * 0.034)));
    ctx.font = `700 ${fs}px ${SANS}`;
    const label = `ÉCRAN ${t.slot + 1} · ${ENTITY[t.entity] ?? ""}`;
    const lw = ctx.measureText(label).width + fs * 2.2;
    const lr = { x: r.x + fs * 0.7, y: r.y + r.h - fs * 2.5, w: lw, h: fs * 1.9 };
    rr(ctx, lr, lr.h / 2);
    ctx.fillStyle = "rgba(11,22,64,0.92)";
    ctx.fill();
    ctx.fillStyle = C.pinkSoft;
    ctx.beginPath();
    ctx.arc(lr.x + fs * 0.8, lr.y + lr.h / 2, fs * 0.28, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#FFFFFF";
    ctx.textBaseline = "middle";
    ctx.fillText(label, lr.x + fs * 1.4, lr.y + lr.h / 2 + 1);
    // Current step, next to the label when there is room
    if (t.step && r.w > 420 * u) {
      ctx.font = `600 ${fs}px ${SANS}`;
      const step = fit(ctx, t.step, r.w - lw - fs * 3.6);
      const sw = ctx.measureText(step).width + fs * 1.4;
      const sr = { x: lr.x + lw + fs * 0.5, y: lr.y, w: sw, h: lr.h };
      rr(ctx, sr, sr.h / 2);
      ctx.fillStyle = "rgba(255,255,255,0.94)";
      ctx.fill();
      ctx.fillStyle = C.navy;
      ctx.fillText(step, sr.x + fs * 0.7, sr.y + sr.h / 2 + 1);
    }
    // "+ ajouté" chip
    if (hot && change) {
      const word = change.event.op === "create" ? "+ ajouté" : change.event.op === "delete" ? "supprimé" : "modifié";
      ctx.font = `800 ${fs}px ${SANS}`;
      const cw = ctx.measureText(word).width + fs * 1.6;
      const pop = Math.min(1, age / 180);
      const cr = { x: r.x + r.w - cw - fs * 0.7, y: r.y + fs * 0.7 - (1 - pop) * fs, w: cw, h: fs * 1.9 };
      ctx.globalAlpha = age > 1700 ? (2000 - age) / 300 : pop;
      rr(ctx, cr, cr.h / 2);
      ctx.fillStyle = C.pink;
      ctx.fill();
      ctx.fillStyle = "#FFFFFF";
      ctx.fillText(word, cr.x + fs * 0.8, cr.y + cr.h / 2 + 1);
      ctx.globalAlpha = 1;
    }
    ctx.textBaseline = "top";
  }

  private footer(ctx: CanvasRenderingContext2D, L: Layout, s: StudioState | null, u: number) {
    const f = L.foot;
    const fs = Math.round(L.body * 0.66);
    ctx.font = `700 ${fs}px ${SANS}`;
    ctx.textBaseline = "middle";
    let x = f.x;
    const h = fs * 2.1;
    const y = L.tall ? f.y : f.y + (f.h - h) / 2;
    const st = s?.episode?.stats;
    const chips: [string, boolean][] = [];
    for (const w of s?.workers ?? []) chips.push([`${w.status === "done" ? "✓ " : ""}Claude ${w.no}${w.changes ? ` · ${w.changes}` : ""}`, w.status === "running"]);
    if (st?.slides) chips.push([`${st.slides} écran${st.slides > 1 ? "s" : ""}`, false]);
    if (st?.questions) chips.push([`${st.questions} question${st.questions > 1 ? "s" : ""}`, false]);
    if (st?.nodes) chips.push([`${st.nodes} étape${st.nodes > 1 ? "s" : ""}`, false]);
    if (st?.objects) chips.push([`${st.objects} objet${st.objects > 1 ? "s" : ""} 3D`, false]);
    const brand = "mexty.ai";
    ctx.font = `800 ${Math.round(fs * 1.5)}px ${DISPLAY}`;
    const bw = ctx.measureText(brand).width;
    ctx.font = `700 ${fs}px ${SANS}`;
    for (const [text, active] of chips) {
      const w = ctx.measureText(text).width + fs * 1.7;
      if (x + w > f.x + f.w - (L.tall ? 0 : bw + 30)) break;
      const r = { x, y, w, h };
      rr(ctx, r, h / 2);
      ctx.fillStyle = active ? grad(ctx, r) : "#E8EEFF";
      ctx.fill();
      ctx.fillStyle = active ? "#FFFFFF" : "#1F45D6";
      ctx.fillText(text, x + fs * 0.85, y + h / 2 + 1);
      x += w + fs * 0.5;
    }
    ctx.font = `800 ${Math.round(fs * 1.5)}px ${DISPLAY}`;
    ctx.textAlign = "right";
    const by = L.tall ? f.y + f.h - fs * 1.1 : f.y + f.h / 2 + 1;
    ctx.fillStyle = grad(ctx, { x: f.x + f.w - bw, y: by - fs, w: bw, h: fs * 2 });
    ctx.fillText(brand, f.x + f.w, by);
    if (L.tall) {
      ctx.textAlign = "left";
      ctx.fillStyle = C.muted;
      ctx.font = `500 ${fs}px ${SANS}`;
      ctx.fillText("Formation construite en direct par Claude sur Mexty", f.x, by);
    }
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    void u;
  }
}
