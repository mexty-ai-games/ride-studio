import WebSocket from "ws";
import type { Settings } from "../store.js";

export type SttVendor = "elevenlabs" | "deepgram" | "openai";
export interface SttEvent {
  kind: "open" | "partial" | "final" | "eot" | "error" | "close";
  text?: string;
  ts: number;
}
/** One streaming transcription. `final` = a committed segment; `eot` = the vendor says the turn is over (text = whole turn). */
export interface SttSession {
  vendor: SttVendor;
  send(pcm16k: Buffer): void;
  close(): void;
}
export type SttHandler = (e: SttEvent) => void;

/** Rough list prices in USD per minute of streamed audio (silence is billed). Used by the budget guard only. */
export const STT_PRICE_PER_MIN: Record<SttVendor, number> = { elevenlabs: 0.22 / 60, deepgram: 0.0078, openai: 0.0045 };

interface Opts {
  apiKey: string;
  voice: Settings["voice"];
  on: SttHandler;
}

const now = () => Date.now();

/** Shared plumbing: queue audio until the socket is ready, surface errors once, never throw into the caller. */
function socket(vendor: SttVendor, url: string, headers: Record<string, string>, on: SttHandler, hooks: { ready?: (ws: WebSocket) => void; message: (data: WebSocket.RawData, isBinary: boolean) => void }) {
  const ws = new WebSocket(url, { headers });
  let closed = false;
  ws.on("open", () => hooks.ready?.(ws));
  ws.on("message", (d, bin) => {
    try {
      hooks.message(d, bin);
    } catch (e) {
      on({ kind: "error", text: `${vendor}: ${(e as Error).message}`, ts: now() });
    }
  });
  ws.on("unexpected-response", (_req, res) => on({ kind: "error", text: `${vendor}: HTTP ${res.statusCode}`, ts: now() }));
  ws.on("error", (e) => on({ kind: "error", text: `${vendor}: ${e.message}`, ts: now() }));
  ws.on("close", () => {
    if (!closed) on({ kind: "close", ts: now() });
    closed = true;
  });
  return {
    ws,
    close(lastWords?: () => void) {
      closed = true;
      try {
        if (ws.readyState === WebSocket.OPEN) lastWords?.();
        ws.close();
      } catch {
        /* already gone */
      }
    },
  };
}

// ElevenLabs Scribe (v3 Live: semantic turn prediction commits the turn; v2 falls back to VAD commits).
function elevenlabs({ apiKey, voice, on }: Opts): SttSession {
  const model = voice.sttModels.elevenlabs;
  const q = new URLSearchParams({
    model_id: model,
    audio_format: "pcm_16000",
    commit_strategy: model === "scribe_v3_live" ? "turn_prediction" : "vad",
    language_code: voice.language,
    vad_silence_threshold_secs: "1.2",
  });
  let ready = false;
  const pending: Buffer[] = [];
  const s = socket("elevenlabs", `wss://api.elevenlabs.io/v1/speech-to-text/realtime?${q}`, { "xi-api-key": apiKey }, on, {
    message(d) {
      const m = JSON.parse(d.toString()) as { message_type: string; text?: string; error?: string };
      if (m.message_type === "session_started") {
        ready = true;
        on({ kind: "open", ts: now() });
        for (const b of pending.splice(0)) push(b);
      } else if (m.message_type === "partial_transcript") {
        if (m.text) on({ kind: "partial", text: m.text, ts: now() });
      } else if (m.message_type === "committed_transcript") {
        // The commit IS the end-of-turn signal on this API.
        if (m.text?.trim()) {
          on({ kind: "final", text: m.text.trim(), ts: now() });
          on({ kind: "eot", text: m.text.trim(), ts: now() });
        }
      } else if (m.error || /error|exceeded|limited|overflow|exhausted/.test(m.message_type)) {
        on({ kind: "error", text: `elevenlabs: ${m.message_type} ${m.error ?? ""}`.trim(), ts: now() });
      }
    },
  });
  const push = (pcm: Buffer) => s.ws.send(JSON.stringify({ message_type: "input_audio_chunk", audio_base_64: pcm.toString("base64"), commit: false, sample_rate: 16000 }));
  return {
    vendor: "elevenlabs",
    send(pcm) {
      if (ready && s.ws.readyState === WebSocket.OPEN) push(pcm);
      else if (pending.length < 100) pending.push(pcm);
    },
    close: () => s.close(() => s.ws.send(JSON.stringify({ message_type: "input_audio_chunk", audio_base_64: "", commit: true, sample_rate: 16000 }))),
  };
}

// Deepgram: Flux (/v2, model-driven EndOfTurn) or Nova-3 (/v1, endpointing + UtteranceEnd).
function deepgram({ apiKey, voice, on }: Opts): SttSession {
  const model = voice.sttModels.deepgram;
  const flux = model.startsWith("flux");
  const q = new URLSearchParams({ model, encoding: "linear16", sample_rate: "16000" });
  if (flux) {
    q.set("eot_threshold", "0.7");
    q.set("eot_timeout_ms", "4000");
    if (model.endsWith("multi")) for (const l of new Set([voice.language, "en"])) q.append("language_hint", l);
    for (const k of voice.languageHints.slice(0, 20)) q.append("keyterm", k);
  } else {
    q.set("language", voice.language);
    q.set("channels", "1");
    q.set("interim_results", "true");
    q.set("endpointing", "300");
    q.set("utterance_end_ms", "1000");
    q.set("smart_format", "true");
  }
  let turn = ""; // Nova: finals accumulated until the endpoint
  let spoke = false;
  let ka: NodeJS.Timeout | null = null;
  const s = socket("deepgram", `wss://api.deepgram.com/${flux ? "v2" : "v1"}/listen?${q}`, { Authorization: `Token ${apiKey}` }, on, {
    ready(ws) {
      on({ kind: "open", ts: now() });
      if (!flux) ka = setInterval(() => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ type: "KeepAlive" })), 4000);
    },
    message(d) {
      const m = JSON.parse(d.toString()) as Record<string, any>;
      if (m.type === "TurnInfo") {
        const text = String(m.transcript ?? "").trim();
        if (m.event === "EndOfTurn") {
          if (text) {
            on({ kind: "final", text, ts: now() });
            on({ kind: "eot", text, ts: now() });
          }
        } else if (text) on({ kind: "partial", text, ts: now() });
      } else if (m.type === "Results") {
        const text = String(m.channel?.alternatives?.[0]?.transcript ?? "").trim();
        if (m.is_final) {
          if (text) {
            turn = `${turn} ${text}`.trim();
            on({ kind: "final", text, ts: now() });
          }
          if (m.speech_final && turn) {
            on({ kind: "eot", text: turn, ts: now() });
            turn = "";
            spoke = true;
          }
        } else if (text) {
          spoke = false;
          on({ kind: "partial", text: `${turn} ${text}`.trim(), ts: now() });
        }
      } else if (m.type === "UtteranceEnd") {
        // Only an end of turn when no speech_final already closed it.
        if (!spoke && turn) on({ kind: "eot", text: turn, ts: now() });
        turn = "";
        spoke = false;
      } else if (m.type === "Error") on({ kind: "error", text: `deepgram: ${m.code} ${m.description}`, ts: now() });
    },
  });
  return {
    vendor: "deepgram",
    send(pcm) {
      if (s.ws.readyState === WebSocket.OPEN) s.ws.send(pcm);
    },
    close() {
      if (ka) clearInterval(ka);
      s.close(() => s.ws.send(JSON.stringify({ type: "CloseStream" })));
    },
  };
}

/** 16 kHz → 24 kHz PCM16 (linear interpolation; OpenAI only accepts 24 kHz PCM). */
export function upsample16to24(pcm: Buffer): Buffer {
  const n = pcm.length >> 1;
  const out = Buffer.alloc(Math.floor((n * 3) / 2) * 2);
  for (let i = 0; i < out.length >> 1; i++) {
    const pos = (i * 2) / 3;
    const a = Math.min(n - 1, Math.floor(pos));
    const b = Math.min(n - 1, a + 1);
    const f = pos - a;
    out.writeInt16LE(Math.round(pcm.readInt16LE(a * 2) * (1 - f) + pcm.readInt16LE(b * 2) * f), i * 2);
  }
  return out;
}

// OpenAI realtime transcription with semantic VAD (models that support server turn detection).
function openai({ apiKey, voice, on }: Opts): SttSession {
  const model = voice.sttModels.openai;
  const noVad = /live-transcribe|realtime-whisper/.test(model);
  const partial = new Map<string, string>();
  const s = socket("openai", "wss://api.openai.com/v1/realtime?intent=transcription", { Authorization: `Bearer ${apiKey}` }, on, {
    ready(ws) {
      const transcription: Record<string, unknown> = { model, prompt: voice.languageHints.join(", ") };
      if (/^gpt-(live-)?transcribe$/.test(model)) transcription.languages = [...new Set([voice.language, "en"])];
      else transcription.language = voice.language;
      ws.send(
        JSON.stringify({
          type: "session.update",
          session: {
            type: "transcription",
            audio: { input: { format: { type: "audio/pcm", rate: 24000 }, noise_reduction: { type: "near_field" }, transcription, turn_detection: noVad ? null : { type: "semantic_vad", eagerness: "high" } } },
          },
        }),
      );
      on({ kind: "open", ts: now() });
      if (noVad) on({ kind: "error", text: `openai: ${model} has no server turn detection — choose gpt-transcribe for hands-free turns`, ts: now() });
    },
    message(d) {
      const m = JSON.parse(d.toString()) as Record<string, any>;
      if (m.type === "conversation.item.input_audio_transcription.delta") {
        const t = (partial.get(m.item_id) ?? "") + (m.delta ?? "");
        partial.set(m.item_id, t);
        on({ kind: "partial", text: t, ts: now() });
      } else if (m.type === "conversation.item.input_audio_transcription.completed") {
        partial.delete(m.item_id);
        const text = String(m.transcript ?? "").trim();
        if (text) {
          on({ kind: "final", text, ts: now() });
          on({ kind: "eot", text, ts: now() });
        }
      } else if (m.type === "error" || m.type === "conversation.item.input_audio_transcription.failed") {
        on({ kind: "error", text: `openai: ${m.error?.message ?? m.type}`, ts: now() });
      }
    },
  });
  return {
    vendor: "openai",
    send(pcm) {
      if (s.ws.readyState === WebSocket.OPEN) s.ws.send(JSON.stringify({ type: "input_audio_buffer.append", audio: upsample16to24(pcm).toString("base64") }));
    },
    close: () => s.close(),
  };
}

const FACTORIES: Record<SttVendor, (o: Opts) => SttSession> = { elevenlabs, deepgram, openai };
export const STT_VENDORS = Object.keys(FACTORIES) as SttVendor[];
export function openStt(vendor: SttVendor, opts: Opts): SttSession {
  return FACTORIES[vendor](opts);
}
