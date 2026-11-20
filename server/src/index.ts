import { createHmac, randomInt, randomUUID } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import express from "express";
import QRCode from "qrcode";
import { WebSocketServer, type WebSocket } from "ws";
import { BIN_MIC, MIC_RATE, type ChangeEvent, type PhoneToServer, type ServerToPhone } from "../../shared/protocol.js";
import { clearSession, isAuthed, issueSession, limited, requireAuth, safeEqual } from "./auth.js";
import { config } from "./config.js";
import { Hub } from "./hub.js";
import { radio, radioRouter } from "./radio.js";
import { deleteVideos, diskUsage, recordingsBytes, recordingsRouter, videosOf } from "./recordings.js";
import { SECRET_NAMES, store, type SecretName } from "./store.js";
import { openStt, STT_VENDORS, type SttSession, type SttVendor } from "./stt/index.js";
import { listVoices } from "./tts.js";
import { livekit } from "./ride-share.js";

const hub = new Hub();
const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "camera=(self), microphone=(self)");
  next();
});

// ---- Mexty change-event webhook (raw body: the signature covers the exact bytes) ----
app.post("/api/mexty/events", express.raw({ type: "*/*", limit: "256kb" }), (req, res) => {
  if (!config.rideSecret) return void res.status(404).end();
  const sig = String(req.headers["x-mexty-signature"] || "");
  const want = "sha256=" + createHmac("sha256", config.rideSecret).update(req.body as Buffer).digest("hex");
  if (!safeEqual(sig, want)) return void res.status(401).json({ error: "bad signature" });
  try {
    const body = JSON.parse((req.body as Buffer).toString("utf8")) as { events?: Omit<ChangeEvent, "source">[] };
    hub.onMextyEvents((body.events ?? []).filter((e) => e && typeof e.entityId === "string" && typeof e.entity === "string" && e.path && typeof e.path === "object"));
    res.json({ ok: true });
  } catch {
    res.status(400).json({ error: "bad json" });
  }
});

// ---- Radio Monkey (before the JSON parser: uploads are raw audio) ----
app.use("/api", radioRouter(() => hub.radioLibraryChanged(), () => hub.radioState()));

app.use(express.json({ limit: "64kb" }));
app.get("/api/health", (_req, res) => void res.json({ ok: true }));

// ---- auth ----
app.post("/api/login", (req, res) => {
  if (limited(`login:${req.ip}`, 8, 10 * 60_000)) return void res.status(429).json({ error: "Trop d'essais, réessaie dans quelques minutes." });
  if (typeof req.body?.code !== "string" || !safeEqual(req.body.code.trim(), config.accessCode)) return void res.status(401).json({ error: "Code incorrect." });
  issueSession(res);
  res.json({ ok: true });
});
app.post("/api/logout", (_req, res) => {
  clearSession(res);
  res.json({ ok: true });
});
app.get("/api/me", (req, res) => void res.json({ authed: isAuthed(req) }));

// ---- device pairing (the agent calls /pair with the short code shown in Settings) ----
let pairing: { code: string; exp: number } | null = null;
app.post("/api/devices/pair-code", requireAuth, (_req, res) => {
  pairing = { code: String(randomInt(0, 1_000_000)).padStart(6, "0"), exp: Date.now() + 10 * 60_000 };
  res.json({ code: pairing.code, expiresAt: pairing.exp, server: config.publicUrl });
});
app.post("/api/devices/pair", (req, res) => {
  if (limited(`pair:${req.ip}`, 10, 10 * 60_000)) return void res.status(429).json({ error: "too many attempts" });
  const code = String(req.body?.code ?? "");
  if (!pairing || pairing.exp < Date.now() || !safeEqual(code, pairing.code)) return void res.status(401).json({ error: "Code invalide ou expiré." });
  pairing = null; // one device per code
  const { device, token } = store.addDevice(String(req.body?.name ?? "appareil").slice(0, 40));
  hub.pushState();
  res.json({ deviceId: device.id, token, name: device.name });
});
app.patch("/api/devices/:id", requireAuth, (req, res) => {
  const d = store.devices.find((x) => x.id === req.params.id);
  if (!d) return void res.status(404).end();
  if (typeof req.body?.enabled === "boolean") d.enabled = req.body.enabled;
  if (Number.isInteger(req.body?.concurrency)) d.concurrency = Math.min(8, Math.max(1, req.body.concurrency));
  if (typeof req.body?.name === "string" && req.body.name.trim()) d.name = req.body.name.trim().slice(0, 40);
  store.touchDevices();
  hub.pushState();
  res.json({ ok: true });
});
app.delete("/api/devices/:id", requireAuth, (req, res) => {
  hub.devices.disconnect(String(req.params.id));
  store.removeDevice(String(req.params.id));
  hub.pushState();
  res.json({ ok: true });
});

// ---- settings ----
function settingsView() {
  const month = new Date().toISOString().slice(0, 7);
  const months = new Map<string, { total: number; episodes: number }>();
  for (const e of store.episodes) {
    const k = new Date(e.startedAt).toISOString().slice(0, 7);
    const m = months.get(k) ?? { total: 0, episodes: 0 };
    m.total += e.cost.total;
    m.episodes++;
    months.set(k, m);
  }
  return {
    settings: store.settings,
    secrets: store.secretsView(),
    devices: hub.devices.view(),
    readiness: hub.readiness(),
    spend: { month, thisMonth: months.get(month) ?? { total: 0, episodes: 0 }, months: [...months].map(([m, v]) => ({ month: m, ...v })).slice(-6), episodes: store.episodes.slice(-10).reverse() },
    mextyLink: { secretSet: !!config.rideSecret, webhookUrl: config.publicUrl ? `${config.publicUrl}/api/mexty/events` : "/api/mexty/events" },
    publicUrl: config.publicUrl,
  };
}
app.get("/api/settings", requireAuth, (_req, res) => void res.json(settingsView()));
app.patch("/api/settings", requireAuth, (req, res) => {
  store.patchSettings(req.body ?? {});
  hub.pushState();
  void hub.checkMexty();
  res.json(settingsView());
});
app.put("/api/secrets/:name", requireAuth, (req, res) => {
  const name = req.params.name as SecretName;
  if (!SECRET_NAMES.includes(name) || typeof req.body?.value !== "string" || req.body.value.length > 400) return void res.status(400).json({ error: "bad request" });
  store.setSecret(name, req.body.value);
  hub.pushState();
  res.json(settingsView());
});
app.get("/api/journal", requireAuth, (_req, res) => void res.json({ workers: hub.journal() }));
app.get("/api/voices", requireAuth, async (_req, res) => {
  const key = store.secret("elevenlabs");
  if (!key) return void res.json({ voices: [] });
  try {
    res.json({ voices: await listVoices(key) });
  } catch (e) {
    res.status(502).json({ error: (e as Error).message, voices: [] });
  }
});

// ---- episode library: past episodes and their videos on the volume ----
app.use("/api/recordings", recordingsRouter((id) => store.episodes.some((e) => e.id === id) || hub.liveEpisodeId === id));
app.get("/api/episodes", requireAuth, (_req, res) => {
  res.json({
    episodes: [...store.episodes].reverse().map((e) => ({ ...e, videos: videosOf(e.id) })),
    storage: { ...diskUsage(), usedBytes: recordingsBytes() },
  });
});
app.delete("/api/episodes/:id/videos", requireAuth, (req, res) => {
  deleteVideos(String(req.params.id));
  res.json({ ok: true });
});
app.delete("/api/episodes/:id", requireAuth, (req, res) => {
  const id = String(req.params.id);
  if (hub.liveEpisodeId === id && hub.state().episode?.status === "live") return void res.status(409).json({ error: "Épisode en cours" });
  deleteVideos(id);
  store.removeEpisode(id);
  res.json({ ok: true });
});

// ---- Partager le trajet: guests join through a QR code (LiveKit) ----
app.post("/api/ride/share", requireAuth, (_req, res) => {
  const ep = hub.state().episode;
  if (!livekit.configured) return void res.status(503).json({ error: "LiveKit n'est pas configuré (LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET)." });
  if (!ep || ep.status !== "live") return void res.status(409).json({ error: "Aucun épisode en cours." });
  const inv = hub.share.inviteFor(ep.id);
  // The address the host is using (ride.mexty.ai), so the QR opens the same app.
  const base = _req.get("host") ? `${_req.protocol}://${_req.get("host")}` : config.publicUrl;
  res.json({ url: `${base}/join/${inv.code}`, livekitUrl: livekit.url, room: inv.room, token: hub.share.hostToken(ep.id), guests: [...inv.guests.values()] });
});
app.get("/api/ride/join/:code", (req, res) => {
  const inv = hub.share.find(String(req.params.code));
  const ep = hub.state().episode;
  if (!inv || !ep || ep.id !== inv.episodeId || ep.status !== "live") return void res.status(404).json({ error: "Ce trajet est terminé ou le lien n'est plus valable." });
  res.json({ episodeNo: ep.no, company: ep.setup.company, destination: ep.setup.destination });
});
app.post("/api/ride/join/:code", (req, res) => {
  if (limited(`join:${req.ip}`, 20, 10 * 60_000)) return void res.status(429).json({ error: "Trop d'essais." });
  const inv = hub.share.find(String(req.params.code));
  const ep = hub.state().episode;
  if (!inv || !ep || ep.id !== inv.episodeId || ep.status !== "live" || !livekit.configured) return void res.status(404).json({ error: "Ce trajet est terminé ou le lien n'est plus valable." });
  const name = String(req.body?.name ?? "").replace(/[^\p{L}\p{N} '\-]/gu, "").trim().slice(0, 30) || "Invité";
  const g = hub.share.guestToken(inv, name);
  res.json({ livekitUrl: livekit.url, room: inv.room, token: g.token, identity: g.identity, name });
});

// ---- QR code of a content link (drawn on the phone and into the recording) ----
app.get("/api/qr.svg", requireAuth, async (req, res) => {
  const u = String(req.query.u ?? "");
  if (!/^https:\/\//.test(u) || u.length > 600) return void res.status(400).end();
  res.setHeader("Content-Type", "image/svg+xml");
  res.setHeader("Cache-Control", "private, max-age=86400");
  res.send(await QRCode.toString(u, { type: "svg", errorCorrectionLevel: "M", margin: 2, color: { dark: "#0B1640", light: "#FFFFFF" } }));
});

// ---- bake-off recordings ----
const bakeDir = join(config.dataDir, "bakeoff");
mkdirSync(bakeDir, { recursive: true });
app.get("/api/bakeoff/:id.wav", requireAuth, (req, res) => {
  const id = String(req.params.id);
  const f = join(bakeDir, `${id}.wav`);
  if (!/^[a-f0-9-]{36}$/.test(id) || !existsSync(f)) return void res.status(404).end();
  res.setHeader("Content-Type", "audio/wav");
  res.setHeader("Content-Disposition", `attachment; filename="bakeoff-${id.slice(0, 8)}.wav"`);
  createReadStream(f).pipe(res);
});
function wav(pcm: Buffer): Buffer {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write("WAVEfmt ", 8);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(MIC_RATE, 24);
  h.writeUInt32LE(MIC_RATE * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36);
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

// ---- phone app ----
if (config.phoneDist) {
  app.use(express.static(config.phoneDist, { index: false, setHeaders: (res, p) => res.setHeader("Cache-Control", /\/assets\//.test(p) ? "public, max-age=31536000, immutable" : "no-cache") }));
  app.get(/^\/(?!api\/|ws\/).*/, (_req, res) => {
    res.setHeader("Cache-Control", "no-cache");
    res.sendFile(join(config.phoneDist!, "index.html"));
  });
}

// ---- websockets ----
const server = createServer(app);
const phoneWss = new WebSocketServer({ noServer: true, maxPayload: 1 << 20 });
const deviceWss = new WebSocketServer({ noServer: true, maxPayload: 4 << 20 });

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url || "/", "http://x");
  const deny = (code: number) => {
    socket.write(`HTTP/1.1 ${code} Denied\r\n\r\n`);
    socket.destroy();
  };
  if (url.pathname === "/ws/phone") {
    // Cookie-authenticated socket: refuse other origins.
    const origin = req.headers.origin;
    if (origin && new URL(origin).host !== req.headers.host) return deny(403);
    if (!isAuthed(req)) return deny(401);
    phoneWss.handleUpgrade(req, socket, head, (ws) => phoneSocket(ws));
  } else if (url.pathname === "/ws/device") {
    const token = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    const record = token ? store.deviceByToken(token) : null;
    if (!record) return deny(401);
    deviceWss.handleUpgrade(req, socket, head, (ws) => hub.devices.attach(ws, record));
  } else deny(404);
});

function phoneSocket(ws: WebSocket) {
  hub.addPhone(ws);
  const send = (m: ServerToPhone) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(m));
  let sessions: SttSession[] = [];
  let listening = false;
  let bakeoff: { id: string; chunks: Buffer[]; bytes: number; t0: number } | null = null;
  let billedBytes = 0;
  let retry: NodeJS.Timeout | null = null;

  const open = (vendor: SttVendor, isBake: boolean) => {
    const apiKey = store.secret(vendor);
    if (!apiKey) return void send({ t: "stt", vendor, kind: "error", text: `Aucune clé ${vendor} dans les réglages`, ts: Date.now() });
    const t0 = Date.now();
    const s = openStt(vendor, {
      apiKey,
      voice: store.settings.voice,
      on: (e) => {
        if (e.kind === "close") {
          // Vendors drop idle or long sessions: reconnect while the phone is still listening.
          sessions = sessions.filter((x) => x !== s);
          if (listening && !retry) retry = setTimeout(() => ((retry = null), listening && !sessions.some((x) => x.vendor === vendor) && open(vendor, isBake)), 800);
          return;
        }
        send({ t: "stt", vendor, kind: e.kind, text: e.text, ts: e.ts, ms: e.ts - (bakeoff?.t0 ?? t0) });
        if (isBake) return;
        // Server-side barge-in backstop: real words while Claude is talking.
        if (e.kind === "partial" && hub.speaking && (e.text ?? "").trim().split(/\s+/).length >= 2) hub.stopSpeaking();
        if (e.kind === "eot" && e.text) hub.userTurn(e.text);
      },
    });
    sessions.push(s);
  };
  const stop = () => {
    listening = false;
    if (retry) clearTimeout(retry);
    retry = null;
    for (const s of sessions) s.close();
    sessions = [];
    if (bakeoff) {
      const b = bakeoff;
      bakeoff = null;
      if (b.bytes > MIC_RATE) {
        writeFileSync(join(bakeDir, `${b.id}.wav`), wav(Buffer.concat(b.chunks)));
        send({ t: "bakeoff.saved", id: b.id, url: `/api/bakeoff/${b.id}.wav`, seconds: Math.round(b.bytes / (MIC_RATE * 2)) });
      }
    }
  };

  ws.on("message", (raw, isBinary) => {
    if (isBinary) {
      const buf = raw as Buffer;
      if (buf[0] !== BIN_MIC || !listening) return;
      const pcm = buf.subarray(1);
      for (const s of sessions) s.send(pcm);
      if (bakeoff && bakeoff.bytes < MIC_RATE * 2 * 600) {
        bakeoff.chunks.push(Buffer.from(pcm));
        bakeoff.bytes += pcm.length;
      }
      billedBytes += pcm.length;
      if (billedBytes >= MIC_RATE * 2 * 10) {
        for (const s of sessions) hub.addSttSeconds(s.vendor, billedBytes / (MIC_RATE * 2));
        billedBytes = 0;
      }
      return;
    }
    let m: PhoneToServer;
    try {
      m = JSON.parse(raw.toString());
    } catch {
      return;
    }
    switch (m.t) {
      case "ping":
        return void send({ t: "pong", ts: m.ts });
      case "episode.start":
        return hub.startEpisode({ ...hub.defaultSetup(), ...m.setup, company: String(m.setup.company ?? "").slice(0, 120), destination: String(m.setup.destination ?? "").slice(0, 120), topic: String(m.setup.topic ?? "").slice(0, 300), template: String(m.setup.template ?? "").slice(0, 80) });
      case "episode.end":
        return hub.endEpisode();
      case "bargein":
        return hub.stopSpeaking();
      case "stop":
        return hub.stopAll();
      case "arrive":
        return void hub.arrive();
      case "rec":
        return void hub.setRec(m.action === "pause" ? "pause" : "resume");
      case "camera":
        return void hub.setCamera(m.facing === "user" || m.facing === "environment" ? m.facing : undefined);
      case "show":
        return void hub.showContent(typeof m.key === "string" ? m.key : null);
      case "qr":
        return void hub.setQr(!!m.on);
      case "guest":
        return void (m.joined ? hub.guestJoined(String(m.name).slice(0, 30)) : hub.guestLeft(String(m.name).slice(0, 30)));
      case "radio":
        return void hub.setRadio(m.action === "off" ? "off" : m.action === "next" ? "next" : "on");
      case "radio.ended":
        return typeof m.trackId === "string" ? hub.radioEnded(m.trackId) : undefined;
      case "radio.meta":
        return typeof m.trackId === "string" ? radio.setDuration(m.trackId, Number(m.durationSec)) : undefined;
      case "text":
        if (typeof m.text === "string" && m.text.trim()) hub.userTurn(m.text.trim().slice(0, 600));
        return;
      case "stt.start": {
        stop();
        listening = true;
        if (m.bakeoff) {
          bakeoff = { id: randomUUID(), chunks: [], bytes: 0, t0: Date.now() };
          const wanted = (m.vendors?.length ? m.vendors : STT_VENDORS).filter((v): v is SttVendor => STT_VENDORS.includes(v as SttVendor));
          for (const v of wanted) open(v, true);
        } else {
          const chosen = store.settings.voice.sttVendor;
          const vendor = store.secret(chosen) ? chosen : (STT_VENDORS.find((v) => store.secret(v)) ?? chosen);
          open(vendor, false);
        }
        return;
      }
      case "stt.stop":
        return stop();
    }
  });
  ws.on("close", stop);
}

server.listen(config.port, () => {
  console.log(`[ride-studio] listening on :${config.port}${config.phoneDist ? "" : " (phone app not built)"} — data in ${config.dataDir}`);
  if (!config.prod) console.log(`[ride-studio] dev access code: ${config.accessCode}`);
});
const bye = () => void hub.previews.shutdown().finally(() => process.exit(0));
process.on("SIGTERM", bye);
process.on("SIGINT", bye);
