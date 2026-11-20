import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statfsSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import express, { type Router } from "express";
import { requireAuth } from "./auth.js";
import { config } from "./config.js";
import { store } from "./store.js";

/**
 * Episode videos on the volume. The phone records locally first (IndexedDB), then sends the chunks here in
 * order once the ride is over; a recording is `<episodeId>/<variant>[-pN].<ext>` plus a small `.json` cursor.
 */
const root = join(config.dataDir, "recordings");
mkdirSync(root, { recursive: true });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const REC = /^(tall|wide)(-p[1-9][0-9]?)?$/;
const MIN_FREE_BYTES = 300 * 1024 * 1024;

interface Cursor {
  nextSeq: number;
  bytes: number;
  mime: string;
  complete: boolean;
  updatedAt: number;
}
const ext = (mime: string) => (mime.includes("mp4") ? "mp4" : "webm");
const cursorFile = (ep: string, rec: string) => join(root, ep, `${rec}.json`);
function readCursor(ep: string, rec: string): Cursor | null {
  try {
    return JSON.parse(readFileSync(cursorFile(ep, rec), "utf8")) as Cursor;
  } catch {
    return null;
  }
}

export function diskUsage() {
  try {
    const s = statfsSync(root);
    return { freeBytes: s.bavail * s.bsize, totalBytes: s.blocks * s.bsize };
  } catch {
    return { freeBytes: 0, totalBytes: 0 };
  }
}

export interface StoredVideo {
  rec: string;
  variant: "tall" | "wide";
  part: number;
  file: string;
  bytes: number;
  complete: boolean;
  url: string;
}
export function videosOf(episodeId: string): StoredVideo[] {
  const dir = join(root, episodeId);
  if (!UUID.test(episodeId) || !existsSync(dir)) return [];
  const out: StoredVideo[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    const rec = f.slice(0, -5);
    const c = readCursor(episodeId, rec);
    if (!c || !REC.test(rec) || c.bytes === 0) continue;
    const file = `${rec}.${ext(c.mime)}`;
    out.push({ rec, variant: rec.startsWith("tall") ? "tall" : "wide", part: Number(/-p(\d+)$/.exec(rec)?.[1] ?? 1), file, bytes: c.bytes, complete: c.complete, url: `/api/recordings/${episodeId}/${file}` });
  }
  return out.sort((a, b) => a.variant.localeCompare(b.variant) || a.part - b.part);
}
export function deleteVideos(episodeId: string) {
  if (UUID.test(episodeId)) rmSync(join(root, episodeId), { recursive: true, force: true });
}

export function recordingsRouter(isKnownEpisode: (id: string) => boolean): Router {
  const r = express.Router();
  r.use(requireAuth);

  /** Where an upload stands, so the phone resumes at the right chunk after a dropped connection. */
  r.get("/:episodeId/:rec/status", (req, res) => {
    const { episodeId, rec } = req.params;
    if (!UUID.test(episodeId) || !REC.test(rec)) return void res.status(400).json({ error: "bad id" });
    const c = readCursor(episodeId, rec);
    res.json({ nextSeq: c?.nextSeq ?? 0, complete: c?.complete ?? false, bytes: c?.bytes ?? 0 });
  });

  /** Append chunk `seq`. Chunks must arrive in order; a repeated chunk is acknowledged and ignored. */
  r.put("/:episodeId/:rec/chunk/:seq", express.raw({ type: "*/*", limit: "24mb" }), (req, res) => {
    const { episodeId, rec } = req.params;
    const seq = Number(req.params.seq);
    const body = req.body as Buffer;
    if (!UUID.test(episodeId) || !REC.test(rec) || !Number.isInteger(seq) || seq < 0 || !Buffer.isBuffer(body) || !body.length) return void res.status(400).json({ error: "bad request" });
    if (!isKnownEpisode(episodeId)) return void res.status(404).json({ error: "Épisode inconnu" });
    const mime = String(req.query.mime || "video/webm").slice(0, 80);
    const c = readCursor(episodeId, rec) ?? { nextSeq: 0, bytes: 0, mime, complete: false, updatedAt: 0 };
    if (c.complete || seq < c.nextSeq) return void res.json({ nextSeq: c.nextSeq, complete: c.complete });
    if (seq > c.nextSeq) return void res.status(409).json({ error: "out of order", nextSeq: c.nextSeq });
    if (diskUsage().freeBytes - body.length < MIN_FREE_BYTES) return void res.status(507).json({ error: "Le volume du serveur est plein : supprime d'anciens épisodes." });
    mkdirSync(join(root, episodeId), { recursive: true });
    appendFileSync(join(root, episodeId, `${rec}.${ext(c.mime)}`), body);
    c.nextSeq = seq + 1;
    c.bytes += body.length;
    c.updatedAt = Date.now();
    writeFileSync(cursorFile(episodeId, rec), JSON.stringify(c));
    res.json({ nextSeq: c.nextSeq, complete: false });
  });

  r.post("/:episodeId/:rec/complete", (req, res) => {
    const { episodeId, rec } = req.params;
    if (!UUID.test(episodeId) || !REC.test(rec)) return void res.status(400).json({ error: "bad id" });
    const c = readCursor(episodeId, rec);
    if (!c) return void res.status(404).json({ error: "nothing uploaded" });
    c.complete = true;
    writeFileSync(cursorFile(episodeId, rec), JSON.stringify(c));
    res.json({ ok: true, bytes: c.bytes });
  });

  /** A frame of the session (the 16:9 picture), for the card on fabien.ninja. */
  r.put("/:episodeId/thumb", express.raw({ type: "image/jpeg", limit: "3mb" }), (req, res) => {
    const { episodeId } = req.params;
    const body = req.body as Buffer;
    if (!UUID.test(episodeId) || !Buffer.isBuffer(body) || body.length < 100 || body[0] !== 0xff || body[1] !== 0xd8) return void res.status(400).json({ error: "bad image" });
    if (!isKnownEpisode(episodeId)) return void res.status(404).json({ error: "Épisode inconnu" });
    mkdirSync(join(root, episodeId), { recursive: true });
    writeFileSync(join(root, episodeId, "thumb.jpg"), body);
    res.json({ ok: true });
  });

  /** Play or download. `sendFile` handles Range requests, so seeking works. */
  r.get("/:episodeId/:file", (req, res) => {
    const { episodeId, file } = req.params;
    const m = /^((?:tall|wide)(?:-p[1-9][0-9]?)?)\.(mp4|webm)$/.exec(file);
    const path = join(root, episodeId, file);
    if (!UUID.test(episodeId) || !m || !existsSync(path)) return void res.status(404).end();
    const ep = store.episodes.find((e) => e.id === episodeId);
    if (req.query.dl) res.setHeader("Content-Disposition", `attachment; filename="ride-studio-ep${ep?.no ?? ""}-${m[1].replace("tall", "9x16").replace("wide", "16x9")}.${m[2]}"`);
    res.setHeader("Cache-Control", "private, max-age=3600");
    res.sendFile(path, { headers: { "Content-Type": m[2] === "mp4" ? "video/mp4" : "video/webm" }, lastModified: true });
  });

  return r;
}

const sessionView = (e: (typeof store.episodes)[number], base: string) => {
  const videos = videosOf(e.id).filter((v) => v.complete);
  const thumb = existsSync(join(root, e.id, "thumb.jpg"));
  return {
    no: e.no,
    title: e.topic || e.company || `Session ${e.no}`,
    company: e.company,
    destination: e.destination ?? "",
    topic: e.topic,
    startedAt: e.startedAt,
    endedAt: e.endedAt,
    durationSec: Math.round((e.endedAt - e.startedAt) / 1000),
    stats: e.stats,
    beats: (e.beats ?? []).map((b) => ({ label: b.label, atSec: Math.round((b.ts - e.startedAt) / 1000) })),
    // A public Mexty link opens without an account; the plain link needs Fabien's workspace.
    delivered: e.delivered.map((d) => ({ kind: d.entity, title: d.title, url: d.publicUrl ?? null })),
    videos: videos.map((v) => ({ variant: v.variant, part: v.part, url: `${base}/api/public/sessions/${e.no}/${v.file}` })),
    thumb: thumb ? `${base}/api/public/sessions/${e.no}/thumb.jpg` : null,
  };
};

/**
 * What fabien.ninja shows (Ride Studio Sessions): every finished, published episode, its videos served from this
 * volume, the trainings it delivered (public Mexty links) and its transcript. No key: everything here is public.
 */
export function publicSessionsRouter(): Router {
  const r = express.Router();
  const base = () => config.publicUrl.replace(/\/$/, "");
  const published = () => [...store.episodes].filter((e) => e.published !== false).sort((a, b) => b.endedAt - a.endedAt);
  const byNo = (no: string) => published().find((e) => String(e.no) === no);
  r.use((_req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    next();
  });
  r.get("/", (_req, res) => {
    res.setHeader("Cache-Control", "public, max-age=30");
    res.json({ sessions: published().map((e) => sessionView(e, base())) });
  });
  r.get("/:no", (req, res) => {
    const e = byNo(req.params.no);
    if (!e) return void res.status(404).json({ error: "not found" });
    res.setHeader("Cache-Control", "public, max-age=30");
    res.json({ ...sessionView(e, base()), transcript: (e.transcript ?? []).map((l) => ({ atSec: Math.max(0, Math.round((l.ts - e.startedAt) / 1000)), who: l.who, name: l.name, text: l.text })) });
  });
  r.get("/:no/:file", (req, res) => {
    const e = byNo(req.params.no);
    const m = /^(?:((?:tall|wide)(?:-p[1-9][0-9]?)?)\.(mp4|webm)|thumb\.jpg)$/.exec(req.params.file);
    if (!e || !m) return void res.status(404).end();
    const path = join(root, e.id, req.params.file);
    if (!existsSync(path)) return void res.status(404).end();
    if (m[1] && !readCursor(e.id, m[1])?.complete) return void res.status(404).end();
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.sendFile(path, { headers: { "Content-Type": m[2] ? (m[2] === "mp4" ? "video/mp4" : "video/webm") : "image/jpeg" }, lastModified: true });
  });
  return r;
}

export const recordingsBytes = () => {
  let total = 0;
  for (const ep of existsSync(root) ? readdirSync(root) : []) for (const f of readdirSync(join(root, ep))) if (!f.endsWith(".json")) total += statSync(join(root, ep, f)).size;
  return total;
};
