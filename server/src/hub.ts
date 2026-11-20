import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { WebSocket } from "ws";
import { BIN_FRAME, BIN_TTS, type ChangeEvent, type ContentLink, type PlanWindow, type CostState, type Entity, type EpisodeSetup, type EpisodeState, type LayoutMode, type Readiness, type ServerToPhone, type StudioState, type TaskEvent, type TileState, type WorkerState } from "../../shared/protocol.js";
import { config } from "./config.js";
import { livekit, ShareHub } from "./ride-share.js";
import { Director } from "./director.js";
import { deriveChange, editorUrl, ENTITY_LABEL, openUrl, viewerUrl } from "./events.js";
import { LANDSCAPE, PORTRAIT, PreviewRenderer } from "./preview/renderer.js";
import { radio, view as radioView } from "./radio.js";
import { store } from "./store.js";
import { STT_PRICE_PER_MIN, STT_VENDORS, type SttVendor } from "./stt/index.js";
import { streamTts, TTS_PRICE_PER_CHAR } from "./tts.js";
import { CloudRunner } from "./workers/cloud.js";
import { DeviceHub } from "./workers/devices.js";
import { StubRunner } from "./workers/stub.js";
import type { Running, TaskSpec } from "./workers/types.js";

interface Worker extends WorkerState {
  resume?: string;
  deviceId?: string;
  running?: Running;
  pendingCalls: Map<string, { name: string; input: unknown }>;
  queue: string[]; // follow-up briefs received while a run is in progress
  costBase: number; // cost of finished runs; the current run reports a cumulative figure
  lastEventAt?: number; // any sign of life from the runner (reads, thinking, writes)
  /** What the runner did, for Réglages → Journal: tool calls, refusals, errors. */
  log: { ts: number; line: string }[];
  writes: number; // successful MCP writes recognised as a content change, this run
}
interface MockDoc {
  title: string;
  items: { id: string; title: string; lines: string[] }[];
}
interface Target {
  key: string;
  entity: Entity;
  entityId: string;
  workerId: string;
  title: string;
  doc: MockDoc;
  slot: number | null;
  propsId?: string;
  /** An EdVerse game: its preview needs edverse=1. */
  edverse?: boolean;
  done?: boolean;
}

const SKILL = config.skillPath ? readFileSync(config.skillPath, "utf8").replace(/^---[\s\S]*?---\s*/, "") : "";
const MAX_TILES = 4;
/** No visible change and no sign of life from a running task for this long counts as blocked. */
const STALL_MS = 120_000;

export class Hub {
  readonly devices = new DeviceHub();
  readonly cloud = new CloudRunner();
  readonly share = new ShareHub();
  private stub = new StubRunner();
  private phones = new Set<WebSocket>();
  private episode: EpisodeState | null = null;
  private workers: Worker[] = [];
  private targets = new Map<string, Target>();
  private layout: LayoutMode = "auto";
  private focus: number | null = null;
  private cost: CostState = { director: 0, elevenlabs: 0, otherApis: 0, cloud: 0, planEquivalent: 0, total: 0, cap: store.settings.budget.capUsd, warned: false, capped: false, plan: null };
  private stateTimer: NodeJS.Timeout | null = null;
  private recent: { key: string; ts: number }[] = [];
  private mextySession: { token: string; exp: number } | null = null;
  private mextyOk = false;
  private episodeNo = Math.max(0, ...store.episodes.map((e) => e.no));

  // voice
  private ttsQueue: { id: number; text: string }[] = [];
  private ttsBusy = false;
  private ttsAbort: AbortController | null = null;
  private sayId = 0;
  private lastSaid = "";
  speaking = false;

  readonly previews = new PreviewRenderer(
    (slot, jpeg) => this.binary(Buffer.concat([Buffer.from([BIN_FRAME, slot]), jpeg])),
    () => Math.max(0, ...[...this.phones].map((p) => p.bufferedAmount)),
  );

  readonly director = new Director(
    () => store.secret("anthropic"),
    () => store.settings.claude.directorModel,
    {
      setEpisode: (p) => {
        const ep = this.episode;
        if (!ep || ep.status !== "live") return "Aucun épisode en cours.";
        if (p.company) ep.setup.company = p.company.slice(0, 120);
        if (p.destination) ep.setup.destination = p.destination.slice(0, 120);
        if (p.topic) ep.setup.topic = p.topic.slice(0, 300);
        if (p.etaMin) ep.setup.etaMin = Math.min(600, Math.max(1, Math.round(p.etaMin)));
        this.pushState();
        return "Noté.";
      },
      endEpisode: () => (this.endEpisode(), "Épisode terminé."),
      arrive: () => this.arrive(),
      pauseRecording: () => this.setRec("pause"),
      resumeRecording: () => this.setRec("resume"),
      switchCamera: () => this.setCamera(),
      showContent: (name) => {
        if (name === null) return void this.showContent(null), "Fermé.";
        const c = this.findContent(name);
        if (!c) return `Erreur : contenu introuvable. Contenus : ${this.contents().map((x) => x.name).join(", ") || "aucun"}.`;
        void this.showContent(c.key);
        return `${c.name} à l'écran.`;
      },
      showQr: (on) => this.setQr(on),
      radio: (action) => this.setRadio(action, true),
      stopAll: () => (setTimeout(() => this.stopAll(), 0), "Tout est arrêté. Ne dis rien : le studio l'annonce."),
      dispatch: (brief, target) => this.dispatch(brief, target),
      status: () => this.statusText(),
      setLayout: (mode) => ((this.layout = mode), (this.focus = null), this.pushState(), `Disposition : ${mode}.`),
      focusTile: (n) => {
        // Screens are numbered as they appear at the picture: screen n is tile slot n-1.
        const tiles = this.tiles();
        const tile = n == null ? null : tiles.find((t) => t.slot === n - 1);
        if (n != null && !tile) return `Erreur : pas d'écran ${n}. ${this.screensText()}`;
        this.focus = tile ? tile.slot : null;
        this.pushState();
        return tile ? `Écran ${n} en plein écran.` : "Tous les écrans sont visibles.";
      },
      markBeat: (label) => {
        if (!this.episode) return "Aucun épisode en cours.";
        const beat = { label: label.slice(0, 80), ts: Date.now() };
        this.episode.beats.push(beat);
        this.broadcast({ t: "beat", ...beat });
        return "Moment marqué.";
      },
    },
    {
      say: (text) => this.say(text),
      usage: (usd) => this.addCost("director", usd),
      error: (message) => this.broadcast({ t: "error", message }),
    },
  );

  constructor() {
    this.devices.onChange = () => this.pushState();
    setInterval(() => void this.checkMexty(), 5 * 60_000).unref();
    setInterval(() => this.checkStalls(), 10_000).unref();
    void this.checkMexty();
  }

  // ---------- phones ----------
  addPhone(ws: WebSocket) {
    this.phones.add(ws);
    ws.on("close", () => this.phones.delete(ws));
    this.sendTo(ws, { t: "state", state: this.state() });
    for (const [slot, jpeg] of this.previews.snapshot()) ws.send(Buffer.concat([Buffer.from([BIN_FRAME, slot]), jpeg]));
  }
  private sendTo(ws: WebSocket, m: ServerToPhone) {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(m));
  }
  broadcast(m: ServerToPhone) {
    const s = JSON.stringify(m);
    for (const p of this.phones) if (p.readyState === p.OPEN) p.send(s);
  }
  private binary(buf: Buffer) {
    for (const p of this.phones) if (p.readyState === p.OPEN) p.send(buf);
  }
  pushState() {
    if (this.stateTimer) return;
    this.stateTimer = setTimeout(() => {
      this.stateTimer = null;
      this.broadcast({ t: "state", state: this.state() });
    }, 120);
  }

  // ---------- state ----------
  defaultSetup(): EpisodeSetup {
    return { company: "", destination: "", etaMin: 25, topic: "", template: store.settings.claude.templates[0] ?? "Vierge", budgetCap: store.settings.budget.capUsd, wide: false };
  }
  readiness(): Readiness {
    const devicesOnline = this.devices.onlineCount();
    const cloud = this.cloud.configured();
    return {
      director: !!store.secret("anthropic"),
      stt: STT_VENDORS.filter((v) => !!store.secret(v)),
      tts: !!store.secret("elevenlabs"),
      devicesOnline,
      cloud,
      mexty: this.mextyOk,
      stub: devicesOnline === 0 && !cloud,
      share: livekit.configured,
    };
  }
  private tiles(): TileState[] {
    return [...this.targets.values()]
      .filter((t) => t.slot != null)
      .map((t) => {
        const w = this.workers.find((x) => x.id === t.workerId)!;
        const last = this.lastChange.get(t.key);
        return { slot: t.slot!, workerId: t.workerId, workerNo: w?.no ?? 0, entity: t.entity, entityId: t.entityId, title: t.title, step: last?.label ?? w?.step ?? "", lastChangeTs: last?.ts ?? 0, lastChange: last, mode: this.previews.modeOf(t.slot!) ?? "mock", url: this.contents().find((c) => c.key === t.key)?.url || undefined };
      })
      .sort((a, b) => a.slot - b.slot);
  }
  private lastChange = new Map<string, ChangeEvent>();
  state(): StudioState {
    return {
      episode: this.episode,
      workers: this.workers.map(({ running: _r, pendingCalls: _p, queue: _q, resume: _s, costBase: _c, deviceId: _d, lastEventAt: _l, log: _g, writes: _x, ...w }) => w),
      tiles: this.tiles(),
      layout: this.layout,
      focus: this.focus,
      cost: this.cost,
      readiness: this.readiness(),
      speaking: this.speaking,
      rec: this.rec,
      camera: this.camera,
      show: this.show,
      contents: this.contents(),
      radio: this.radioState(),
    };
  }

  // ---------- Radio Monkey ----------
  private radioOn = false;
  private radioTrackId: string | null = null;
  private radioStartedAt = 0;

  radioState(): StudioState["radio"] {
    const t = this.radioTrackId ? radio.find(this.radioTrackId) : null;
    return { on: this.radioOn && !!t, track: t ? radioView(t) : null, startedAt: this.radioStartedAt, library: radio.tracks.filter((x) => x.enabled).length };
  }

  private playNext(): boolean {
    const t = radio.pick(this.radioTrackId ?? undefined);
    if (!t) return false;
    this.radioTrackId = t.id;
    this.radioStartedAt = Date.now();
    radio.aired(t);
    return true;
  }

  /**
   * On, off or next track. Only Fabien decides: the phone buttons and the director's radio tool (whose
   * description restricts it to his explicit request) are the only callers, plus the end of the episode.
   */
  setRadio(action: "on" | "off" | "next", spoken = false): string {
    if (action === "off") {
      if (!this.radioOn) return "La radio est déjà coupée.";
      this.radioOn = false;
      this.pushState();
      if (spoken) this.announce("Radio coupée.");
      return "OK.";
    }
    if (action === "on" && this.radioOn) return "La radio tourne déjà.";
    if (!this.playNext()) {
      this.radioOn = false;
      this.pushState();
      if (spoken) this.announce("La radio est vide.");
      return "Erreur : aucun morceau dans Radio Monkey.";
    }
    this.radioOn = true;
    this.pushState();
    const t = this.radioState().track!;
    if (spoken) this.announce(action === "on" ? "Radio Monkey." : `${t.title}.`);
    return "OK.";
  }

  /** The phone finished the track on air: the next one follows. Ignored if it is about an older track. */
  radioEnded(trackId: string) {
    if (!this.radioOn || trackId !== this.radioTrackId) return;
    if (!this.playNext()) this.radioOn = false;
    this.pushState();
  }

  /** A track was removed or disabled while on air. */
  radioLibraryChanged() {
    const t = this.radioTrackId ? radio.find(this.radioTrackId) : null;
    if (this.radioOn && (!t || !t.enabled)) this.radioEnded(this.radioTrackId!);
    this.pushState();
  }

  // ---------- arrival, recording, showing ----------
  private rec: StudioState["rec"] = "on";
  private camera: StudioState["camera"] = "user";
  private show: StudioState["show"] = { key: null, qr: false };

  /** The contents built this episode, as the rider names them. A game's block is shown through its scene. */
  contents(): ContentLink[] {
    const front = store.settings.mexty.frontUrl;
    const all = [...this.targets.values()];
    const out: ContentLink[] = [];
    for (const t of all) {
      const siblings = all.filter((x) => x.workerId === t.workerId && x !== t);
      if (t.entity === "block" && siblings.some((x) => x.entity === "scene")) continue;
      const game = t.entity === "scene" ? siblings.find((x) => x.entity === "block") : undefined;
      const demo = this.workers.find((w) => w.id === t.workerId)?.runner === "stub";
      out.push({
        key: t.key,
        name: this.nameOf(t),
        entity: t.entity,
        title: t.title,
        url: demo ? "" : openUrl(front, t.entity, t.entityId, { propsId: t.propsId, edverse: t.edverse, game: game && { blockId: game.entityId, propsId: game.propsId } }),
        editUrl: demo ? "" : editorUrl(front, t.entity, t.entityId, { propsId: t.propsId, edverse: t.edverse }),
        slot: t.slot,
        done: !!t.done,
      });
    }
    return out;
  }

  /** A guest joined through the QR code: the voice knows who is talking with it. */
  guestJoined(name: string) {
    this.director.note(`${name} a rejoint le trajet et peut te parler comme Fabien.`);
    this.announce(`${name} nous rejoint.`);
  }
  guestLeft(name: string) {
    this.director.note(`${name} a quitté le trajet.`);
  }

  /** The ride is over: the chrono stops, but everything else (recording, building, the voice) goes on. */
  arrive(): string {
    const ep = this.episode;
    if (!ep || ep.status !== "live") return "Aucun épisode en cours.";
    if (ep.phase === "arrived") return "Déjà arrivés.";
    ep.phase = "arrived";
    ep.arrivedAt = Date.now();
    // Start the showing part from the overview: nothing opens on the phone until it is asked for.
    if (this.show.key) void this.showContent(null);
    this.announce("Arrivés. On continue de tourner.");
    this.pushState();
    return "OK.";
  }

  setRec(action: "pause" | "resume"): string {
    if (this.episode?.status !== "live") return "Aucun épisode en cours.";
    const next = action === "pause" ? "paused" : "on";
    if (this.rec === next) return next === "paused" ? "Déjà en pause." : "Déjà en cours.";
    if (next === "paused") {
      // Said first, so the line is still in the file that is about to close.
      this.announce("Pause.");
      setTimeout(() => ((this.rec = "paused"), this.pushState()), 900);
    } else {
      this.rec = "on";
      this.pushState();
      setTimeout(() => this.announce("On tourne."), 600);
      this.episode.beats.push({ label: "Reprise de l'enregistrement", ts: Date.now() });
    }
    return "OK.";
  }

  setCamera(facing?: StudioState["camera"]): string {
    this.camera = facing ?? (this.camera === "user" ? "environment" : "user");
    this.pushState();
    return this.camera === "user" ? "Caméra avant." : "Caméra arrière.";
  }

  /** Show one content to someone: open on the phone, full picture and portrait in the recording. Null closes it. */
  async showContent(key: string | null): Promise<string> {
    const prev = this.show.key ? this.targets.get(this.show.key) : undefined;
    if (prev?.slot != null && prev.key !== key) void this.previews.resize(prev.slot, LANDSCAPE);
    if (!key) {
      this.show = { key: null, qr: false };
      this.focus = null;
      this.pushState();
      return "Fermé.";
    }
    const t = this.targets.get(key);
    if (!t) return "Erreur : contenu inconnu.";
    if (t.slot == null) await this.openTile(t);
    this.show = { key, qr: this.show.key === key && this.show.qr };
    this.focus = t.slot;
    // On the road it is just the full-size screen; once arrived it opens on the phone and is filmed in portrait.
    if (t.slot != null && this.episode?.phase === "arrived") void this.previews.resize(t.slot, PORTRAIT);
    this.pushState();
    return `${this.nameOf(t)} à l'écran.`;
  }

  setQr(on: boolean): string {
    if (on && !this.show.key) {
      const last = this.contents().at(-1);
      if (!last) return "Erreur : aucun contenu à montrer.";
      void this.showContent(last.key).then(() => ((this.show = { ...this.show, qr: true }), this.pushState()));
      return "OK.";
    }
    this.show = { ...this.show, qr: on };
    this.pushState();
    return on ? "QR code affiché." : "QR code masqué.";
  }

  /** "Cours 1", "le programme", "la scène 3D" → the content the rider means. */
  findContent(name: string): ContentLink | null {
    const norm = (x: string) => x.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
    const list = this.contents();
    const q = norm(name);
    if (!q) return list.at(-1) ?? null;
    const byName = list.find((c) => norm(c.name) === q) ?? list.find((c) => norm(c.name).includes(q) || q.includes(norm(c.name))) ?? list.find((c) => c.title && (norm(c.title).includes(q) || q.includes(norm(c.title))));
    if (byName) return byName;
    // A kind of content ("le parcours", "le premier cours", "le quiz"): the first of that kind.
    const kinds: [RegExp, ContentLink["entity"]][] = [[/parcours|programme|learning ?path|chemin/, "program"], [/cours|course|lecon/, "course"], [/quiz|evaluation|questionnaire|test/, "evaluation"], [/scene|3d|jeu|game|systeme solaire/, "scene"], [/activite|bloc|block/, "block"]];
    const kind = kinds.find(([re]) => re.test(q))?.[1];
    const ofKind = kind ? list.filter((c) => c.entity === kind) : [];
    const ordinal = /deuxieme|second|2/.test(q) ? 1 : /troisieme|3/.test(q) ? 2 : /dernier/.test(q) ? ofKind.length - 1 : 0;
    return ofKind[ordinal] ?? ofKind[0] ?? (list.length === 1 ? list[0] : null);
  }
  /** What is on each screen, in the words the rider uses ("le deuxième écran"). */
  private screensText(): string {
    const list = [...this.targets.values()].filter((t) => t.slot != null).sort((a, b) => a.slot! - b.slot!);
    return list.length ? `Écrans à l'image : ${list.map((t) => `écran ${t.slot! + 1} = ${this.nameOf(t)}${t.title ? ` (« ${t.title.slice(0, 40)} »)` : ""}`).join(" ; ")}.` : "Aucun écran à l'image pour l'instant.";
  }

  private statusText(): string {
    if (!this.episode) return "Aucun épisode en cours.";
    const left = Math.max(0, this.episode.setup.etaMin * 60 - ((this.episode.arrivedAt ?? Date.now()) - this.episode.startedAt) / 1000);
    const lines = [`Temps restant : ${Math.floor(left / 60)} min ${Math.floor(left % 60)} s. Dépense : ${this.cost.total.toFixed(2)} $ sur ${this.cost.cap} $.`];
    for (const w of this.workers) {
      const names = [...this.targets.values()].filter((t) => t.workerId === w.id).map((t) => this.nameOf(t)).join(", ");
      lines.push(`Demande ${w.no}${names ? ` (${names})` : ""} : ${w.status === "running" ? "en cours" : w.status === "done" ? "terminé" : w.status}, ${w.changes} changements. Brief : ${w.brief.slice(0, 120)}`);
    }
    lines.push(this.screensText());
    const cs = this.contents();
    if (cs.length) lines.push(`Contenus : ${cs.map((c) => `${c.name}${c.title ? ` « ${c.title.slice(0, 40)} »` : ""} (${c.done ? "terminé" : "en cours"})`).join(" ; ")}.`);
    lines.push(this.episode.phase === "arrived" ? "Arrivés : le chrono est arrêté, l'enregistrement continue." : "En route.");
    lines.push(this.rec === "paused" ? "Enregistrement en pause." : "Enregistrement en cours.");
    const s = this.episode.stats;
    lines.push(`Total : ${s.slides} écrans, ${s.questions} questions, ${s.nodes} étapes de parcours, ${s.objects} objets 3D.`);
    return lines.join("\n");
  }

  // ---------- episode ----------
  startEpisode(setup: EpisodeSetup) {
    if (this.episode?.status === "live") return;
    void this.previews.closeAll();
    this.workers = [];
    this.targets.clear();
    this.lastChange.clear();
    this.layout = "auto";
    this.focus = null;
    this.rec = "on";
    this.show = { key: null, qr: false };
    const cap = Math.max(1, Number(setup.budgetCap) || store.settings.budget.capUsd);
    this.cost = { director: 0, elevenlabs: 0, otherApis: 0, cloud: 0, planEquivalent: 0, total: 0, cap, warned: false, capped: false, plan: null };
    this.episode = {
      id: randomUUID(),
      no: ++this.episodeNo,
      setup: { ...setup, budgetCap: cap, etaMin: Math.max(1, Number(setup.etaMin) || 25) },
      startedAt: Date.now(),
      status: "live",
      phase: "ride",
      beats: [],
      delivered: [],
      stats: { slides: 0, questions: 0, nodes: 0, objects: 0, changes: 0 },
    };
    const e = this.episode.setup;
    this.director.reset(
      `Épisode ${this.episode.no} démarré. ` +
        [e.company && `Entreprise : ${e.company}.`, e.destination && `Destination : ${e.destination}.`, e.topic && `Formation à livrer : ${e.topic}.`].filter(Boolean).join(" ") +
        ` Trajet estimé : ${e.etaMin} minutes. Plafond : ${cap} $. Rien n'est lancé : Fabien va te dire quoi construire.`,
    );
    this.announce("J'attends tes ordres, Fabien.");
    const offline = store.devices.filter((d) => d.enabled && !this.devices.isOnline(d.id));
    if (this.readiness().stub && offline.length) setTimeout(() => this.announce(`Attention, ${offline[0].name} est hors ligne.`), 1500);
    void this.checkMexty();
    this.pushState();
  }

  endEpisode() {
    const ep = this.episode;
    if (!ep || ep.status !== "live") return;
    for (const w of this.workers) this.stopWorker(w, "stopped");
    this.devices.stopAll();
    this.director.halt();
    ep.status = "ended";
    this.share.close(ep.id);
    ep.endedAt = Date.now();
    const front = store.settings.mexty.frontUrl;
    ep.delivered = this.contents().map((c) => ({ entity: c.entity, entityId: c.key.split(":")[1], title: c.title || c.name, url: c.url || undefined }));
    store.addEpisode({ id: ep.id, no: ep.no, company: ep.setup.company, topic: ep.setup.topic, destination: ep.setup.destination, etaMin: ep.setup.etaMin, beats: ep.beats, startedAt: ep.startedAt, endedAt: ep.endedAt, cost: { director: this.cost.director, elevenlabs: this.cost.elevenlabs, otherApis: this.cost.otherApis, cloud: this.cost.cloud, planEquivalent: this.cost.planEquivalent, total: this.cost.total, plan: this.cost.plan }, stats: ep.stats, delivered: ep.delivered });
    this.stopSpeaking();
    this.radioOn = false;
    this.pushState();
    // Keep the last frames visible for the outro, then free Chromium.
    setTimeout(() => this.episode === ep && void this.previews.closeAll(), 60_000).unref();
  }

  get liveEpisodeId() {
    return this.episode?.id ?? null;
  }

  // ---------- budget ----------
  addCost(kind: "director" | "elevenlabs" | "otherApis" | "cloud" | "planEquivalent", usd: number, absolute = false) {
    if (!Number.isFinite(usd) || usd < 0) return;
    if (absolute) this.cost[kind] = usd;
    else this.cost[kind] += usd;
    const c = this.cost;
    // Only money actually spent counts: machine workers run on the Claude plan.
    c.total = c.director + c.elevenlabs + c.otherApis + c.cloud;
    if (this.episode?.status === "live") {
      if (!c.warned && c.total >= c.cap * 0.8) {
        c.warned = true;
        this.director.event(`Budget : ${c.total.toFixed(2)} $ dépensés, soit 80 % du plafond de ${c.cap} $. Préviens Fabien en une phrase très courte.`);
      }
      if (!c.capped && c.total >= c.cap) {
        c.capped = true;
        for (const w of this.workers) this.stopWorker(w, "stopped");
        this.director.event(`Plafond de ${c.cap} $ atteint : tout le travail en cours a été arrêté. Préviens Fabien en une phrase très courte.`);
      }
    }
    this.pushState();
  }
  addSttSeconds(vendor: SttVendor, seconds: number) {
    this.addCost(vendor === "elevenlabs" ? "elevenlabs" : "otherApis", (seconds / 60) * STT_PRICE_PER_MIN[vendor]);
  }
  /** Worker spend by who pays it: Managed Agents on the API key, machines on the Claude plan. */
  private workerCosts() {
    const sum = (f: (w: Worker) => boolean) => this.workers.filter(f).reduce((a, x) => a + x.costUsd, 0);
    this.addCost("cloud", sum((w) => w.runner === "cloud"), true);
    this.addCost("planEquivalent", sum((w) => w.runner !== "cloud"), true);
  }
  /** Plan usage read on a machine: the first reading of the episode is the baseline. */
  private planReading(e: Extract<TaskEvent, { kind: "plan" }>) {
    const prev = this.cost.plan;
    const win = (now: { pct: number; resetsAt: string | null } | null, before: PlanWindow | null | undefined): PlanWindow | null => {
      if (!now) return before ?? null;
      if (!before) return { pct: now.pct, resetsAt: now.resetsAt, start: now.pct };
      // A new reset time means the window started over: the baseline goes back to zero.
      const reset = !!now.resetsAt && !!before.resetsAt && now.resetsAt !== before.resetsAt;
      return { pct: now.pct, resetsAt: now.resetsAt ?? before.resetsAt, start: reset ? 0 : before.start };
    };
    this.cost.plan = { subscription: e.subscription ?? prev?.subscription ?? null, fiveHour: win(e.fiveHour, prev?.fiveHour), sevenDay: win(e.sevenDay, prev?.sevenDay), ts: Date.now() };
    this.pushState();
  }

  // ---------- voice out ----------
  private say(text: string) {
    const id = ++this.sayId;
    const key = store.secret("elevenlabs");
    this.broadcast({ t: "say", id, text, audio: !!key });
    if (!key) return; // the phone falls back to its own speech synthesis (monitor only)
    this.ttsQueue.push({ id, text });
    void this.pumpTts();
  }
  private async pumpTts() {
    if (this.ttsBusy) return;
    this.ttsBusy = true;
    this.setSpeaking(true);
    try {
      while (this.ttsQueue.length) {
        const { id, text } = this.ttsQueue.shift()!;
        const key = store.secret("elevenlabs");
        if (!key) break;
        this.ttsAbort = new AbortController();
        const head = Buffer.alloc(5);
        head[0] = BIN_TTS;
        head.writeUInt32LE(id, 1);
        try {
          await streamTts(key, store.settings.voice, text, this.lastSaid, this.ttsAbort.signal, (pcm) => this.binary(Buffer.concat([head, pcm])));
          this.addCost("elevenlabs", text.length * TTS_PRICE_PER_CHAR);
          this.lastSaid = text;
        } catch (e) {
          if (!this.ttsAbort.signal.aborted) this.broadcast({ t: "error", message: (e as Error).message });
        }
        this.broadcast({ t: "tts.end", id });
      }
    } finally {
      this.ttsBusy = false;
      this.setSpeaking(false);
    }
  }
  private setSpeaking(v: boolean) {
    if (this.speaking === v) return;
    this.speaking = v;
    this.pushState();
  }
  /** Barge-in: the rider started talking. */
  stopSpeaking() {
    this.ttsQueue = [];
    this.ttsAbort?.abort();
    this.director.interrupt();
    this.broadcast({ t: "tts.cancel" });
  }
  userTurn(text: string) {
    this.broadcast({ t: "user", text });
    this.director.user(text);
  }

  // ---------- workers ----------
  dispatch(brief: string, target?: number): string {
    if (!this.episode || this.episode.status !== "live") return "Erreur : aucun épisode en cours.";
    if (this.cost.capped) return "Erreur : plafond de dépense atteint, aucun nouveau travail n'est lancé.";
    if (target != null) {
      const w = this.workers.find((x) => x.no === target);
      if (!w) return `Erreur : pas de demande numéro ${target}. Numéros existants : ${this.workers.map((x) => x.no).join(", ") || "aucun"}.`;
      if (w.status === "running" || w.status === "queued") {
        w.queue.push(brief);
        return "OK, ajouté.";
      }
      this.launch(w, brief);
      return w.status === "error" ? `Erreur : ${w.error}. Le studio l'a déjà annoncé : réponds « … ».` : "OK, relancé.";
    }
    if (this.workers.filter((w) => w.status === "running" || w.status === "queued").length >= 6) return "Erreur : trop de contenus en parallèle. Poursuis un contenu existant avec target.";
    const w: Worker = { id: randomUUID(), no: this.workers.length + 1, brief, runner: "stub", status: "queued", step: "", changes: 0, costUsd: 0, startedAt: Date.now(), pendingCalls: new Map(), queue: [], costBase: 0, log: [], writes: 0 };
    this.workers.push(w);
    this.launch(w, brief);
    if (w.status === "error") return `Erreur : ${w.error}. Le studio l'a déjà annoncé : réponds « … ».`;
    return `OK, lancé (numéro ${w.no}).`;
  }

  private launch(w: Worker, brief: string) {
    const s = store.settings;
    // Follow-ups stay on the runner that holds the session.
    const sticky = w.resume ? w.runner : null;
    const deviceId = sticky && sticky !== "device" ? null : this.devices.pick(w.deviceId);
    const spec: TaskSpec = { taskId: `${w.id}:${Date.now()}`, brief, resume: w.resume, model: s.claude.workerModel, allowedTools: s.claude.allowedTools, systemAppend: SKILL + (s.claude.workspace ? `\n\nEspace de travail Mexty par défaut : ${s.claude.workspace}.` : ""), maxTurns: s.claude.maxTurns };
    const emit = (e: TaskEvent) => this.onTaskEvent(w, e);
    w.status = "running";
    w.writes = 0;
    w.startedAt = Date.now();
    w.lastEventAt = Date.now();
    w.brief = brief;
    w.error = undefined;
    if (deviceId && (!sticky || (sticky === "device" && (!w.deviceId || w.deviceId === deviceId)))) {
      w.runner = "device";
      w.deviceId = deviceId;
      w.deviceName = this.devices.nameOf(deviceId);
      w.running = this.devices.run(deviceId, spec, emit);
    } else if ((!sticky || sticky === "cloud") && this.cloud.available()) {
      w.runner = "cloud";
      w.deviceName = undefined;
      w.running = this.cloud.run(spec, emit);
    } else if (!sticky || sticky === "stub") {
      const paired = store.devices.filter((d) => d.enabled);
      if (!this.readiness().stub) {
        // Real runners exist but are all busy: do not silently fake the work.
        w.status = "error";
        w.error = "Tous les appareils sont occupés et le cloud est désactivé";
        this.announce("Impossible de lancer ça pour l'instant.");
      } else if (paired.length) {
        // A machine is paired but offline: fake content would only pass for real work. Say it instead.
        w.status = "error";
        w.error = `${paired.map((d) => d.name).join(", ")} hors ligne : lance npm run agent sur la machine`;
        this.note(w, `erreur · ${w.error}`);
        this.announce(`${paired[0].name} est hors ligne.`);
      } else {
        w.runner = "stub";
        w.running = this.stub.run(spec, emit);
      }
    } else {
      w.status = "error";
      w.error = "L'appareil qui porte cette session est hors ligne";
      this.announce("Impossible de reprendre ce contenu pour l'instant.");
    }
    this.pushState();
  }

  /** Emergency stop (button or voice): every agent, the orchestrator's pending work and the voice. The episode goes on. */
  stopAll() {
    this.director.halt();
    this.ttsQueue = [];
    this.ttsAbort?.abort();
    this.broadcast({ t: "tts.cancel" });
    for (const w of this.workers) this.stopWorker(w, "stopped");
    // Also reach tasks a restart of this server may have orphaned on the machines.
    this.devices.stopAll();
    this.stalled.clear();
    this.pushState();
    this.announce("Tout est arrêté.");
  }

  private stopWorker(w: Worker, status: WorkerState["status"]) {
    w.queue = [];
    if (w.status === "running" || w.status === "queued") {
      // Status first: the runner's final event must not be read as a failure of a task we stopped on purpose.
      w.status = status;
      w.running?.stop();
    }
  }

  /** Recent journal of every worker, newest episode first (Réglages → Journal). */
  journal() {
    return this.workers.map((w) => ({ no: w.no, runner: w.runner, device: w.deviceName ?? "", status: w.status, brief: w.brief.slice(0, 160), error: w.error ?? "", log: w.log.slice(-60) }));
  }
  private note(w: Worker, line: string) {
    w.log.push({ ts: Date.now(), line: line.slice(0, 300) });
    if (w.log.length > 200) w.log.splice(0, w.log.length - 200);
    console.log(`[worker ${w.no}] ${line.slice(0, 300)}`);
  }

  private onTaskEvent(w: Worker, e: TaskEvent) {
    w.lastEventAt = Date.now();
    if (e.kind === "plan") return this.planReading(e);
    if (e.kind === "init") this.note(w, `début · ${e.model} · MCP : ${e.mcpServers.map((s) => `${s.name}=${s.status}`).join(", ") || "aucun"}`);
    else if (e.kind === "text") this.note(w, `texte · ${e.text}`);
    else if (e.kind === "tool_use") this.note(w, `appel · ${e.name}`);
    else if (e.kind === "result") this.note(w, `fin · ${e.ok ? "ok" : "échec"} · ${e.turns} tours · ${e.summary}`);
    else if (e.kind === "error") this.note(w, `erreur · ${e.message}`);
    switch (e.kind) {
      case "init":
        w.resume = e.sessionId;
        break;
      case "text":
        w.step = e.text.replace(/\s+/g, " ").slice(0, 90);
        break;
      case "tool_use":
        w.pendingCalls.set(e.id, { name: e.name, input: e.input });
        break;
      case "tool_result": {
        const call = w.pendingCalls.get(e.id);
        w.pendingCalls.delete(e.id);
        if (!call || e.isError) break;
        const d = deriveChange(call.name, call.input, e.output);
        this.note(w, `résultat · ${call.name} · ${d ? `${d.event.entity} ${d.event.op}` : "aucun changement reconnu"} · ${e.output.slice(0, 120)}`);
        if (d) w.writes++;
        if (d) this.onChange({ ...d.event, source: w.runner === "stub" ? "stub" : "tool" }, w, d.title, d.itemTitle, d.lines);
        break;
      }
      case "usage":
        // A running estimate from the runner: it may only go up within a run.
        w.costUsd = Math.max(w.costUsd, w.costBase + e.costUsd);
        this.workerCosts();
        break;
      case "result":
        if (e.sessionId) w.resume = e.sessionId;
        // The runner's final figure replaces the estimate, but the total shown never goes back down.
        w.costUsd = Math.max(w.costUsd, w.costBase + e.costUsd);
        w.costBase = w.costUsd;
        this.workerCosts();
        if (w.status === "running") {
          w.status = e.ok ? "done" : "error";
          if (!e.ok) w.error = e.summary;
          const next = w.queue.shift();
          if (next && e.ok && !this.cost.capped && this.episode?.status === "live") this.launch(w, next);
          else this.announceDone(w, e.ok);
        }
        break;
      case "error":
        if (w.status === "running") {
          w.status = "error";
          w.error = e.message;
          if (/n'est pas connecté/.test(e.message)) {
            this.director.note(e.message);
            this.announce(`Mexty n'est pas connecté sur ${w.deviceName ?? "la machine"}.`);
          } else this.announceDone(w, false);
        }
        break;
    }
    this.pushState();
  }

  // ---------- change-event bus ----------
  /** Webhook from the Mexty backend (primary source). Unknown entities are ignored: we only follow what our workers touched. */
  onMextyEvents(events: Omit<ChangeEvent, "source">[]) {
    if (this.episode?.status !== "live") return;
    for (const ev of events) {
      const t = this.targets.get(`${ev.entity}:${ev.entityId}`);
      // The webhook only carries the Ride Studio account's own writes: during an episode, a write to a content
      // no tile follows yet comes from a running worker even when its tool call was not recognised.
      const w = t ? this.workers.find((x) => x.id === t.workerId) : [...this.workers].filter((x) => x.status === "running").sort((a, b) => (b.lastEventAt ?? 0) - (a.lastEventAt ?? 0))[0];
      if (!w) continue;
      if (!t) {
        this.note(w, `Mexty · ${ev.entity} ${ev.op} (${ev.tool ?? "?"})`);
        w.writes++;
      }
      this.onChange({ ...ev, source: "mexty", ts: ev.ts || Date.now() }, w);
    }
  }

  private onChange(ev: ChangeEvent, w: Worker, title?: string, itemTitle?: string, lines: string[] = []) {
    const ep = this.episode;
    if (!ep || ep.status !== "live") return;
    ev.episodeId = ep.id;
    ev.workerId = w.id;
    const key = `${ev.entity}:${ev.entityId}`;
    let t = this.targets.get(key);
    if (!t) {
      t = { key, entity: ev.entity, entityId: ev.entityId, workerId: w.id, title: title ?? "", doc: { title: title ?? "", items: [] }, slot: null, propsId: ev.path.propsId };
      this.targets.set(key, t);
      const siblings = [...this.targets.values()].filter((x) => x.workerId === w.id && x !== t);
      if (ev.entity === "scene") {
        // A scene game is a block plus its scene. The block viewer only shows the last built version (a blank
        // world while the scene is being edited), so the scene editor takes its place on screen.
        for (const b of siblings) {
          if (b.entity !== "block" || b.slot == null) continue;
          if (this.focus === b.slot) this.focus = null;
          void this.previews.close(b.slot);
          b.slot = null;
        }
      }
      if (ev.entity === "block" && siblings.some((x) => x.entity === "scene")) {
        // Same game, scene already on screen: no second tile.
      } else {
        void this.openTile(t).then(() => {
          this.broadcast({ t: "cue", kind: "started", entity: t!.entity, slot: t!.slot });
          this.director.note(`Nouvel écran à l'image. ${this.screensText()}`);
        });
      }
    }
    if (title) t.title = t.doc.title = title;
    if (ev.path.propsId) t.propsId = ev.path.propsId;
    if (/game/.test(ev.tool ?? "")) t.edverse = true;
    // A block preview shows the last saved props and the last build: reload it once the writes settle.
    if (t.entity === "block" && t.slot != null) this.reloadSoon(t);

    // The same write arrives twice (tool call, then Mexty): show and count it once.
    const sig = `${key}:${ev.op}:${ev.path.slideId ?? ev.path.nodeId ?? ev.path.stepId ?? ev.path.objectId ?? ev.path.propsId ?? ""}`;
    const now = Date.now();
    this.recent = this.recent.filter((r) => now - r.ts < 4000);
    const dup = ev.source === "mexty" && this.recent.some((r) => r.key === sig);
    if (ev.source !== "mexty") this.recent.push({ key: sig, ts: now });
    if (dup) return;

    // A scene object seen for the first time is an addition, whatever the tool was called.
    if (ev.entity === "scene" && ev.op === "update" && ev.path.objectId && !t.doc.items.some((i) => i.id === ev.path.objectId)) ev.op = "create";
    w.changes++;
    w.step = ev.label ?? w.step;
    ep.stats.changes++;
    if (ev.op === "create") {
      if (ev.path.slideId) ep.stats.slides++;
      else if (ev.path.stepId) ep.stats.questions++;
      else if (ev.path.nodeId) ep.stats.nodes++;
      else if (ev.entity === "scene") ep.stats.objects++;
    }
    this.lastChange.set(key, ev);

    // Mock document for tiles without a real Mexty page.
    const itemId = ev.path.slideId ?? ev.path.nodeId ?? ev.path.stepId ?? ev.path.objectId ?? (ev.entity === "scene" && ev.op !== "create" ? `o${t.doc.items.length + 1}` : undefined);
    if (itemId) {
      let item = t.doc.items.find((i) => i.id === itemId);
      if (ev.op === "delete") t.doc.items = t.doc.items.filter((i) => i.id !== itemId);
      else {
        if (!item) t.doc.items.push((item = { id: itemId, title: "", lines: [] }));
        if (itemTitle) item.title = itemTitle;
        for (const l of lines) if (!item.lines.includes(l)) item.lines.push(l);
      }
    }
    if (t.slot != null) void this.previews.mock(t.slot, { demo: w.runner === "stub", kind: `ÉCRAN ${t.slot + 1} · ${ENTITY_LABEL[t.entity]}`, title: t.doc.title, items: t.doc.items, focusId: itemId, chip: ev.op === "create" ? "+ ajouté" : ev.op === "delete" ? "supprimé" : "modifié" });

    this.broadcast({ t: "change", event: ev, slot: t.slot });
    this.pushState();
  }

  private reloads = new Map<string, NodeJS.Timeout>();
  private reloadSoon(t: Target) {
    clearTimeout(this.reloads.get(t.key));
    this.reloads.set(
      t.key,
      setTimeout(() => {
        this.reloads.delete(t.key);
        if (t.slot != null) void this.previews.reload(t.slot, viewerUrl(store.settings.mexty.frontUrl, "block", t.entityId, { propsId: t.propsId }) + (t.edverse ? "&edverse=1" : ""));
      }, 2500),
    );
  }

  /** What a piece of content is called aloud: "Cours 2", "Programme d'étude", "Évaluation 1". */
  private nameOf(t: Target): string {
    const same = [...this.targets.values()].filter((x) => x.entity === t.entity);
    const n = same.indexOf(t) + 1;
    const noun = { course: "Cours", program: "Programme d'étude", evaluation: "Évaluation", block: "Activité", scene: "Scène 3D" }[t.entity];
    return t.entity === "program" && same.length === 1 ? noun : `${noun} ${n}`;
  }
  /** The studio's own voice: a fixed, very short line, said as is (no model in between). */
  private announce(text: string) {
    this.director.note(`Le studio a dit à Fabien : « ${text} »`);
    this.say(text);
  }
  /** The only progress report the rider gets: "Cours 1 terminé." */
  private announceDone(w: Worker, ok: boolean) {
    const mine = [...this.targets.values()].filter((t) => t.workerId === w.id);
    if (!ok) return this.announce(mine.length ? `${this.nameOf(mine.at(-1)!)} bloqué${this.feminine(mine.at(-1)!) ? "e" : ""}.` : "Demande bloquée.");
    // Containers a course task only touched in passing (its own blocks) are not announced one by one.
    const main = mine.filter((t) => t.entity !== "block" || mine.every((x) => x.entity === "block"));
    if (!w.writes) {
      // The run ended without writing anything to Mexty: never call that "done".
      const why = w.log.filter((l) => /^(texte|erreur|fin) ·/.test(l.line)).slice(-3).map((l) => l.line).join(" / ");
      this.director.note(`La dernière demande s'est terminée sans rien créer dans Mexty. Détail : ${why.slice(0, 400)}`);
      return this.announce("Rien n'a été créé.");
    }
    if (!main.length) return this.announce("C'est fait.");
    for (const t of main) {
      t.done = true;
      this.broadcast({ t: "cue", kind: "finished", entity: t.entity, slot: t.slot });
      this.announce(`${this.nameOf(t)} terminé${this.feminine(t) ? "e" : ""}.`);
    }
  }
  private feminine = (t: Target) => t.entity === "evaluation" || t.entity === "block" || t.entity === "scene";
  private stalled = new Set<string>();
  /** A content that is being built but has not changed for a while: say so once, so the rider can relaunch it. */
  private checkStalls() {
    if (this.episode?.status !== "live") return;
    const now = Date.now();
    for (const w of this.workers) {
      if (w.status !== "running") continue;
      const mine = [...this.targets.values()].filter((t) => t.workerId === w.id);
      const last = Math.max(w.startedAt, w.lastEventAt ?? 0, ...mine.map((t) => this.lastChange.get(t.key)?.ts ?? 0));
      const key = `${w.id}:${w.brief}`;
      if (now - last < STALL_MS) this.stalled.delete(key);
      else if (!this.stalled.has(key)) {
        this.stalled.add(key);
        const t = mine.at(-1);
        this.announce(t ? `${this.nameOf(t)} bloqué${this.feminine(t) ? "e" : ""}.` : "Demande bloquée.");
      }
    }
  }

  // ---------- tiles / previews ----------
  private async openTile(t: Target) {
    const used = new Map([...this.targets.values()].filter((x) => x.slot != null).map((x) => [x.slot!, x]));
    let slot = [...Array(MAX_TILES).keys()].find((i) => !used.has(i));
    if (slot == null) {
      // All four tiles are taken: the quietest one gives up its place.
      const oldest = [...used.values()].sort((a, b) => (this.lastChange.get(a.key)?.ts ?? 0) - (this.lastChange.get(b.key)?.ts ?? 0))[0];
      slot = oldest.slot!;
      oldest.slot = null;
    }
    t.slot = slot;
    this.pushState();
    const w = this.workers.find((x) => x.id === t.workerId);
    const s = store.settings.mexty;
    let opts = {};
    if (w?.runner !== "stub" && s.preview !== "mock") {
      const token = await this.mextyToken();
      if (token) {
        const host = new URL(s.frontUrl).hostname;
        const domain = "." + host.split(".").slice(-2).join(".");
        opts = { url: viewerUrl(s.frontUrl, t.entity, t.entityId, { propsId: t.propsId }) + (t.entity === "block" && t.edverse ? "&edverse=1" : ""), cookies: [{ name: "authToken", value: token, domain, path: "/", secure: true, httpOnly: false }] };
      }
    }
    try {
      await this.previews.open(slot, opts);
      if (t.slot === slot) await this.previews.mock(slot, { demo: w?.runner === "stub", kind: `ÉCRAN ${slot + 1} · ${ENTITY_LABEL[t.entity]}`, title: t.doc.title, items: t.doc.items, focusId: t.doc.items.at(-1)?.id });
    } catch (e) {
      console.warn("[preview] open failed:", (e as Error).message);
    }
    this.pushState();
  }

  /** Short service session for Fabien's workspace, minted by the Mexty backend against the shared secret. */
  private async mextyToken(): Promise<string | null> {
    if (!config.rideSecret) return null;
    if (this.mextySession && this.mextySession.exp > Date.now() + 10 * 60_000) return this.mextySession.token;
    try {
      const r = await fetch(`${store.settings.mexty.apiUrl}/api/ride-studio/session`, { method: "POST", headers: { "x-mexty-ride-key": config.rideSecret }, signal: AbortSignal.timeout(5000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = (await r.json()) as { token: string; expiresIn: number };
      this.mextySession = { token: j.token, exp: Date.now() + j.expiresIn * 1000 };
      return j.token;
    } catch (e) {
      console.warn("[mexty] service session unavailable:", (e as Error).message);
      this.mextySession = null;
      return null;
    }
  }
  async checkMexty() {
    const ok = !!(await this.mextyToken());
    if (ok !== this.mextyOk) {
      this.mextyOk = ok;
      this.pushState();
    }
    return ok;
  }
}
