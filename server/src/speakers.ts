/**
 * Who is speaking, so Claude knows whom to answer.
 *
 * - A guest on the shared ride speaks on their own WebRTC stream: the phone measures each stream's level, so a
 *   turn is theirs when their stream carried it.
 * - Several people at the rider's mic: each turn's median pitch (measured on the phone) is matched against the
 *   voices heard so far. The rider's voice is learnt from the first turns; a voice far from every known one is
 *   "une autre voix" until Claude learns its name (name_speaker). When the transcription separates voices
 *   (Deepgram Nova), its speaker index is used first.
 * Pitch tells a low voice from a high one well, two similar voices badly: it is a hint, not an identity.
 */
export interface VoiceFrame {
  ts: number; // server time
  src: string; // "mic" or a guest's name
  f0?: number; // Hz, mic frames with a clear pitch
}
interface Voice {
  name: string;
  f0: number; // running median-ish of the turns' pitch
  n: number;
  dg?: number;
}
export interface Speaker {
  name: string;
  /** Fabien himself. */
  rider: boolean;
  /** A guest on their own stream. */
  guest: boolean;
  /** A voice at the rider's mic nobody has named yet. */
  unknown: boolean;
}

const TOLERANCE = 0.2; // a voice within ±20 % of a known pitch is that voice
const SEED_TURNS = 3; // the rider's first turns teach his pitch

const median = (a: number[]) => {
  const s = [...a].sort((x, y) => x - y);
  return s.length ? s[Math.floor(s.length / 2)] : NaN;
};

export class Speakers {
  private frames: VoiceFrame[] = [];
  private voices: Voice[] = [{ name: "Fabien", f0: 0, n: 0 }];
  private lastTurnAt = 0;
  private lastUnknown: { f0?: number; dg?: number } | null = null;
  private last: Speaker = { name: "Fabien", rider: true, guest: false, unknown: false };

  constructor(private rider = "Fabien") {
    this.voices[0].name = rider;
  }

  add(frames: VoiceFrame[]) {
    this.frames.push(...frames);
    const cut = Date.now() - 60_000;
    if (this.frames.length > 3000 || this.frames[0]?.ts < cut) this.frames = this.frames.filter((f) => f.ts >= cut).slice(-3000);
  }

  /** A new episode: guests and other voices are forgotten, the rider's voice is kept. */
  reset() {
    this.voices = this.voices.slice(0, 1);
    this.voices[0].dg = undefined;
    this.lastUnknown = null;
    this.frames = [];
  }

  /** Who said the turn that just ended. */
  identify(o: { dgSpeaker?: number } = {}): Speaker {
    const end = Date.now();
    const start = Math.max(this.lastTurnAt, end - 15_000);
    this.lastTurnAt = end;
    const win = this.frames.filter((f) => f.ts >= start - 500 && f.ts <= end);
    const by = new Map<string, number>();
    for (const f of win) by.set(f.src, (by.get(f.src) ?? 0) + 1);
    let guest: string | null = null, top = 0;
    for (const [src, n] of by) if (src !== "mic" && n > top) (guest = src), (top = n);
    // A guest's own stream carried most of the speech: it is them.
    if (guest && top >= Math.max(3, (by.get("mic") ?? 0) * 1.2)) return (this.last = { name: guest, rider: false, guest: true, unknown: false });

    const pitches = win.filter((f) => f.src === "mic" && f.f0).map((f) => f.f0!);
    const f0 = pitches.length >= 4 ? median(pitches) : NaN;
    const rider = this.voices[0];

    if (o.dgSpeaker != null) {
      const known = this.voices.find((v) => v.dg === o.dgSpeaker);
      if (known) return this.found(known, f0);
      // The first voice Deepgram hears is the rider's.
      if (rider.dg == null && !this.voices.some((v) => v.dg != null)) {
        rider.dg = o.dgSpeaker;
        return this.found(rider, f0);
      }
      this.lastUnknown = { f0: Number.isFinite(f0) ? f0 : undefined, dg: o.dgSpeaker };
      return (this.last = { name: "une autre voix", rider: false, guest: false, unknown: true });
    }

    // No pitch (wind, a whisper): the same person as before, the rider by default.
    if (!Number.isFinite(f0)) return this.last.guest ? (this.last = { name: rider.name, rider: true, guest: false, unknown: false }) : this.last;
    if (rider.n < SEED_TURNS) return this.found(rider, f0);

    let best: Voice | null = null, gap = Infinity;
    for (const v of this.voices) {
      if (!v.n) continue;
      const d = Math.abs(f0 - v.f0) / v.f0;
      if (d < gap) (gap = d), (best = v);
    }
    if (best && gap <= TOLERANCE) return this.found(best, f0);
    this.lastUnknown = { f0 };
    return (this.last = { name: "une autre voix", rider: false, guest: false, unknown: true });
  }

  /** Claude learnt the name of the last unknown voice ("je m'appelle Marie"). */
  name(name: string): string {
    const clean = name.replace(/[^\p{L}\p{N} '\-]/gu, "").trim().slice(0, 30);
    if (!clean) return "Erreur : prénom manquant.";
    if (!this.lastUnknown) return "Aucune autre voix entendue récemment.";
    const v = this.voices.find((x) => x.name.toLowerCase() === clean.toLowerCase()) ?? { name: clean, f0: 0, n: 0 };
    if (!this.voices.includes(v)) this.voices.push(v);
    if (this.lastUnknown.dg != null) v.dg = this.lastUnknown.dg;
    if (this.lastUnknown.f0) this.learn(v, this.lastUnknown.f0);
    this.lastUnknown = null;
    this.last = { name: v.name, rider: v === this.voices[0], guest: false, unknown: false };
    return `D'accord : cette voix, c'est ${v.name}.`;
  }

  private found(v: Voice, f0: number): Speaker {
    if (Number.isFinite(f0)) this.learn(v, f0);
    return (this.last = { name: v.name, rider: v === this.voices[0], guest: false, unknown: false });
  }
  private learn(v: Voice, f0: number) {
    v.f0 = v.n ? v.f0 + (f0 - v.f0) / Math.min(v.n + 1, 10) : f0;
    v.n++;
  }
}
