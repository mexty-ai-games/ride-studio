import type { ChangeEvent, Entity } from "../../shared/protocol";
import { audio } from "./audio";
import { link } from "./link";
import { radio } from "./radio";

/**
 * Bird notes for progress. Every note belongs to one pentatonic scale (C D E G A), so whatever fires,
 * alone or on top of another content being built in parallel, stays in tune; notes are placed on a
 * short rhythmic grid so the whole episode adds up to a little song instead of random beeps.
 *
 * Each kind of content is its own bird: a different gesture and register.
 */
const SCALE = [0, 2, 4, 7, 9]; // semitones above C
const C6 = 1046.5;
/** Frequency of scale degree `d` (0 = C6, 5 = C7, negative = below). */
const hz = (d: number) => C6 * 2 ** ((12 * Math.floor(d / 5) + SCALE[((d % 5) + 5) % 5]) / 12);

const GRID = 0.14; // seconds between two notes
const VOLUME = 0.2;
const AMBIENCE = 0.35; // relative to the notes: present, never in the way of the voices

type Voice = "chirp" | "whistle" | "trill" | "peck" | "coo";
const BIRD: Record<Entity, { voice: Voice; base: number }> = {
  course: { voice: "chirp", base: 0 }, // bright sparrow chirp
  evaluation: { voice: "peck", base: 2 }, // quick repeated notes, a little higher
  program: { voice: "whistle", base: 0 }, // long gliding blackbird whistle
  block: { voice: "trill", base: 3 }, // robin trill
  scene: { voice: "coo", base: -5 }, // low dove coo
};
/** The tune a content walks through as its screens, questions or steps arrive. */
const WALK = [0, 2, 3, 5, 7, 5, 3, 2, 4, 5, 7, 8, 7, 5, 4, 2];

class Birds {
  private out: GainNode | null = null;
  private nextSlot = 0;
  private count = new Map<string, number>(); // items heard per content
  private open = new Map<string, string>(); // content → item currently being built
  enabled = true;

  private node(): { ctx: AudioContext; out: GainNode } | null {
    const ctx = audio.ctx;
    if (!ctx || !this.enabled) return null;
    if (!this.out || this.out.context !== ctx) {
      this.out = ctx.createGain();
      this.out.gain.value = VOLUME;
      audio.connectCue(this.out);
      this.nextSlot = 0;
    }
    return { ctx, out: this.out };
  }

  /** Reserve the next free beats on the grid, so overlapping events become rhythm. */
  private slot(ctx: AudioContext, beats: number): number {
    const t = Math.max(ctx.currentTime + 0.03, this.nextSlot);
    this.nextSlot = t + beats * GRID;
    return t;
  }

  /** One bird note: a sine with a fast pitch swoop that lands exactly on the scale note. */
  private note(ctx: AudioContext, out: GainNode, t: number, degree: number, voice: Voice, gain = 1, dur = 0.12) {
    const f = hz(degree);
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = "sine";
    osc.connect(g).connect(out);
    const p = osc.frequency;
    if (voice === "chirp") {
      p.setValueAtTime(f * 1.4, t);
      p.exponentialRampToValueAtTime(f, t + 0.035);
    } else if (voice === "peck") {
      dur = 0.07;
      p.setValueAtTime(f * 0.85, t);
      p.exponentialRampToValueAtTime(f, t + 0.02);
    } else if (voice === "whistle") {
      dur = Math.max(dur, 0.26);
      p.setValueAtTime(f * 0.94, t);
      p.exponentialRampToValueAtTime(f, t + 0.09);
    } else if (voice === "trill") {
      // Flutter between the note and the next scale degree.
      dur = Math.max(dur, 0.24);
      const up = hz(degree + 1);
      for (let i = 0; i * 0.03 < dur; i++) p.setValueAtTime(i % 2 ? up : f, t + i * 0.03);
    } else {
      dur = Math.max(dur, 0.3);
      p.setValueAtTime(f * 1.12, t);
      p.exponentialRampToValueAtTime(f, t + 0.12);
    }
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }

  private phrase(entity: Entity, degrees: number[], gain = 1) {
    const n = this.node();
    if (!n) return;
    const { voice, base } = BIRD[entity];
    const t = this.slot(n.ctx, degrees.length + 1);
    radio.duck((t - n.ctx.currentTime + (degrees.length + 2) * GRID) * 1000);
    degrees.forEach((d, i) => this.note(n.ctx, n.out, t + i * GRID, base + d, voice, gain));
  }

  /** A content begins: a rising call (root, then the fifth). */
  started(entity: Entity) {
    this.phrase(entity, [0, 3]);
  }
  /** A content is complete: a cadence that comes home to the high tonic. */
  finished(entity: Entity, key: string | null) {
    if (key) this.open.delete(key);
    this.phrase(entity, [4, 3, 5]);
  }

  /** A screen, question, step or object was added: the next note of that content's tune. */
  change(ev: ChangeEvent, slot: number | null) {
    const item = ev.path.slideId ?? ev.path.stepId ?? ev.path.nodeId ?? ev.path.objectId;
    if (!item || ev.op === "delete" || ev.op === "reorder") return;
    const key = `${ev.entity}:${ev.entityId}`;
    const previous = this.open.get(key);
    if (previous === item) return; // more elements on the same item: stay quiet
    const n = this.node();
    if (!n) return;
    const { voice, base } = BIRD[ev.entity];
    const i = this.count.get(key) ?? 0;
    this.count.set(key, i + 1);
    this.open.set(key, item);
    // Contents built side by side sing a third apart.
    const harmony = (slot ?? 0) * 2;
    const t = this.slot(n.ctx, previous ? 2 : 1);
    radio.duck((t - n.ctx.currentTime + 4 * GRID) * 1000);
    // The item that was being built is done: a soft low note first, then the new one.
    if (previous) this.note(n.ctx, n.out, t, base + harmony - 5 + (WALK[(i - 1) % WALK.length] % 5), voice, 0.45, 0.07);
    this.note(n.ctx, n.out, t + (previous ? GRID : 0), base + harmony + WALK[i % WALK.length], voice);
  }

  reset() {
    this.count.clear();
    this.open.clear();
  }

  private ambience: AudioBuffer | null = null;
  private ambienceTimer = 0;
  /**
   * A very quiet bed of real birdsong under the notes (generated once with ElevenLabs, shipped with the app).
   * Looped by overlapping two copies with a crossfade, so there is no audible seam.
   */
  async startAmbience() {
    const n = this.node();
    if (!n) return;
    try {
      this.ambience ??= await n.ctx.decodeAudioData(await (await fetch("/birds-ambience.mp3")).arrayBuffer());
    } catch {
      return; // the notes work without it
    }
    const buf = this.ambience;
    const FADE = 2.5;
    const bed = n.ctx.createGain();
    bed.gain.value = AMBIENCE;
    bed.connect(n.out);
    const play = (at: number) => {
      if (audio.ctx !== n.ctx) return; // the episode ended
      const src = n.ctx.createBufferSource();
      const g = n.ctx.createGain();
      src.buffer = buf;
      src.connect(g).connect(bed);
      g.gain.setValueAtTime(0, at);
      g.gain.linearRampToValueAtTime(1, at + FADE);
      g.gain.setValueAtTime(1, at + buf.duration - FADE);
      g.gain.linearRampToValueAtTime(0, at + buf.duration);
      src.start(at);
      const next = at + buf.duration - FADE;
      this.ambienceTimer = window.setTimeout(() => play(next), Math.max(0, (next - n.ctx.currentTime - 1) * 1000));
    };
    window.clearTimeout(this.ambienceTimer);
    play(n.ctx.currentTime + 0.1);
  }
}

export const birds = new Birds();

link.handlers.cue = (kind, entity) => (kind === "started" ? birds.started(entity) : birds.finished(entity, null));
link.handlers.change = (event, slot) => birds.change(event, slot);
