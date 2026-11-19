import type { EpisodeSetup, StudioState } from "../../shared/protocol";
import { audio } from "./audio";
import { birds } from "./birds";
import { Compositor } from "./compositor";
import { link } from "./link";
import { Recording, recId, pruneRecordings } from "./recorder";
import { useApp } from "./store";
import { autoUpload, syncUploads } from "./uploader";

const CAM = { width: { ideal: 720 }, height: { ideal: 960 }, frameRate: { ideal: 30 } };

/**
 * Owns the canvases, the camera and the recordings for one episode.
 * The recording is a series of segments: each pause closes the current files, each resume opens new ones,
 * which keeps videos short and lets the closed parts upload while the episode goes on.
 */
class Studio {
  readonly comp = new Compositor();
  readonly tall = Compositor.canvas("tall");
  readonly wide = Compositor.canvas("wide");
  private recs: Recording[] = [];
  private camEl: HTMLVideoElement | null = null;
  private camStream: MediaStream | null = null;
  private facing: StudioState["camera"] = "user";
  private segmenting: Promise<void> = Promise.resolve();
  episodeId = "";
  recordWide = false;

  constructor() {
    // The landscape canvas is what the rider sees; the 9:16 master is always drawn and recorded.
    this.comp.targets = [this.tall, this.wide];
    link.onOpen = () => {
      // After a network drop, resume listening without any touch.
      if (audio.media && useApp.getState().studio?.episode?.status === "live") link.send({ t: "stt.start" });
    };
    useApp.subscribe((s, prev) => {
      const ep = s.studio?.episode;
      const was = prev.studio?.episode;
      const live = ep?.status === "live" && !!audio.media;
      if (live && ep.id !== this.episodeId) {
        this.episodeId = ep.id;
        void pruneRecordings([ep.id, localStorage.getItem("rs-last-episode") ?? ""]).catch(() => {});
        localStorage.setItem("rs-last-episode", ep.id);
        if (s.studio!.rec === "on") this.queue(() => this.openSegment());
      } else if (live && s.studio!.rec !== prev.studio?.rec) {
        this.queue(() => (s.studio!.rec === "on" ? this.openSegment() : this.closeSegment()));
      }
      if (s.studio && s.studio.camera !== this.facing && audio.media) void this.setCamera(s.studio.camera);
      if (ep?.status === "ended" && was?.status === "live") void this.finish();
    });
  }

  /** Segment changes run one after the other, so a quick pause/resume never overlaps two files. */
  private queue(fn: () => Promise<void>) {
    this.segmenting = this.segmenting.then(fn, fn);
  }

  /** From the start tap: permissions, graph, camera, then the episode starts. */
  async prepare() {
    const media = await audio.start(true);
    if (!this.camEl) {
      const v = document.createElement("video");
      v.muted = true;
      v.playsInline = true;
      this.camEl = v;
    }
    this.camStream = new MediaStream(media.getVideoTracks());
    this.camEl.srcObject = this.camStream;
    await this.camEl.play().catch(() => {});
    this.comp.cam = this.camEl;
    this.comp.mirror = true;
    await Promise.all([document.fonts.load("800 60px 'Bricolage Grotesque'"), document.fonts.load("600 30px Inter")]).catch(() => {});
    this.comp.start();
    void birds.startAmbience();
  }

  /** Front camera (the rider) or rear camera (the person trying the training). */
  async setCamera(facing: StudioState["camera"]) {
    if (!this.camEl) return;
    this.facing = facing;
    try {
      const next = await navigator.mediaDevices.getUserMedia({ video: { ...CAM, facingMode: { ideal: facing } }, audio: false });
      this.camStream?.getVideoTracks().forEach((t) => t.stop());
      this.camStream = next;
      this.camEl.srcObject = next;
      await this.camEl.play().catch(() => {});
      this.comp.mirror = facing === "user";
    } catch (e) {
      useApp.getState().error(`Caméra ${facing === "user" ? "avant" : "arrière"} indisponible : ${(e as Error).message}`);
    }
  }

  async topChrono(setup: EpisodeSetup) {
    await this.prepare();
    this.recordWide = setup.wide;
    this.comp.clearFrames();
    birds.reset();
    useApp.getState().set({ claudeLine: "", userLine: "", partial: "", changes: [] });
    link.send({ t: "episode.start", setup });
    link.send({ t: "stt.start" });
  }

  /** The app was reloaded mid-episode: pick it back up (needs one tap for mic and camera). */
  async rejoin() {
    await this.prepare();
    link.send({ t: "stt.start" });
    const s = useApp.getState().studio;
    if (s?.episode?.status === "live") {
      this.episodeId = s.episode.id;
      if (s.rec === "on" && !this.recs.length) this.queue(() => this.openSegment());
      if (s.camera !== "user") void this.setCamera(s.camera);
    }
  }

  private async openSegment() {
    if (this.recs.length || !this.episodeId) return;
    const id = this.episodeId;
    // Part 1 has no suffix; every later part (after a pause or a reload) gets ":pN".
    const part = Number(sessionStorage.getItem(`rs-part-${id}`) ?? 0) + 1;
    sessionStorage.setItem(`rs-part-${id}`, String(part));
    const suffix = part > 1 ? `:p${part}` : "";
    try {
      this.recs = [new Recording(recId(id, "tall") + suffix, this.tall.canvas, audio.mixStream, 6_000_000)];
      if (this.recordWide) this.recs.push(new Recording(recId(id, "wide") + suffix, this.wide.canvas, audio.mixStream, 5_000_000));
      for (const r of this.recs) r.start();
      useApp.getState().set({ recording: true, recStartedAt: Date.now() });
    } catch (e) {
      this.recs = [];
      useApp.getState().error(`Enregistrement impossible : ${(e as Error).message}`);
    }
  }

  private async closeSegment() {
    const recs = this.recs;
    this.recs = [];
    if (!recs.length) return;
    await Promise.all(recs.map((r) => r.stop().catch(() => {})));
    useApp.getState().set({ recording: false });
    // A closed part can go to the server right away.
    if (autoUpload.on) void syncUploads();
  }

  private async finish() {
    link.send({ t: "stt.stop" });
    // Let Claude's last words reach the file before closing it.
    await new Promise((r) => setTimeout(r, 2500));
    this.queue(() => this.closeSegment());
    await this.segmenting;
    this.comp.stop();
    this.camStream?.getVideoTracks().forEach((t) => t.stop());
    audio.stop();
    this.facing = "user";
    if (autoUpload.on) void syncUploads();
  }

  end() {
    link.send({ t: "episode.end" });
  }
}

export const studio = new Studio();
(window as unknown as { __studio: Studio }).__studio = studio; // handy for debugging from the console
