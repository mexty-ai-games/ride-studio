import type { RadioState } from "../../shared/protocol";
import { audio } from "./audio";
import { link } from "./link";
import { useApp } from "./store";

/** Music level, and how far it drops while Claude or the studio speaks, or a notification plays. */
const LEVEL = 0.3;
const DUCKED = 0.06;
/** Seconds: drop fast so the first word is clear, come back slowly once the voice is done. */
const DOWN = 0.05;
const UP = 0.6;
/** Keep the music down a little after the voice ends, so it does not pump between two sentences. */
const HOLD_MS = 500;

/**
 * Radio Monkey on the phone. Tracks are decoded and played through the episode's AudioContext, so they reach
 * the headset and the recording mix like every other sound, and nothing depends on the browser's autoplay
 * rules (the context was unlocked by the start tap). The server decides what is on air; the phone plays it,
 * joins mid-track after a reload, and says when a track ends.
 */
class Radio {
  private gain: GainNode | null = null;
  private src: AudioBufferSourceNode | null = null;
  private playing: string | null = null; // track id
  private loading: string | null = null;
  private duckUntil = 0;
  private timer = 0;

  private out(): { ctx: AudioContext; gain: GainNode } | null {
    const ctx = audio.ctx;
    if (!ctx) return null;
    if (!this.gain || this.gain.context !== ctx) {
      this.gain = ctx.createGain();
      this.gain.gain.value = LEVEL;
      this.target = LEVEL;
      audio.connectCue(this.gain);
      this.playing = null;
      window.clearInterval(this.timer);
      this.timer = window.setInterval(() => this.duckTick(), 80);
    }
    return { ctx, gain: this.gain };
  }

  /** A notification is about to sound: lower the music for that long. */
  duck(ms: number) {
    this.duckUntil = Math.max(this.duckUntil, performance.now() + ms);
    this.duckTick();
  }

  private voiceAt = 0;
  private target = LEVEL;
  /** True while a stop fades the music out: ducking must not bring it back up. */
  private fading = false;
  private duckTick() {
    const g = this.gain;
    if (!g || !audio.ctx || this.fading) return;
    const now = performance.now();
    const voice = audio.speaking || !!useApp.getState().studio?.speaking || ("speechSynthesis" in window && speechSynthesis.speaking);
    if (voice) this.voiceAt = now;
    const down = voice || now < this.duckUntil || now - this.voiceAt < HOLD_MS;
    const target = down ? DUCKED : LEVEL;
    if (target === this.target) return;
    this.target = target;
    g.gain.cancelScheduledValues(audio.ctx.currentTime);
    g.gain.setTargetAtTime(target, audio.ctx.currentTime, down ? DOWN : UP);
  }

  private stopSource() {
    const s = this.src;
    this.src = null;
    this.playing = null;
    if (!s) return;
    s.onended = null;
    try {
      s.stop();
    } catch {
      /* not started */
    }
  }

  /** Follow the server: play the track on air from where it should be, or stop. */
  /** Playing or about to, on the current episode audio. */
  get busy() {
    return !!this.gain && this.gain.context === audio.ctx && !!(this.playing || this.loading);
  }

  async sync(r: RadioState | undefined) {
    if (!r?.on || !r.track) {
      this.loading = null;
      if (this.src && this.gain && audio.ctx) {
        // Fade out instead of cutting.
        const s = this.src;
        s.onended = null;
        this.fading = true;
        this.gain.gain.cancelScheduledValues(audio.ctx.currentTime);
        this.gain.gain.setTargetAtTime(0, audio.ctx.currentTime, 0.25);
        this.src = null;
        this.playing = null;
        window.setTimeout(() => {
          try {
            s.stop();
          } catch {
            /* ended */
          }
          this.fading = false;
          this.target = -1; // re-apply the right level on the next tick
        }, 1200);
      } else this.stopSource();
      return;
    }
    const track = r.track;
    if (this.playing === track.id || this.loading === track.id) return;
    const o = this.out();
    if (!o) return; // no episode audio yet: picked up on the next state
    this.loading = track.id;
    try {
      const buf = await o.ctx.decodeAudioData(await (await fetch(track.url, { credentials: "same-origin" })).arrayBuffer());
      if (this.loading !== track.id) return;
      const now = useApp.getState().studio?.radio;
      if (!now?.on || now.track?.id !== track.id) return; // changed while loading
      if (!track.durationSec) link.send({ t: "radio.meta", trackId: track.id, durationSec: buf.duration });
      this.stopSource();
      const offset = Math.max(0, (Date.now() - r.startedAt) / 1000);
      if (offset >= buf.duration - 1) return void link.send({ t: "radio.ended", trackId: track.id });
      const src = o.ctx.createBufferSource();
      src.buffer = buf;
      src.connect(o.gain);
      src.onended = () => {
        if (this.src !== src) return;
        this.src = null;
        this.playing = null;
        link.send({ t: "radio.ended", trackId: track.id });
      };
      this.fading = false;
      this.target = -1;
      src.start(o.ctx.currentTime + 0.05, offset > 2 ? offset : 0);
      this.src = src;
      this.playing = track.id;
      this.duckTick();
    } catch (e) {
      useApp.getState().error(`Radio : ${(e as Error).message}`);
      link.send({ t: "radio.ended", trackId: track.id }); // skip a broken file
    } finally {
      if (this.loading === track.id) this.loading = null;
    }
  }
}

export const radio = new Radio();

// A line is about to be spoken: duck at once, before its audio arrives (then `audio.speaking` holds it down).
const said = link.handlers.say;
link.handlers.say = (id, text, hasAudio) => {
  radio.duck(1500 + text.length * 60);
  said?.(id, text, hasAudio);
};

useApp.subscribe((s, prev) => {
  const r = s.studio?.radio;
  const p = prev.studio?.radio;
  // Re-sync when what is on air changes, and when the episode audio appears (start tap, rejoin).
  if (r?.on !== p?.on || r?.track?.id !== p?.track?.id || r?.startedAt !== p?.startedAt || (r?.on && audio.ctx && !radio.busy)) void radio.sync(r);
});
