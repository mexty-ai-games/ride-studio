import { MIC_RATE, TTS_RATE } from "../../shared/protocol";
import { link } from "./link";
import { useApp } from "./store";

// Runs on the audio thread: resample the mic to 16 kHz mono PCM16 and post 80 ms chunks with their RMS level.
const WORKLET = `
class Capture extends AudioWorkletProcessor {
  constructor() { super(); this.ratio = sampleRate / ${MIC_RATE}; this.pos = 0; this.out = new Int16Array(1280); this.n = 0; this.sq = 0; this.prev = 0; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    for (;;) {
      const i = Math.floor(this.pos);
      if (i >= ch.length) break;
      const a = i === 0 ? this.prev : ch[i - 1], b = ch[i];
      const s = a + (b - a) * (this.pos - i);
      this.sq += s * s;
      this.out[this.n++] = Math.max(-32768, Math.min(32767, s * 32767));
      if (this.n === this.out.length) {
        const copy = this.out.slice();
        this.port.postMessage({ pcm: copy, rms: Math.sqrt(this.sq / this.n) }, [copy.buffer]);
        this.n = 0; this.sq = 0;
      }
      this.pos += this.ratio;
    }
    this.pos -= ch.length;
    this.prev = ch[ch.length - 1];
    return true;
  }
}
registerProcessor("rs-capture", Capture);`;

/**
 * The voice loop on the phone. One mic stream feeds both the transcription socket and the recording mix;
 * Claude's voice plays through WebAudio to the headset and into the same mix.
 */
class AudioEngine {
  ctx: AudioContext | null = null;
  media: MediaStream | null = null;
  private mixDest: MediaStreamAudioDestinationNode | null = null;
  private ttsGain: GainNode | null = null;
  micAnalyser: AnalyserNode | null = null;
  ttsAnalyser: AnalyserNode | null = null;
  private nextTime = 0;
  private sources = new Set<AudioBufferSourceNode>();
  private loud = 0;
  private muteUntil = 0;
  /** 0..1 from Settings: how easily the rider's voice stops Claude. */
  bargeIn = 0.5;
  micLevel = 0;
  private wake: WakeLockSentinel | null = null;

  get mixStream() {
    return this.mixDest?.stream ?? null;
  }
  get speaking() {
    return !!this.ctx && this.nextTime > this.ctx.currentTime + 0.02;
  }

  /** Must be called from a tap: asks for mic and camera, builds the graph. */
  async start(withCamera: boolean): Promise<MediaStream> {
    if (this.media && this.ctx) return this.media;
    const media = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
      video: withCamera ? { facingMode: "user", width: { ideal: 720 }, height: { ideal: 960 }, frameRate: { ideal: 30 } } : false,
    });
    const ctx = new AudioContext({ latencyHint: "interactive" });
    await ctx.resume();
    await ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([WORKLET], { type: "application/javascript" })));
    const mic = ctx.createMediaStreamSource(new MediaStream(media.getAudioTracks()));
    const capture = new AudioWorkletNode(ctx, "rs-capture", { numberOfInputs: 1, numberOfOutputs: 0 });
    capture.port.onmessage = (e: MessageEvent<{ pcm: Int16Array; rms: number }>) => this.onMic(e.data.pcm, e.data.rms);
    mic.connect(capture);
    this.capture = capture;
    this.mixDest = ctx.createMediaStreamDestination();
    // What guests hear: the rider and Claude (and the sounds), never their own voices back.
    this.hostOut = ctx.createMediaStreamDestination();
    mic.connect(this.hostOut);
    this.micAnalyser = ctx.createAnalyser();
    this.micAnalyser.fftSize = 256;
    mic.connect(this.micAnalyser);
    this.pitchAnalyser = ctx.createAnalyser();
    this.pitchAnalyser.fftSize = 2048;
    mic.connect(this.pitchAnalyser);
    this.voiceTimer = window.setInterval(() => this.sampleVoices(), 100);
    mic.connect(this.mixDest);
    this.ttsGain = ctx.createGain();
    this.ttsAnalyser = ctx.createAnalyser();
    this.ttsAnalyser.fftSize = 256;
    this.ttsGain.connect(this.ttsAnalyser);
    this.ttsGain.connect(ctx.destination);
    this.ttsGain.connect(this.mixDest);
    this.ttsGain.connect(this.hostOut);
    this.ctx = ctx;
    this.media = media;
    try {
      this.wake = await navigator.wakeLock?.request("screen");
      document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && void navigator.wakeLock?.request("screen").then((w) => (this.wake = w)).catch(() => {}));
    } catch {
      /* not supported */
    }
    return media;
  }

  private onMic(pcm: Int16Array, rms: number) {
    this.micLevel = rms;
    link.mic(pcm);
    // Barge-in: sustained voice while Claude is speaking stops her at once, locally, before the server knows.
    const threshold = 0.12 - 0.1 * this.bargeIn;
    if (this.speaking && performance.now() > this.muteUntil) {
      this.loud = rms > threshold ? this.loud + 1 : 0;
      if (this.loud >= 3) {
        this.loud = 0;
        this.cancelTts();
        link.send({ t: "bargein" });
      }
    } else this.loud = 0;
  }

  /** Route notification sounds to the headset and into the recording, like Claude's voice. */
  connectCue(node: AudioNode) {
    if (!this.ctx || !this.mixDest) return;
    node.connect(this.ctx.destination);
    node.connect(this.mixDest);
    if (this.hostOut) node.connect(this.hostOut);
  }

  private capture: AudioWorkletNode | null = null;
  private pitchAnalyser: AnalyserNode | null = null;
  private remotes = new Map<AnalyserNode, string>();
  private voiceFrames: { ts: number; src: string; f0?: number }[] = [];
  private voiceTimer: number | null = null;
  private voiceSent = 0;
  private buf = new Float32Array(2048);

  /**
   * Who is speaking, ten times a second: the loudest source (the rider's mic or a guest's stream) and, on the mic,
   * the pitch of the voice. The server matches each turn to a person with it (server/src/speakers.ts).
   */
  private sampleVoices() {
    const ctx = this.ctx;
    if (!ctx || !this.pitchAnalyser) return;
    const now = Date.now();
    let src = "", loud = 0.02, f0: number | undefined;
    if (!this.muted) {
      this.pitchAnalyser.getFloatTimeDomainData(this.buf);
      const rms = rmsOf(this.buf);
      if (rms > loud) {
        loud = rms;
        src = "mic";
        f0 = pitchOf(this.buf, ctx.sampleRate);
      }
    }
    for (const [an, name] of this.remotes) {
      const b = new Float32Array(an.fftSize);
      an.getFloatTimeDomainData(b);
      const rms = rmsOf(b);
      if (rms > loud * 1.1) {
        loud = rms;
        src = name;
        f0 = undefined;
      }
    }
    if (src) this.voiceFrames.push({ ts: now, src, ...(f0 ? { f0: Math.round(f0) } : {}) });
    if (this.voiceFrames.length && now - this.voiceSent >= 500) {
      this.voiceSent = now;
      link.send({ t: "voice", now, frames: this.voiceFrames.splice(0, 40) });
      this.voiceFrames.length = 0;
    }
  }
  hostOut: MediaStreamAudioDestinationNode | null = null;

  /**
   * A guest's voice: in the headset, in the recording, and into the transcription, so Claude hears the guest
   * exactly as it hears the rider. Returns the function that removes it.
   */
  addRemote(stream: MediaStream, name = "Invité"): () => void {
    const ctx = this.ctx;
    if (!ctx || !this.mixDest || !this.capture) return () => {};
    // Chrome only feeds a remote WebRTC stream into WebAudio while a media element plays it.
    const el = new Audio();
    el.muted = true;
    el.srcObject = stream;
    void el.play().catch(() => {});
    const src = ctx.createMediaStreamSource(stream);
    src.connect(ctx.destination);
    src.connect(this.mixDest);
    src.connect(this.capture);
    const an = ctx.createAnalyser();
    an.fftSize = 1024;
    src.connect(an);
    this.remotes.set(an, name);
    return () => {
      this.remotes.delete(an);
      src.disconnect();
      el.srcObject = null;
    };
  }

  /**
   * The rider's mic, off: silence everywhere at once — for guests on the call, in the recording and for Claude,
   * who stops hearing the rider until it is back on. Claude's voice and the guests' keep playing.
   */
  get muted() {
    return !!this.media && this.media.getAudioTracks().every((t) => !t.enabled);
  }
  setMuted(on: boolean) {
    this.media?.getAudioTracks().forEach((t) => (t.enabled = !on));
    useApp.getState().set({ micMuted: on });
  }

  playTts(pcm: Int16Array) {
    const ctx = this.ctx;
    if (!ctx || !this.ttsGain || pcm.length === 0) return;
    const buf = ctx.createBuffer(1, pcm.length, TTS_RATE);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < pcm.length; i++) ch[i] = pcm[i] / 32768;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.ttsGain);
    if (this.nextTime < ctx.currentTime + 0.03) {
      this.nextTime = ctx.currentTime + 0.05;
      this.muteUntil = performance.now() + 350; // ignore the first instants: echo cancellation is still converging
    }
    src.start(this.nextTime);
    this.nextTime += buf.duration;
    this.sources.add(src);
    src.onended = () => this.sources.delete(src);
  }

  cancelTts() {
    for (const s of this.sources) {
      try {
        s.stop();
      } catch {
        /* already ended */
      }
    }
    this.sources.clear();
    this.nextTime = 0;
    speechSynthesis?.cancel();
  }

  /** No ElevenLabs key: the device's own voice, audible to the rider but not part of the recording. */
  fallbackSpeak(text: string) {
    if (!("speechSynthesis" in window)) return;
    const u = new SpeechSynthesisUtterance(text);
    u.lang = "fr-FR";
    u.rate = 1.05;
    speechSynthesis.speak(u);
  }

  levels(analyser: AnalyserNode | null, bars: number, out: number[]) {
    if (!analyser) return out.fill(0.08);
    const data = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteFrequencyData(data);
    const step = Math.floor(data.length / 1.6 / bars) || 1;
    for (let i = 0; i < bars; i++) {
      let m = 0;
      for (let j = 0; j < step; j++) m = Math.max(m, data[i * step + j]);
      out[i] = Math.max(0.08, m / 255);
    }
    return out;
  }

  stop() {
    useApp.getState().set({ micMuted: false });
    if (this.voiceTimer) clearInterval(this.voiceTimer);
    this.voiceTimer = null;
    this.remotes.clear();
    this.cancelTts();
    this.media?.getTracks().forEach((t) => t.stop());
    void this.ctx?.close();
    void this.wake?.release().catch(() => {});
    this.ctx = null;
    this.media = null;
    this.mixDest = null;
    this.hostOut = null;
    this.capture = null;
  }
}

const rmsOf = (b: Float32Array) => {
  let s = 0;
  for (let i = 0; i < b.length; i++) s += b[i] * b[i];
  return Math.sqrt(s / b.length);
};

/** Pitch of a voiced frame (70–400 Hz) by autocorrelation on a 4× decimated copy; undefined when unvoiced. */
function pitchOf(b: Float32Array, rate: number): number | undefined {
  const step = 4, r = rate / step, n = Math.floor(b.length / step);
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = (b[i * step] + b[i * step + 1] + b[i * step + 2] + b[i * step + 3]) / 4;
  const minLag = Math.floor(r / 400), maxLag = Math.min(n - 32, Math.ceil(r / 70));
  let e0 = 0;
  for (let i = 0; i < n; i++) e0 += x[i] * x[i];
  if (!e0) return undefined;
  let best = 0, lag = 0;
  for (let l = minLag; l <= maxLag; l++) {
    let c = 0, e = 0;
    for (let i = 0; i + l < n; i++) {
      c += x[i] * x[i + l];
      e += x[i + l] * x[i + l];
    }
    const v = c / Math.sqrt(e0 * e || 1);
    if (v > best) (best = v), (lag = l);
  }
  return best > 0.55 && lag ? r / lag : undefined;
}

export const audio = new AudioEngine();

link.handlers.tts = (_id, pcm) => audio.playTts(pcm);
link.handlers.ttsCancel = () => audio.cancelTts();
link.handlers.say = (_id, text, hasAudio) => {
  if (!hasAudio && useApp.getState().screen === "live") audio.fallbackSpeak(text);
};
