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

export const recordingsBytes = () => {
  let total = 0;
  for (const ep of existsSync(root) ? readdirSync(root) : []) for (const f of readdirSync(join(root, ep))) if (!f.endsWith(".json")) total += statSync(join(root, ep, f)).size;
  return total;
};
