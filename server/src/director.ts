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
  setEpisode(setup: Partial<EpisodeSetup>): string;
  endEpisode(): string;
  stopAll(): string;
  dispatch(brief: string, target?: number): string;
  status(): string;
  setLayout(mode: LayoutMode): string;
  focusTile(n: number | null): string;
  markBeat(label: string): string;
}

const TOOLS: Anthropic.Tool[] = [
  {
    name: "set_episode",
    description: "Enregistre ce que Fabien vient de dire sur l'épisode : entreprise, destination, durée du trajet, formation à livrer. À appeler dès qu'il donne l'une de ces informations (le chrono et le titre à l'image en dépendent).",
    input_schema: { type: "object", properties: { company: { type: "string" }, destination: { type: "string" }, eta_min: { type: "number" }, topic: { type: "string" } }, additionalProperties: false },
  },
  { name: "stop_all", description: "Arrêt d'urgence : stoppe immédiatement tout ce qui est en construction. À appeler dès que Fabien dit « stop », « arrête tout », « on arrête ». L'épisode et l'enregistrement continuent.", input_schema: { type: "object", properties: {}, additionalProperties: false } },
  { name: "end_episode", description: "Termine l'épisode et l'enregistrement. À l'arrivée, ou si Fabien le demande.", input_schema: { type: "object", properties: {}, additionalProperties: false } },
  {
    name: "dispatch_task",
    description:
      "Lance la construction d'un contenu Mexty réel (parcours, cours, évaluation, activité ou scène 3D EdVerse). Revient immédiatement. Sans `target` : nouveau chantier, en parallèle des autres. Avec `target` = numéro d'un chantier existant : même chantier, même contexte (ex. « rends le quiz plus dur »). Un contenu par chantier : deux cours = deux appels. Le brief doit être autonome : entreprise, public, sujet, ce qui est attendu, langue.",
    input_schema: { type: "object", properties: { brief: { type: "string" }, target: { type: "integer", description: "Numéro du chantier à poursuivre" } }, required: ["brief"], additionalProperties: false },
  },
  { name: "get_status", description: "Avancement des chantiers, temps restant et budget.", input_schema: { type: "object", properties: {}, additionalProperties: false } },
  { name: "set_layout", description: "Disposition des aperçus dans la vidéo.", input_schema: { type: "object", properties: { mode: { type: "string", enum: ["auto", "single", "split", "grid"] } }, required: ["mode"], additionalProperties: false } },
  { name: "focus_tile", description: "Met un aperçu en plein écran (n = numéro du chantier), ou n = 0 pour revenir à la disposition normale.", input_schema: { type: "object", properties: { n: { type: "integer" } }, required: ["n"], additionalProperties: false } },
  { name: "mark_beat", description: "Marque un moment fort de la vidéo (pour le montage), avec un libellé court.", input_schema: { type: "object", properties: { label: { type: "string" } }, required: ["label"], additionalProperties: false } },
];

const SYSTEM = `Tu es la voix de « Ride Studio ». Fabien, fondateur de Mexty, roule à moto et te parle au casque. Il te dit quoi construire sur Mexty ; tu lances le travail avec tes outils, l'écran montre le contenu se construire en direct, et tout est filmé.

Ta voix est entendue dans la vidéo. Règles :
- Extrêmement brève : une seule phrase, dix mots au plus. « C'est parti. » « Deux cours lancés. » « Compris, je durcis le quiz. »
- Français. Pas de listes, pas de markdown, pas d'émojis, pas d'identifiants.
- Ne parle jamais de « worker », d'« agent », de « chantier », de « tâche » ni de technique. Parle des contenus : le cours, le quiz, le parcours.
- N'explique pas ce que tu vas faire, ne résume pas, ne pose pas de question si tu peux agir. Si tu n'as pas compris : « Tu peux répéter ? »
- Fabien conduit : ne lui demande jamais de regarder ou de toucher l'écran.
- Pour tout travail de contenu, appelle dispatch_task puis confirme en quelques mots. Une demande qui modifie un contenu en cours va au même chantier (target). Un contenu différent va à un nouveau chantier.
- Dès que Fabien donne l'entreprise, la destination, la durée du trajet ou le sujet, appelle set_episode.
- N'annonce jamais toi-même qu'un contenu est terminé : le studio le dit à ta place (« Cours 1 terminé. »). Ne prétends jamais qu'un contenu existe.
- Les messages entre crochets [événements] viennent du studio, pas de Fabien. Réponds exactement « … », sauf s'ils te demandent explicitement de prévenir Fabien : alors une phrase très courte.`;

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
  private notes: string[] = [];

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
  /** Emergency stop: drop everything waiting to be said or done, and stop the reply in progress. */
  halt() {
    this.queued = [];
    this.abort?.abort();
  }

  user(text: string) {
    this.enqueue({ text, kind: "user" });
  }
  /** Something the studio said or did by itself. No reply is generated; the model learns it with the next turn. */
  note(text: string) {
    this.notes.push(text);
    if (this.notes.length > 12) this.notes.shift();
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
    if (this.notes.length) this.pushUser(`[événements] ${this.notes.splice(0).join(" ")}`);
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
            max_tokens: 300,
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
        case "set_episode":
          return this.actions.setEpisode({ company: typeof a.company === "string" ? a.company : undefined, destination: typeof a.destination === "string" ? a.destination : undefined, topic: typeof a.topic === "string" ? a.topic : undefined, etaMin: Number(a.eta_min) > 0 ? Number(a.eta_min) : undefined });
        case "stop_all":
          return this.actions.stopAll();
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
    if (text.startsWith("[événements]")) return;
    const t = text.toLowerCase();
    if (/^(stop|arrête)\b|arrête tout/.test(t)) {
      this.actions.stopAll();
    } else if (/termin|arriv|fini/.test(t) && /épisode|on est|je suis|c'est/.test(t)) {
      this.actions.endEpisode();
      this.speak("On est arrivés, je coupe.");
    } else if (/plein écran|zoom|montre/.test(t)) {
      this.actions.focusTile(1);
      this.speak("En grand.");
    } else if (/où en|statut|avance/.test(t)) {
      this.speak(this.actions.status().split("\n")[0]);
    } else if (/cours|formation|parcours|scène|3d|quiz|évaluation|question|ajoute|change|rends|modifie/.test(t)) {
      const r = this.actions.dispatch(text, /rends|change|modifie/.test(t) ? 1 : undefined);
      this.speak(r.startsWith("Erreur") ? "Impossible pour l'instant." : "C'est parti.");
    } else {
      this.speak("Mode démo, sans clé Claude.");
    }
  }
}
