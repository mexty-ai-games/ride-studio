import type { Settings } from "./store.js";

export const TTS_PRICE_PER_CHAR = 0.04 / 1000; // flash / v4-turbo list price

let cachedVoice: { key: string; id: string } | null = null;

/** Pick a French-verified voice once when Settings has none. */
async function resolveVoice(apiKey: string, voice: Settings["voice"]): Promise<string> {
  if (voice.ttsVoiceId) return voice.ttsVoiceId;
  const key = `${apiKey.slice(-6)}:${voice.language}`;
  if (cachedVoice?.key === key) return cachedVoice.id;
  let id = "JBFqnCBsd6RMkjVDRZzb"; // ElevenLabs quickstart default voice
  try {
    const r = await fetch("https://api.elevenlabs.io/v2/voices?page_size=100", { headers: { "xi-api-key": apiKey }, signal: AbortSignal.timeout(4000) });
    if (r.ok) {
      const j = (await r.json()) as { voices?: { voice_id: string; verified_languages?: { language: string }[] }[] };
      const fr = j.voices?.find((v) => v.verified_languages?.some((l) => l.language === voice.language));
      if (fr) id = fr.voice_id;
    }
  } catch {
    /* keep the default */
  }
  cachedVoice = { key, id };
  return id;
}

export async function listVoices(apiKey: string) {
  const r = await fetch("https://api.elevenlabs.io/v2/voices?page_size=100", { headers: { "xi-api-key": apiKey }, signal: AbortSignal.timeout(6000) });
  if (!r.ok) throw new Error(`ElevenLabs ${r.status}`);
  const j = (await r.json()) as { voices: { voice_id: string; name: string; verified_languages?: { language: string }[] }[] };
  return j.voices.map((v) => ({ id: v.voice_id, name: v.name, languages: [...new Set((v.verified_languages ?? []).map((l) => l.language))] }));
}

/**
 * Stream one sentence as raw PCM16 mono 24 kHz. Calls `onChunk` with even-length buffers.
 * Resolves when the audio is complete; rejects on HTTP errors; honours `signal` for barge-in.
 */
export async function streamTts(apiKey: string, voice: Settings["voice"], text: string, previous: string, signal: AbortSignal, onChunk: (pcm: Buffer) => void): Promise<void> {
  const voiceId = await resolveVoice(apiKey, voice);
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream?output_format=pcm_24000`, {
    method: "POST",
    headers: { "xi-api-key": apiKey, "Content-Type": "application/json" },
    // The reply's own language, so an English answer is spoken in English with the same voice.
    body: JSON.stringify({ text, model_id: voice.ttsModel, language_code: voice.multilingual ? guessLanguage(text) ?? voice.language : voice.language, previous_text: previous.slice(-300) || undefined }),
    signal,
  });
  if (!res.ok || !res.body) throw new Error(`ElevenLabs TTS ${res.status}: ${(await res.text()).slice(0, 200)}`);
  let carry: Buffer | null = null;
  for await (const part of res.body as unknown as AsyncIterable<Uint8Array>) {
    let buf = Buffer.from(part.buffer, part.byteOffset, part.byteLength);
    if (carry) {
      buf = Buffer.concat([carry, buf]);
      carry = null;
    }
    if (buf.length & 1) {
      carry = buf.subarray(buf.length - 1);
      buf = buf.subarray(0, buf.length - 1);
    }
    if (buf.length) onChunk(buf);
  }
}

const STOPWORDS: Record<string, string[]> = {
  fr: ["le", "la", "les", "de", "des", "du", "un", "une", "et", "est", "je", "tu", "nous", "vous", "pour", "pas", "que", "qui", "c'est", "ça", "sur", "avec", "dans", "terminé", "lancé", "compris", "parti"],
  en: ["the", "and", "is", "are", "you", "i", "we", "to", "of", "a", "it", "for", "on", "with", "that", "this", "done", "got", "let's", "your", "what", "how", "hello", "hi"],
  es: ["el", "los", "las", "y", "es", "está", "que", "de", "para", "con", "una", "por", "hola", "gracias", "vamos", "listo", "tú", "usted"],
  de: ["der", "die", "das", "und", "ist", "ich", "du", "wir", "nicht", "mit", "für", "ein", "eine", "hallo", "danke", "fertig"],
  it: ["il", "lo", "gli", "e", "è", "che", "di", "per", "con", "una", "sono", "ciao", "grazie", "fatto", "andiamo"],
  pt: ["o", "os", "as", "e", "é", "que", "de", "para", "com", "uma", "não", "olá", "obrigado", "pronto", "vamos"],
};
/** The language of a short reply, by its common words; null when unsure (the voice's language is used). */
export function guessLanguage(text: string): string | null {
  const words = text.toLowerCase().match(/[\p{L}']+/gu) ?? [];
  if (!words.length) return null;
  let best: string | null = null, top = 0, second = 0;
  for (const [lang, list] of Object.entries(STOPWORDS)) {
    const n = words.filter((w) => list.includes(w)).length;
    if (n > top) (second = top), (top = n), (best = lang);
    else if (n > second) second = n;
  }
  return top > 0 && top > second ? best : null;
}
