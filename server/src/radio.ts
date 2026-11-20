import { randomUUID } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import express, { type NextFunction, type Request, type Response, type Router } from "express";
import type { RadioTrackView } from "../../shared/protocol.js";
import { isAuthed, safeEqual } from "./auth.js";
import { config } from "./config.js";

/**
 * Radio Monkey: the music library played under an episode. Tracks (Suno songs or any audio file) live on the
 * volume under `radio/`, their metadata in `radio/tracks.json`. A track becomes public once it has been on air:
 * fabien.ninja lists what the radio broadcast.
 */
const dir = join(config.dataDir, "radio");
mkdirSync(dir, { recursive: true });
const metaFile = join(dir, "tracks.json");

export interface RadioTrack {
  id: string;
  title: string;
  artist: string;
  file: string;
  mime: string;
  bytes: number;
  durationSec?: number;
  cover?: string;
  prompt?: string;
  source: "upload" | "url";
  sourceUrl?: string;
  enabled: boolean;
  addedAt: number;
  plays: number;
  firstPlayedAt?: number;
  lastPlayedAt?: number;
}

const MAX_BYTES = 40 * 1024 * 1024;
const AUDIO_EXT: Record<string, string> = { "audio/mpeg": "mp3", "audio/mp3": "mp3", "audio/mp4": "m4a", "audio/x-m4a": "m4a", "audio/aac": "aac", "audio/wav": "wav", "audio/x-wav": "wav", "audio/wave": "wav", "audio/ogg": "ogg", "audio/webm": "webm", "audio/flac": "flac" };
const EXT_MIME: Record<string, string> = { mp3: "audio/mpeg", m4a: "audio/mp4", aac: "audio/aac", wav: "audio/wav", ogg: "audio/ogg", webm: "audio/webm", flac: "audio/flac" };
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

let tracks: RadioTrack[] = (() => {
  try {
    return JSON.parse(readFileSync(metaFile, "utf8")) as RadioTrack[];
  } catch {
    return [];
  }
})();
function save() {
  const tmp = metaFile + ".tmp";
  writeFileSync(tmp, JSON.stringify(tracks, null, 1));
  renameSync(tmp, metaFile);
}

const clean = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");
const mimeOf = (contentType: string | undefined, name: string) => {
  const ct = (contentType || "").split(";")[0].trim().toLowerCase();
  if (AUDIO_EXT[ct]) return ct;
  const ext = /\.([a-z0-9]{2,4})(?:\?|$)/i.exec(name)?.[1]?.toLowerCase();
  return ext && EXT_MIME[ext] ? EXT_MIME[ext] : null;
};

export const fileUrl = (t: RadioTrack) => `/api/radio/file/${t.file}`;
export function view(t: RadioTrack, absolute = false): RadioTrackView {
  const url = fileUrl(t);
  return { id: t.id, title: t.title, artist: t.artist, durationSec: t.durationSec, cover: t.cover, url: absolute && config.publicUrl ? config.publicUrl + url : url };
}

export const radio = {
  get tracks() {
    return tracks;
  },
  find: (id: string) => tracks.find((t) => t.id === id) ?? null,
  /** Next track: any enabled one, avoiding the last few played so it never sounds like a loop. */
  pick(exclude?: string): RadioTrack | null {
    const pool = tracks.filter((t) => t.enabled && t.id !== exclude && existsSync(join(dir, t.file)));
    if (!pool.length) return exclude ? (tracks.find((t) => t.id === exclude && t.enabled) ?? null) : null;
    const recent = [...pool].sort((a, b) => (b.lastPlayedAt ?? 0) - (a.lastPlayedAt ?? 0)).slice(0, Math.min(5, pool.length - 1)).map((t) => t.id);
    const fresh = pool.filter((t) => !recent.includes(t.id));
    const from = fresh.length ? fresh : pool;
    return from[Math.floor(Math.random() * from.length)];
  },
  /** On air: counts as a play and makes the track public. */
  aired(t: RadioTrack) {
    const now = Date.now();
    t.plays++;
    t.firstPlayedAt ??= now;
    t.lastPlayedAt = now;
    save();
  },
  setDuration(id: string, sec: number) {
    const t = radio.find(id);
    if (!t || !Number.isFinite(sec) || sec <= 0 || sec > 3 * 3600 || t.durationSec) return;
    t.durationSec = Math.round(sec);
    save();
  },
};

function add(meta: Partial<RadioTrack>, file: string, mime: string, bytes: number, source: RadioTrack["source"], sourceUrl?: string): RadioTrack {
  const t: RadioTrack = {
    id: file.split(".")[0],
    title: clean(meta.title, 120) || "Sans titre",
    artist: clean(meta.artist, 80) || "Radio Monkey",
    file,
    mime,
    bytes,
    durationSec: Number(meta.durationSec) > 0 ? Math.round(Number(meta.durationSec)) : undefined,
    cover: /^https:\/\//.test(String(meta.cover ?? "")) ? clean(meta.cover, 500) : undefined,
    prompt: clean(meta.prompt, 1000) || undefined,
    source,
    sourceUrl,
    enabled: true,
    addedAt: Date.now(),
    plays: 0,
  };
  tracks.push(t);
  save();
  return t;
}

/** The owner's session, or `Authorization: Bearer <RADIO_TOKEN>` so a routine (Suno → radio) can add tracks. */
function radioAuth(req: Request, res: Response, next: NextFunction) {
  if (isAuthed(req)) return next();
  const bearer = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization || ""))?.[1];
  if (config.radioToken && bearer && safeEqual(bearer, config.radioToken)) return next();
  res.status(401).json({ error: "unauthorized" });
}

export function radioRouter(onChange: () => void, liveView: () => { on: boolean; track: RadioTrackView | null; startedAt: number }): Router {
  const r = express.Router();

  // ---- public: what fabien.ninja shows ----
  r.get("/public/radio", (_req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cache-Control", "public, max-age=15");
    const live = liveView();
    const aired = tracks
      .filter((t) => t.plays > 0)
      .sort((a, b) => (b.lastPlayedAt ?? 0) - (a.lastPlayedAt ?? 0))
      .map((t) => ({ ...view(t, true), plays: t.plays, firstPlayedAt: t.firstPlayedAt, lastPlayedAt: t.lastPlayedAt }));
    res.json({ name: "Radio Monkey", live: { on: live.on, track: live.track ? { ...live.track, url: config.publicUrl ? config.publicUrl + live.track.url : live.track.url } : null, startedAt: live.startedAt }, tracks: aired });
  });

  /** The phone plays everything; the public only hears what has been on air. Range requests are handled. */
  r.get("/radio/file/:file", (req, res) => {
    const m = /^([0-9a-f-]{36})\.([a-z0-9]{2,4})$/.exec(req.params.file);
    const t = m && ID.test(m[1]) ? radio.find(m[1]) : null;
    const path = t ? join(dir, t.file) : "";
    if (!t || t.file !== req.params.file || !existsSync(path)) return void res.status(404).end();
    if (t.plays === 0 && !isAuthed(req)) return void res.status(404).end();
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.sendFile(path, { headers: { "Content-Type": t.mime } });
  });

  // ---- owner (or routine token) ----
  r.get("/radio/tracks", radioAuth, (_req, res) => void res.json({ tracks: [...tracks].sort((a, b) => b.addedAt - a.addedAt).map((t) => ({ ...t, url: fileUrl(t) })), tokenSet: !!config.radioToken }));

  /** Add a track from a URL (e.g. the audio URL Suno returns): the file is copied to the volume, links expire. */
  r.post("/radio/tracks/url", radioAuth, express.json({ limit: "16kb" }), async (req, res) => {
    const url = clean(req.body?.url, 2000);
    if (!/^https:\/\//i.test(url)) return void res.status(400).json({ error: "Adresse https:// attendue." });
    try {
      const resp = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(60_000) });
      if (!resp.ok || !resp.body) return void res.status(502).json({ error: `Téléchargement impossible (${resp.status}).` });
      const mime = mimeOf(resp.headers.get("content-type") ?? undefined, new URL(url).pathname);
      if (!mime) return void res.status(415).json({ error: "Ce n'est pas un fichier audio." });
      if (Number(resp.headers.get("content-length") || 0) > MAX_BYTES) return void res.status(413).json({ error: "Fichier trop gros (40 Mo max)." });
      const id = randomUUID();
      const file = `${id}.${AUDIO_EXT[mime]}`;
      const path = join(dir, file);
      let bytes = 0;
      const body = Readable.fromWeb(resp.body as never);
      body.on("data", (c: Buffer) => {
        bytes += c.length;
        if (bytes > MAX_BYTES) body.destroy(new Error("too big"));
      });
      try {
        await pipeline(body, createWriteStream(path));
      } catch {
        rmSync(path, { force: true });
        return void res.status(413).json({ error: "Fichier trop gros (40 Mo max)." });
      }
      const t = add(req.body ?? {}, file, mime, statSync(path).size, "url", url);
      onChange();
      res.json({ track: { ...t, url: fileUrl(t) } });
    } catch (e) {
      res.status(502).json({ error: `Téléchargement impossible : ${(e as Error).message}` });
    }
  });

  /** Upload a file from the phone: raw body, metadata in the query string. */
  r.put("/radio/tracks/upload", radioAuth, express.raw({ type: "*/*", limit: MAX_BYTES }), (req, res) => {
    const body = req.body as Buffer;
    const name = clean(req.query.name, 200);
    const mime = mimeOf(req.headers["content-type"], name);
    if (!Buffer.isBuffer(body) || !body.length) return void res.status(400).json({ error: "Fichier vide." });
    if (!mime) return void res.status(415).json({ error: "Ce n'est pas un fichier audio." });
    const id = randomUUID();
    const file = `${id}.${AUDIO_EXT[mime]}`;
    writeFileSync(join(dir, file), body);
    const title = clean(req.query.title, 120) || name.replace(/\.[a-z0-9]{2,4}$/i, "");
    const t = add({ title, artist: clean(req.query.artist, 80) }, file, mime, body.length, "upload");
    onChange();
    res.json({ track: { ...t, url: fileUrl(t) } });
  });

  r.patch("/radio/tracks/:id", radioAuth, express.json({ limit: "16kb" }), (req, res) => {
    const t = radio.find(String(req.params.id));
    if (!t) return void res.status(404).json({ error: "Morceau inconnu." });
    if (typeof req.body?.title === "string" && req.body.title.trim()) t.title = clean(req.body.title, 120);
    if (typeof req.body?.artist === "string") t.artist = clean(req.body.artist, 80) || "Radio Monkey";
    if (typeof req.body?.enabled === "boolean") t.enabled = req.body.enabled;
    save();
    onChange();
    res.json({ track: { ...t, url: fileUrl(t) } });
  });

  r.delete("/radio/tracks/:id", radioAuth, (req, res) => {
    const t = radio.find(String(req.params.id));
    if (!t) return void res.status(404).json({ error: "Morceau inconnu." });
    rmSync(join(dir, t.file), { force: true });
    tracks = tracks.filter((x) => x !== t);
    save();
    onChange();
    res.json({ ok: true });
  });

  return r;
}
