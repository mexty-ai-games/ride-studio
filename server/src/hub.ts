import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { WebSocket } from "ws";
import { BIN_FRAME, BIN_TTS, type ChangeEvent, type CostState, type Entity, type EpisodeSetup, type EpisodeState, type LayoutMode, type Readiness, type ServerToPhone, type StudioState, type TaskEvent, type TileState, type WorkerState } from "../../shared/protocol.js";
import { config } from "./config.js";
import { Director } from "./director.js";
import { deriveChange, ENTITY_LABEL, viewerUrl } from "./events.js";
import { PreviewRenderer } from "./preview/renderer.js";
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
}

const SKILL = config.skillPath ? readFileSync(config.skillPath, "utf8").replace(/^---[\s\S]*?---\s*/, "") : "";
const MAX_TILES = 4;

export class Hub {
  readonly devices = new DeviceHub();
  readonly cloud = new CloudRunner();
  private stub = new StubRunner();
  private phones = new Set<WebSocket>();
  private episode: EpisodeState | null = null;
  private workers: Worker[] = [];
  private targets = new Map<string, Target>();
  private layout: LayoutMode = "auto";
  private focus: number | null = null;
  private cost: CostState = { director: 0, voice: 0, workers: 0, total: 0, cap: store.settings.budget.capUsd, warned: false, capped: false };
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
      startEpisode: (s) => (this.episode?.status === "live" ? "Un épisode est déjà en cours." : (this.startEpisode({ ...this.defaultSetup(), ...Object.fromEntries(Object.entries(s).filter(([, v]) => v)) } as EpisodeSetup), "Épisode démarré, chrono lancé, premier worker lancé.")),
      endEpisode: () => (this.endEpisode(), "Épisode terminé."),
      dispatch: (brief, target) => this.dispatch(brief, target),
      status: () => this.statusText(),
      setLayout: (mode) => ((this.layout = mode), (this.focus = null), this.pushState(), `Disposition : ${mode}.`),
      focusTile: (n) => {
        const tile = n == null ? null : this.tiles().find((t) => t.workerNo === n);
        if (n != null && !tile) return `Aucun aperçu pour le worker ${n}.`;
        this.focus = tile ? tile.slot : null;
        this.pushState();
        return tile ? `Aperçu ${n} en plein écran.` : "Retour à la disposition normale.";
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
    };
  }
  private tiles(): TileState[] {
    return [...this.targets.values()]
      .filter((t) => t.slot != null)
      .map((t) => {
        const w = this.workers.find((x) => x.id === t.workerId)!;
        const last = this.lastChange.get(t.key);
        return { slot: t.slot!, workerId: t.workerId, workerNo: w?.no ?? 0, entity: t.entity, entityId: t.entityId, title: t.title, step: last?.label ?? w?.step ?? "", lastChangeTs: last?.ts ?? 0, lastChange: last, mode: this.previews.modeOf(t.slot!) ?? "mock" };
      })
      .sort((a, b) => a.slot - b.slot);
  }
  private lastChange = new Map<string, ChangeEvent>();
  state(): StudioState {
    return {
      episode: this.episode,
      workers: this.workers.map(({ running: _r, pendingCalls: _p, queue: _q, resume: _s, costBase: _c, deviceId: _d, ...w }) => w),
      tiles: this.tiles(),
      layout: this.layout,
      focus: this.focus,
      cost: this.cost,
      readiness: this.readiness(),
      speaking: this.speaking,
    };
  }
  private statusText(): string {
    if (!this.episode) return "Aucun épisode en cours.";
    const left = Math.max(0, this.episode.setup.etaMin * 60 - (Date.now() - this.episode.startedAt) / 1000);
    const lines = [`Temps restant : ${Math.floor(left / 60)} min ${Math.floor(left % 60)} s. Dépense : ${this.cost.total.toFixed(2)} $ sur ${this.cost.cap} $.`];
    for (const w of this.workers) lines.push(`Worker ${w.no} (${w.runner}) : ${w.status}, ${w.changes} changements, dernière étape : ${w.step || "démarrage"}. Brief : ${w.brief.slice(0, 120)}`);
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
    const cap = Math.max(1, Number(setup.budgetCap) || store.settings.budget.capUsd);
    this.cost = { director: 0, voice: 0, workers: 0, total: 0, cap, warned: false, capped: false };
    this.episode = {
      id: randomUUID(),
      no: ++this.episodeNo,
      setup: { ...setup, budgetCap: cap, etaMin: Math.max(1, Number(setup.etaMin) || 25) },
      startedAt: Date.now(),
      status: "live",
      beats: [],
      delivered: [],
      stats: { slides: 0, questions: 0, nodes: 0, objects: 0, changes: 0 },
    };
    const e = this.episode.setup;
    this.director.reset(
      `Épisode ${this.episode.no} démarré. Entreprise : ${e.company || "non précisée"}. Destination : ${e.destination || "non précisée"}. Trajet estimé : ${e.etaMin} minutes. Formation à livrer : ${e.topic || "à définir avec Fabien"}. Modèle de départ : ${e.template}. Plafond : ${cap} $. ` +
        (e.topic ? "Le worker 1 vient d'être lancé sur cette formation. " : "Aucun worker n'est encore lancé : attends le brief de Fabien. ") +
        "Fabien va faire son accroche face caméra : ne parle pas avant qu'il s'adresse à toi.",
    );
    if (e.topic) {
      this.dispatch(
        `Construis une formation Mexty complète pour l'entreprise « ${e.company || "le client"} »${e.destination ? ` (${e.destination})` : ""}. Sujet : ${e.topic}. ` +
          (e.template && e.template !== "Vierge" ? `Pars de la série de modèles « ${e.template} » (list_course_template_series) pour l'habillage. ` : "") +
          `Livrable : un cours de 6 à 8 écrans en français, concret et adapté au terrain, prêt à être publié. Le trajet dure ${e.etaMin} minutes : vise un résultat complet et montrable bien avant la fin.`,
      );
    }
    void this.checkMexty();
    this.pushState();
  }

  endEpisode() {
    const ep = this.episode;
    if (!ep || ep.status !== "live") return;
    for (const w of this.workers) this.stopWorker(w, "stopped");
    ep.status = "ended";
    ep.endedAt = Date.now();
    const front = store.settings.mexty.frontUrl;
    ep.delivered = [...this.targets.values()].map((t) => ({ entity: t.entity, entityId: t.entityId, title: t.title || ENTITY_LABEL[t.entity], url: this.workers.find((w) => w.id === t.workerId)?.runner === "stub" ? undefined : viewerUrl(front, t.entity, t.entityId).replace(/[?&]live=1(&embedded=1)?/, "") }));
    store.addEpisode({ id: ep.id, no: ep.no, company: ep.setup.company, topic: ep.setup.topic, destination: ep.setup.destination, etaMin: ep.setup.etaMin, beats: ep.beats, startedAt: ep.startedAt, endedAt: ep.endedAt, cost: { director: this.cost.director, voice: this.cost.voice, workers: this.cost.workers, total: this.cost.total }, stats: ep.stats, delivered: ep.delivered });
    this.stopSpeaking();
    this.pushState();
    // Keep the last frames visible for the outro, then free Chromium.
    setTimeout(() => this.episode === ep && void this.previews.closeAll(), 60_000).unref();
  }

  get liveEpisodeId() {
    return this.episode?.id ?? null;
  }

  // ---------- budget ----------
  addCost(kind: "director" | "voice" | "workers", usd: number, absolute = false) {
    if (!Number.isFinite(usd) || usd < 0) return;
    if (absolute) this.cost[kind] = usd;
    else this.cost[kind] += usd;
    const c = this.cost;
    c.total = c.director + c.voice + c.workers;
    if (this.episode?.status === "live") {
      if (!c.warned && c.total >= c.cap * 0.8) {
        c.warned = true;
        this.director.event(`Budget : ${c.total.toFixed(2)} $ dépensés, soit 80 % du plafond de ${c.cap} $. Préviens Fabien en une phrase.`);
      }
      if (!c.capped && c.total >= c.cap) {
        c.capped = true;
        for (const w of this.workers) this.stopWorker(w, "stopped");
        this.director.event(`Plafond de ${c.cap} $ atteint : tous les workers ont été arrêtés proprement. Dis-le à Fabien.`);
      }
    }
    this.pushState();
  }
  addSttSeconds(vendor: SttVendor, seconds: number) {
    this.addCost("voice", (seconds / 60) * STT_PRICE_PER_MIN[vendor]);
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
          this.addCost("voice", text.length * TTS_PRICE_PER_CHAR);
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
    if (!this.episode || this.episode.status !== "live") return "Erreur : aucun épisode en cours. Démarre l'épisode d'abord.";
    if (this.cost.capped) return "Erreur : plafond de dépense atteint, aucun nouveau travail n'est lancé.";
    if (target != null) {
      const w = this.workers.find((x) => x.no === target);
      if (!w) return `Erreur : pas de worker ${target}. Workers : ${this.workers.map((x) => x.no).join(", ") || "aucun"}.`;
      if (w.status === "running" || w.status === "queued") {
        w.queue.push(brief);
        return `Demande ajoutée à la suite du worker ${w.no} (il termine son étape en cours).`;
      }
      this.launch(w, brief);
      return `Worker ${w.no} relancé avec le même contexte.`;
    }
    if (this.workers.filter((w) => w.status === "running" || w.status === "queued").length >= 6) return "Erreur : trop de workers en parallèle. Poursuis un worker existant avec target.";
    const w: Worker = { id: randomUUID(), no: this.workers.length + 1, brief, runner: "stub", status: "queued", step: "", changes: 0, costUsd: 0, startedAt: Date.now(), pendingCalls: new Map(), queue: [], costBase: 0 };
    this.workers.push(w);
    this.launch(w, brief);
    return `Worker ${w.no} lancé (${w.runner === "device" ? `sur ${w.deviceName}` : w.runner === "cloud" ? "dans le cloud" : "mode démo"}).`;
  }

  private launch(w: Worker, brief: string) {
    const s = store.settings;
    // Follow-ups stay on the runner that holds the session.
    const sticky = w.resume ? w.runner : null;
    const deviceId = sticky && sticky !== "device" ? null : this.devices.pick(w.deviceId);
    const spec: TaskSpec = { taskId: `${w.id}:${Date.now()}`, brief, resume: w.resume, model: s.claude.workerModel, allowedTools: s.claude.allowedTools, systemAppend: SKILL + (s.claude.workspace ? `\n\nEspace de travail Mexty par défaut : ${s.claude.workspace}.` : ""), maxTurns: s.claude.maxTurns };
    const emit = (e: TaskEvent) => this.onTaskEvent(w, e);
    w.status = "running";
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
      if (!this.readiness().stub) {
        // Real runners exist but are all busy: do not silently fake the work.
        w.status = "error";
        w.error = "Tous les appareils sont occupés et le cloud est désactivé";
        this.director.event(`Le worker ${w.no} n'a pas pu démarrer : appareils occupés.`);
      } else {
        w.runner = "stub";
        w.running = this.stub.run(spec, emit);
      }
    } else {
      w.status = "error";
      w.error = "L'appareil qui porte cette session est hors ligne";
      this.director.event(`Le worker ${w.no} ne peut pas reprendre : son appareil est hors ligne.`);
    }
    this.pushState();
  }

  private stopWorker(w: Worker, status: WorkerState["status"]) {
    w.queue = [];
    if (w.status === "running" || w.status === "queued") {
      w.running?.stop();
      w.status = status;
    }
  }

  private onTaskEvent(w: Worker, e: TaskEvent) {
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
        if (d) this.onChange({ ...d.event, source: w.runner === "stub" ? "stub" : "tool" }, w, d.title, d.itemTitle, d.lines);
        break;
      }
      case "usage":
        w.costUsd = w.costBase + e.costUsd;
        this.addCost("workers", this.workers.reduce((a, x) => a + x.costUsd, 0), true);
        break;
      case "result":
        if (e.sessionId) w.resume = e.sessionId;
        w.costUsd = w.costBase + e.costUsd;
        w.costBase = w.costUsd;
        this.addCost("workers", this.workers.reduce((a, x) => a + x.costUsd, 0), true);
        if (w.status === "running") {
          w.status = e.ok ? "done" : "error";
          if (!e.ok) w.error = e.summary;
          const next = w.queue.shift();
          if (next && e.ok && !this.cost.capped && this.episode?.status === "live") this.launch(w, next);
          else this.director.event(e.ok ? `Le worker ${w.no} a terminé. Résumé : ${e.summary.slice(0, 300)}` : `Le worker ${w.no} s'est arrêté sur une erreur : ${e.summary.slice(0, 200)}`);
        }
        break;
      case "error":
        if (w.status === "running") {
          w.status = "error";
          w.error = e.message;
          this.director.event(`Le worker ${w.no} a rencontré une erreur : ${e.message.slice(0, 200)}`);
        }
        break;
    }
    this.pushState();
  }

  // ---------- change-event bus ----------
  /** Webhook from the Mexty backend (primary source). Unknown entities are ignored: we only follow what our workers touched. */
  onMextyEvents(events: Omit<ChangeEvent, "source">[]) {
    for (const ev of events) {
      const t = this.targets.get(`${ev.entity}:${ev.entityId}`);
      if (!t || this.episode?.status !== "live") continue;
      this.onChange({ ...ev, source: "mexty", ts: ev.ts || Date.now() }, this.workers.find((w) => w.id === t.workerId)!);
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
      void this.openTile(t);
    }
    if (title) t.title = t.doc.title = title;

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
    if (t.slot != null) void this.previews.mock(t.slot, { kind: `CLAUDE ${w.no} · ${ENTITY_LABEL[t.entity]}`, title: t.doc.title, items: t.doc.items, focusId: itemId, chip: ev.op === "create" ? "+ ajouté" : ev.op === "delete" ? "supprimé" : "modifié" });

    this.broadcast({ t: "change", event: ev, slot: t.slot });
    this.milestones(ep, w, ev);
    this.pushState();
  }

  private announced = new Set<string>();
  private milestones(ep: EpisodeState, w: Worker, ev: ChangeEvent) {
    const once = (k: string, text: string) => {
      const id = `${ep.id}:${k}`;
      if (this.announced.has(id)) return;
      this.announced.add(id);
      this.director.event(text);
    };
    if (ev.op === "create" && ev.path.slideId && ep.stats.slides === 1) once("slide1", "Le premier écran du cours vient d'apparaître à l'image.");
    if (ev.op === "create" && ev.path.stepId && ep.stats.questions === 1) once("q1", "La première question de l'évaluation vient d'apparaître.");
    if (ev.entity === "scene" && ep.stats.objects === 1) once("o1", "Le premier objet 3D vient d'apparaître dans la scène.");
    if (ev.op === "create" && ev.path.slideId && ep.stats.slides > 1 && ep.stats.slides % 4 === 0) once(`s${ep.stats.slides}`, `Le worker ${w.no} en est à ${ep.stats.slides} écrans.`);
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
        opts = { url: viewerUrl(s.frontUrl, t.entity, t.entityId, { propsId: t.propsId }), cookies: [{ name: "authToken", value: token, domain, path: "/", secure: true, httpOnly: false }] };
      }
    }
    try {
      await this.previews.open(slot, opts);
      if (t.slot === slot) await this.previews.mock(slot, { kind: `CLAUDE ${w?.no ?? ""} · ${ENTITY_LABEL[t.entity]}`, title: t.doc.title, items: t.doc.items, focusId: t.doc.items.at(-1)?.id });
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
