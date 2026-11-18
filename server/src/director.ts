import Anthropic from "@anthropic-ai/sdk";
import type { EpisodeSetup, LayoutMode } from "../../shared/protocol.js";

/** USD per million tokens [input, output, cache read]. Unknown models are priced like Sonnet. */
const PRICES: Record<string, [number, number, number]> = {
  "claude-haiku-5-5": [0.1, 0.5, 0.01],
  "claude-sonnet-5-5": [2, 10, 0.1],
  "claude-opus-5-5": [4, 20, 0.2],
};
export function tokenCost(model: string, u: { input_tokens?: number | null; output_tokens?: number | null; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null }): number {
  const [i, o, c] = PRICES[model] ?? PRICES["claude-sonnet-5-5"];
  return (((u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) * 1.25) * i + (u.output_tokens ?? 0) * o + (u.cache_read_input_tokens ?? 0) * c) / 1e6;
}

/** What the director can do. Every call returns at once: the director never waits on work. */
export interface DirectorActions {
  startEpisode(setup: Partial<EpisodeSetup>): string;
  endEpisode(): string;
  dispatch(brief: string, target?: number): string;
  status(): string;
  setLayout(mode: LayoutMode): string;
  focusTile(n: number | null): string;
  markBeat(label: string): string;
}

const TOOLS: Anthropic.Tool[] = [
  { name: "start_episode", description: "Démarre l'épisode et le chrono. À n'appeler que si aucun épisode n'est en cours.", input_schema: { type: "object", properties: { company: { type: "string" }, destination: { type: "string" }, eta_min: { type: "number" }, topic: { type: "string" } }, required: ["company", "topic"], additionalProperties: false } },
  { name: "end_episode", description: "Termine l'épisode : arrête les workers et l'enregistrement. À l'arrivée, ou si Fabien le demande.", input_schema: { type: "object", properties: {}, additionalProperties: false } },
  {
    name: "dispatch_task",
    description:
      "Confie un travail à un worker Claude Code qui construit du contenu Mexty réel (parcours, cours, évaluation, bloc ou scène 3D EdVerse). Revient immédiatement. Sans `target` : nouveau worker en parallèle. Avec `target` = numéro d'un worker existant : même worker, même contexte (ex. « rends le quiz plus dur »). Le brief doit être autonome : entreprise, public, sujet, ce qui est attendu, langue.",
    input_schema: { type: "object", properties: { brief: { type: "string" }, target: { type: "integer", description: "Numéro du worker à poursuivre (CLAUDE n)" } }, required: ["brief"], additionalProperties: false },
  },
  { name: "get_status", description: "État des workers, de l'avancement, du temps restant et du budget.", input_schema: { type: "object", properties: {}, additionalProperties: false } },
  { name: "set_layout", description: "Disposition des aperçus dans la vidéo.", input_schema: { type: "object", properties: { mode: { type: "string", enum: ["auto", "single", "split", "grid"] } }, required: ["mode"], additionalProperties: false } },
  { name: "focus_tile", description: "Met un aperçu en plein écran pour un moment clé (n = numéro du worker), ou n = 0 pour revenir à la disposition normale.", input_schema: { type: "object", properties: { n: { type: "integer" } }, required: ["n"], additionalProperties: false } },
  { name: "mark_beat", description: "Marque un moment fort de la vidéo (pour le montage), avec un libellé court.", input_schema: { type: "object", properties: { label: { type: "string" } }, required: ["label"], additionalProperties: false } },
];

const SYSTEM = `Tu es la co-animatrice vocale de « Ride Studio », une série vidéo quotidienne. Fabien, fondateur de Mexty, roule à moto et te parle au casque. Pendant le trajet, des workers Claude Code construisent une vraie formation Mexty pour l'entreprise chez qui il arrive ; l'écran du téléphone montre chaque changement en direct et tout est enregistré.

Ta voix est entendue dans la vidéo. Règles :
- Français par défaut, ton de co-animatrice : vive, chaleureuse, précise, jamais scolaire.
- Deux phrases maximum par réponse. Phrases courtes, faites pour être dites à voix haute : pas de listes, pas de markdown, pas d'émojis, pas d'identifiants techniques.
- Fabien conduit : ne lui demande jamais de regarder ou de toucher l'écran. Tout passe par la voix.
- Tu ne bloques jamais : pour tout travail de contenu, appelle dispatch_task puis confirme en une phrase. Ne prétends jamais qu'un contenu existe tant qu'un événement ne l'a pas confirmé.
- Une demande qui modifie un contenu en cours va au même worker (target). Un contenu différent (ex. une évaluation en plus du cours) va à un nouveau worker, en parallèle.
- Les messages entre crochets [événements] viennent du studio, pas de Fabien : annonce l'essentiel en une phrase naturelle, comme un commentaire en direct, ou reste silencieuse en répondant exactement « … » si ce n'est pas intéressant ou si tu viens déjà d'en parler.
- Pour un moment marquant (premier écran, quiz terminé, scène 3D qui apparaît), pense à focus_tile et mark_beat.
- Si tu n'as pas compris, demande de répéter en quelques mots. Si le budget est atteint, dis-le simplement.`;

export interface DirectorCallbacks {
  /** A complete sentence, ready to be spoken. */
  say(text: string): void;
  usage(costUsd: number): void;
  error(message: string): void;
}

const SENTENCE_END = /([.!?…]["»)]?)(\s+|$)/;

export class Director {
  private history: Anthropic.MessageParam[] = [];
  private abort: AbortController | null = null;
  private busy = false;
  private queued: { text: string; kind: "user" | "event" }[] = [];
  lastSpokeAt = 0;

  constructor(private getKey: () => string | null, private getModel: () => string, private actions: DirectorActions, private cb: DirectorCallbacks) {}

  reset(context: string) {
    this.interrupt();
    this.queued = [];
    this.history = [{ role: "user", content: `[événements] ${context}` }, { role: "assistant", content: "…" }];
  }

  /** Barge-in: stop generating. What was already said stays in the history. */
  interrupt() {
    this.abort?.abort();
  }

  user(text: string) {
    this.enqueue({ text, kind: "user" });
  }
  event(text: string) {
    // Events never interrupt a reply in progress and collapse while waiting.
    const last = this.queued.at(-1);
    if (last?.kind === "event") last.text += ` ${text}`;
    else this.enqueue({ text: `[événements] ${text}`, kind: "event" });
  }

  private enqueue(item: { text: string; kind: "user" | "event" }) {
    this.queued.push(item);
    void this.pump();
  }

  private async pump() {
    if (this.busy) return;
    this.busy = true;
    try {
      while (this.queued.length) {
        // A user turn outranks pending events.
        const i = this.queued.findIndex((q) => q.kind === "user");
        const [item] = this.queued.splice(i >= 0 ? i : 0, 1);
        await this.turn(item.text);
      }
    } finally {
      this.busy = false;
    }
  }

  private pushUser(text: string) {
    const last = this.history.at(-1);
    if (last?.role === "user" && typeof last.content === "string") last.content += `\n${text}`;
    else this.history.push({ role: "user", content: text });
    // Thinking is off, so trimming old turns is safe; keep the opening context pair.
    if (this.history.length > 80) {
      let cut = this.history.length - 60;
      while (cut < this.history.length && !(this.history[cut].role === "user" && typeof this.history[cut].content === "string")) cut++;
      this.history.splice(2, cut - 2);
    }
  }

  private async turn(text: string) {
    const key = this.getKey();
    if (!key) return this.stubTurn(text);
    const client = new Anthropic({ apiKey: key, maxRetries: 1, timeout: 20_000 });
    const model = this.getModel();
    this.pushUser(text);
    this.abort = new AbortController();
    const signal = this.abort.signal;
    try {
      for (let hop = 0; hop < 4; hop++) {
        let pending = "";
        const flush = (final: boolean) => {
          for (;;) {
            const m = SENTENCE_END.exec(pending);
            if (!m || (!final && m.index + m[0].length >= pending.length && !m[2])) break;
            const s = pending.slice(0, m.index + m[1].length).trim();
            pending = pending.slice(m.index + m[0].length);
            if (s && s !== "…") this.speak(s);
          }
          if (final && pending.trim() && pending.trim() !== "…") this.speak(pending.trim());
          if (final) pending = "";
        };
        const stream = client.messages.stream(
          {
            model,
            max_tokens: 400,
            // Latency first: no thinking, low effort. (Also keeps the history free of thinking blocks, so it can be trimmed.)
            thinking: { type: "disabled" },
            output_config: { effort: "low" },
            system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
            tools: TOOLS,
            messages: this.history,
          },
          { signal },
        );
        stream.on("text", (delta) => {
          pending += delta;
          flush(false);
        });
        const msg = await stream.finalMessage();
        flush(true);
        this.cb.usage(tokenCost(model, msg.usage));
        if (msg.stop_reason === "refusal") {
          this.history.pop(); // drop the turn that was declined so the conversation can continue
          this.speak("Ça, je ne peux pas le faire. On continue ?");
          return;
        }
        this.history.push({ role: "assistant", content: msg.content });
        const calls = msg.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
        if (!calls.length) return;
        this.history.push({ role: "user", content: calls.map((c) => ({ type: "tool_result" as const, tool_use_id: c.id, content: this.runTool(c.name, c.input) })) });
      }
    } catch (e) {
      if (signal.aborted) {
        // Keep the history valid after a barge-in: the last message must not be a dangling user turn with tool results.
        const last = this.history.at(-1);
        if (last?.role === "user") this.history.push({ role: "assistant", content: "…" });
        return;
      }
      const msg = e instanceof Anthropic.APIError ? `Claude API ${e.status}: ${e.message}` : (e as Error).message;
      this.cb.error(msg);
      const last = this.history.at(-1);
      if (last?.role === "user") this.history.push({ role: "assistant", content: "…" });
      if (e instanceof Anthropic.AuthenticationError) this.speak("Ma clé Claude n'est pas valide. Vérifie les réglages.");
    }
  }

  private speak(s: string) {
    this.lastSpokeAt = Date.now();
    this.cb.say(s);
  }

  private runTool(name: string, input: unknown): string {
    const a = (input ?? {}) as Record<string, unknown>;
    try {
      switch (name) {
        case "start_episode":
          return this.actions.startEpisode({ company: String(a.company ?? ""), destination: String(a.destination ?? ""), topic: String(a.topic ?? ""), etaMin: Number(a.eta_min) || undefined });
        case "end_episode":
          return this.actions.endEpisode();
        case "dispatch_task":
          if (typeof a.brief !== "string" || a.brief.trim().length < 8) return "Erreur : brief manquant ou trop court.";
          return this.actions.dispatch(a.brief, Number.isInteger(a.target) ? (a.target as number) : undefined);
        case "get_status":
          return this.actions.status();
        case "set_layout":
          return this.actions.setLayout((["auto", "single", "split", "grid"].includes(String(a.mode)) ? a.mode : "auto") as LayoutMode);
        case "focus_tile":
          return this.actions.focusTile(Number(a.n) > 0 ? Number(a.n) : null);
        case "mark_beat":
          return this.actions.markBeat(String(a.label ?? "moment"));
        default:
          return `Outil inconnu : ${name}`;
      }
    } catch (e) {
      return `Erreur : ${(e as Error).message}`;
    }
  }

  /** No Anthropic key: a scripted co-host so the voice loop, layout and recording can still be rehearsed. */
  private stubTurn(text: string) {
    if (text.startsWith("[événements]")) {
      if (/terminé|budget|premier/i.test(text) && Date.now() - this.lastSpokeAt > 8000) this.speak(text.replace("[événements]", "").trim().split(/(?<=[.!?])\s/)[0]);
      return;
    }
    const t = text.toLowerCase();
    if (/termin|arriv|stop|fini/.test(t) && /épisode|on est|je suis|c'est/.test(t)) {
      this.actions.endEpisode();
      this.speak("On est arrivés, je coupe. Belle route !");
    } else if (/quiz|évaluation|question/.test(t)) {
      this.speak(this.actions.dispatch(`Évaluation demandée à la voix : ${text}`).includes("Erreur") ? "Je n'ai pas pu lancer ça." : "C'est parti, un Claude s'occupe du quiz en parallèle.");
    } else if (/plein écran|zoom|montre/.test(t)) {
      this.actions.focusTile(1);
      this.speak("Je mets l'aperçu en grand.");
    } else if (/où en|statut|avance/.test(t)) {
      this.speak(this.actions.status().split("\n")[0]);
    } else if (/cours|formation|parcours|scène|3d|ajoute|change|rends|modifie/.test(t)) {
      this.actions.dispatch(text, /rends|change|modifie/.test(t) ? 1 : undefined);
      this.speak("Bien reçu, je lance ça tout de suite.");
    } else {
      this.speak("Mode démo : ajoute une clé Claude dans les réglages pour une vraie conversation.");
    }
  }
}
