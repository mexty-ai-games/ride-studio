import type { EpisodeSetup } from "../../shared/protocol";
import { audio } from "./audio";
import { Compositor } from "./compositor";
import { link } from "./link";
import { Recording, recId, pruneRecordings } from "./recorder";
import { useApp } from "./store";

/** Owns the canvases, the camera element and the recordings for one episode. */
class Studio {
  readonly comp = new Compositor();
  readonly tall = Compositor.canvas("tall");
  readonly wide = Compositor.canvas("wide");
  private recs: Recording[] = [];
  private camEl: HTMLVideoElement | null = null;
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
      if (ep?.status === "live" && ep.id !== this.episodeId && audio.media && !s.recording) void this.beginRecording(ep.id);
      if (ep?.status === "ended" && was?.status === "live") void this.finish();
    });
  }

  /** From the "Top chrono" tap: permissions, graph, camera, then the episode starts. */
  async prepare() {
    const media = await audio.start(true);
    if (!this.camEl) {
      const v = document.createElement("video");
      v.muted = true;
      v.playsInline = true;
      this.camEl = v;
    }
    this.camEl.srcObject = new MediaStream(media.getVideoTracks());
    await this.camEl.play().catch(() => {});
    this.comp.cam = this.camEl;
    await Promise.all([document.fonts.load("800 60px 'Bricolage Grotesque'"), document.fonts.load("600 30px Inter")]).catch(() => {});
    this.comp.start();
  }

  async topChrono(setup: EpisodeSetup) {
    await this.prepare();
    this.recordWide = setup.wide;
    this.comp.clearFrames();
    useApp.getState().set({ claudeLine: "", userLine: "", partial: "", changes: [] });
    link.send({ t: "episode.start", setup });
    link.send({ t: "stt.start" });
  }

  /** The app was reloaded mid-ride: pick the episode back up (needs one tap for mic and camera). */
  async rejoin() {
    await this.prepare();
    link.send({ t: "stt.start" });
    const ep = useApp.getState().studio?.episode;
    if (ep?.status === "live" && !useApp.getState().recording) await this.beginRecording(ep.id);
  }

  private async beginRecording(episodeId: string) {
    this.episodeId = episodeId;
    await pruneRecordings([episodeId, localStorage.getItem("rs-last-episode") ?? ""]).catch(() => {});
    localStorage.setItem("rs-last-episode", episodeId);
    // A reload mid-episode starts a fresh pair of files rather than appending to a closed container.
    const part = Number(sessionStorage.getItem(`rs-part-${episodeId}`) ?? 0);
    sessionStorage.setItem(`rs-part-${episodeId}`, String(part + 1));
    const suffix = part ? `:p${part + 1}` : "";
    try {
      this.recs = [new Recording(recId(episodeId, "tall") + suffix, this.tall.canvas, audio.mixStream, 6_000_000)];
      if (this.recordWide) this.recs.push(new Recording(recId(episodeId, "wide") + suffix, this.wide.canvas, audio.mixStream, 5_000_000));
      for (const r of this.recs) r.start();
      useApp.getState().set({ recording: true, recStartedAt: Date.now() });
    } catch (e) {
      useApp.getState().error(`Enregistrement impossible : ${(e as Error).message}`);
    }
  }

  private async finish() {
    link.send({ t: "stt.stop" });
    // Let Claude's last words reach the file before closing it.
    await new Promise((r) => setTimeout(r, 2500));
    await Promise.all(this.recs.map((r) => r.stop().catch(() => {})));
    this.recs = [];
    useApp.getState().set({ recording: false });
    this.comp.stop();
    audio.stop();
  }

  end() {
    link.send({ t: "episode.end" });
  }
}

export const studio = new Studio();
(window as unknown as { __studio: Studio }).__studio = studio; // handy for debugging from the console
