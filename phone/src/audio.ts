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
    this.mixDest = ctx.createMediaStreamDestination();
    this.micAnalyser = ctx.createAnalyser();
    this.micAnalyser.fftSize = 256;
    mic.connect(this.micAnalyser);
    mic.connect(this.mixDest);
    this.ttsGain = ctx.createGain();
    this.ttsAnalyser = ctx.createAnalyser();
    this.ttsAnalyser.fftSize = 256;
    this.ttsGain.connect(this.ttsAnalyser);
    this.ttsGain.connect(ctx.destination);
    this.ttsGain.connect(this.mixDest);
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
    this.cancelTts();
    this.media?.getTracks().forEach((t) => t.stop());
    void this.ctx?.close();
    void this.wake?.release().catch(() => {});
    this.ctx = null;
    this.media = null;
    this.mixDest = null;
  }
}

export const audio = new AudioEngine();

link.handlers.tts = (_id, pcm) => audio.playTts(pcm);
link.handlers.ttsCancel = () => audio.cancelTts();
link.handlers.say = (_id, text, hasAudio) => {
  if (!hasAudio && useApp.getState().screen === "live") audio.fallbackSpeak(text);
};
