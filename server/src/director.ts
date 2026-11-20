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
  arrive(): string;
  pauseRecording(): string;
  resumeRecording(): string;
  switchCamera(): string;
  showContent(name: string | null): string;
  showQr(on: boolean): string;
  dispatch(brief: string, target?: number): string;
  status(): string;
  setLayout(mode: LayoutMode): string;
  focusTile(n: number | null): string;
  markBeat(label: string): string;
  radio(action: "on" | "off" | "next"): string;
}

const TOOLS: Anthropic.Tool[] = [
  {
    name: "set_episode",
    description: "Enregistre ce que Fabien vient de dire sur l'épisode : entreprise, destination, durée du trajet, formation à livrer. À appeler dès qu'il donne l'une de ces informations (le chrono et le titre à l'image en dépendent).",
    input_schema: { type: "object", properties: { company: { type: "string" }, destination: { type: "string" }, eta_min: { type: "number" }, topic: { type: "string" } }, additionalProperties: false },
  },
  { name: "stop_all", description: "Arrêt d'urgence : stoppe immédiatement tout ce qui est en construction. À appeler dès que Fabien dit « stop », « arrête tout », « on arrête ». L'épisode et l'enregistrement continuent.", input_schema: { type: "object", properties: {}, additionalProperties: false } },
  { name: "arrive", description: "Fabien est arrivé : le chrono s'arrête, mais l'enregistrement et tout le reste continuent (il va montrer la formation). À appeler quand il dit « on est arrivés », « je suis arrivé ».", input_schema: { type: "object", properties: {}, additionalProperties: false } },
  { name: "pause_recording", description: "Met l'enregistrement vidéo en pause (la voix et les sons continuent). « pause », « coupe l'enregistrement ».", input_schema: { type: "object", properties: {}, additionalProperties: false } },
  { name: "resume_recording", description: "Reprend l'enregistrement vidéo. « on reprend », « tu peux enregistrer ».", input_schema: { type: "object", properties: {}, additionalProperties: false } },
  { name: "switch_camera", description: "Bascule entre la caméra avant (Fabien) et la caméra arrière (filmer une autre personne).", input_schema: { type: "object", properties: {}, additionalProperties: false } },
  { name: "show_content", description: "Affiche un contenu en grand, à tout moment, terminé ou en cours. En route : il passe en plein écran dans la vidéo. Une fois arrivés : il s'ouvre aussi sur le téléphone pour qu'une personne le teste. C'est l'outil pour toute demande d'ouvrir, afficher, montrer, voir, aller sur un contenu (« ouvre le parcours », « montre le premier cours », « mets le cours en plein écran », « va sur la page du learning path »). name = le nom annoncé (« Cours 1 », « Programme d'étude », « Scène 3D 1 »), le type (« le parcours », « le cours ») ou vide pour le dernier. close=true pour revenir à tous les écrans.", input_schema: { type: "object", properties: { name: { type: "string" }, close: { type: "boolean" } }, additionalProperties: false } },
  { name: "show_qr", description: "Affiche (on=true) ou masque (on=false) le QR code du contenu montré, pour qu'une personne l'ouvre sur son propre téléphone.", input_schema: { type: "object", properties: { on: { type: "boolean" } }, required: ["on"], additionalProperties: false } },
  {
    name: "radio",
    description:
      "Radio Monkey, la musique de fond. UNIQUEMENT quand Fabien le demande explicitement en parlant de la radio ou de la musique : « mets la radio », « lance la musique » (on), « coupe la radio », « coupe la musique » (off), « morceau suivant », « change de musique » (next). Ne l'allume, ne la coupe et ne change jamais de morceau de toi-même : ni pour un événement, ni pour une pause, ni à l'arrivée, ni sur un simple « stop ».",
    input_schema: { type: "object", properties: { action: { type: "string", enum: ["on", "off", "next"] } }, required: ["action"], additionalProperties: false },
  },
  { name: "end_episode", description: "Termine définitivement l'épisode et l'enregistrement. Seulement si Fabien dit clairement que l'épisode est fini (« on termine l'épisode », « c'est fini pour aujourd'hui ») : pour « on est arrivés », utilise arrive.", input_schema: { type: "object", properties: {}, additionalProperties: false } },
  {
    name: "dispatch_task",
    description:
      "Lance la construction d'un contenu Mexty réel (parcours, cours, évaluation, activité ou scène 3D EdVerse). Revient immédiatement. Sans `target` : nouveau contenu, en parallèle des autres. Avec `target` = le numéro rendu au lancement : on poursuit ce contenu avec le même contexte (ex. « rends le quiz plus dur »). Un contenu par appel : deux cours = deux appels. Le brief doit être autonome : entreprise, public, sujet, ce qui est attendu, langue, et demander une construction par petites étapes visibles (pour la 3D : un objet par appel edit_scene).",
    input_schema: { type: "object", properties: { brief: { type: "string" }, target: { type: "integer", description: "Numéro rendu au lancement du contenu à poursuivre" } }, required: ["brief"], additionalProperties: false },
  },
  { name: "get_status", description: "Avancement des contenus, liste des écrans à l'image, temps restant et budget.", input_schema: { type: "object", properties: {}, additionalProperties: false } },
  { name: "set_layout", description: "Disposition des aperçus dans la vidéo.", input_schema: { type: "object", properties: { mode: { type: "string", enum: ["auto", "single", "split", "grid"] } }, required: ["mode"], additionalProperties: false } },
  { name: "focus_tile", description: "Met un écran en plein écran. n = numéro de l'écran tel qu'il est à l'image (écran 1, écran 2…, « le deuxième » = 2), ou n = 0 pour revoir tous les écrans (la grille). Les événements et get_status disent quel contenu est sur quel écran : si Fabien nomme un contenu (« la scène 3D », « le système solaire »), choisis l'écran qui le porte.", input_schema: { type: "object", properties: { n: { type: "integer" } }, required: ["n"], additionalProperties: false } },
  { name: "mark_beat", description: "Marque un moment fort de la vidéo (pour le montage), avec un libellé court.", input_schema: { type: "object", properties: { label: { type: "string" } }, required: ["label"], additionalProperties: false } },
];

const SYSTEM = `Tu es la voix de « Ride Studio ». Fabien, fondateur de Mexty, roule à moto et te parle au casque. Il te dit quoi construire sur Mexty ; tu lances le travail avec tes outils, l'écran montre le contenu se construire en direct, et tout est filmé.

Ta voix est entendue dans la vidéo. Règles :
- Extrêmement brève : une seule phrase, dix mots au plus. « C'est parti. » « Deux cours lancés. » « Compris, je durcis le quiz. »
- Français. Pas de listes, pas de markdown, pas d'émojis, pas d'identifiants.
- Ne parle jamais de « worker », d'« agent », de « chantier », de « tâche », de « demande » ni de technique. Parle des contenus : le cours, le quiz, le parcours, la scène.
- N'explique pas ce que tu vas faire, ne résume pas, ne pose pas de question si tu peux agir. Si tu n'as pas compris : « Tu peux répéter ? »
- Fabien conduit : ne lui demande jamais de regarder ou de toucher l'écran.
- Pour tout travail de contenu, appelle dispatch_task puis confirme en quelques mots.
- Tout se voit en direct à l'écran : chaque brief demande de construire par toutes petites étapes visibles. Pour une scène 3D ou un jeu EdVerse, écris explicitement dans le brief : créer le jeu à partir du modèle vide, puis construire la scène objet par objet, un seul objet ou groupe par appel edit_scene (le sol, puis la lumière, puis chaque élément), dans un ordre qu'un spectateur peut suivre ; le code de jeu et les réglages seulement à la fin. Jamais toute une scène en un appel. Une demande qui modifie un contenu en cours reprend ce contenu (target). Un contenu différent est un nouvel appel sans target.
- Dès que Fabien donne l'entreprise, la destination, la durée du trajet ou le sujet, appelle set_episode.
- Tu ne cliques pas dans les pages et tu n'ouvres pas d'adresse : tu affiches des contenus. Pour toute demande d'ouvrir, montrer, afficher, voir, aller sur un contenu ou une page (même formulée comme une adresse, « /lms/... », ou comme un clic), appelle show_content avec le contenu visé. Le premier cours d'un parcours est le contenu « Cours 1 ». Ne réponds jamais « je ne peux pas » sans avoir d'abord appelé show_content.
- Il peut y avoir plusieurs écrans à l'image. Ne dis jamais combien il y en a sans l'avoir vérifié dans les événements ou avec get_status. Si focus_tile échoue, appelle get_status et réessaie avec le bon numéro.
- La radio (outil radio) ne bouge que sur un ordre explicite de Fabien qui parle de radio ou de musique. « Stop » seul, c'est stop_all, pas la radio.
- Les outils arrive, pause_recording, resume_recording, show_content, show_qr, switch_camera et radio annoncent eux-mêmes ce qu'ils font : après eux, réponds exactement « … ».
- N'annonce jamais toi-même qu'un contenu est terminé : le studio le dit à ta place (« Cours 1 terminé. »). Ne prétends jamais qu'un contenu existe.
- Les messages entre crochets [événements] viennent du studio, pas de Fabien. Réponds exactement « … », sauf s'ils te demandent explicitement de prévenir Fabien : alors une phrase très courte.`;

/**
 * The lowest-latency thinking setting each model accepts. Haiku 5.5 turns thinking off with "disabled";
 * Sonnet 5.5 rejects that and takes "between_tools"; Opus 5.5 and Fable accept neither, so the field is left out
 * and low effort keeps them quick.
 */
function thinkingFor(model: string): { thinking?: Anthropic.MessageCreateParams["thinking"]; noThinkingBlocks: boolean } {
  if (/haiku/.test(model)) return { thinking: { type: "disabled" }, noThinkingBlocks: true };
  if (/sonnet-5-5/.test(model)) return { thinking: { type: "between_tools" } as unknown as Anthropic.MessageCreateParams["thinking"], noThinkingBlocks: false };
  return { noThinkingBlocks: false };
}

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
    // Trimming old turns is only safe when no thinking block can be in the history: other models check that
    // the conversation before a replayed block was not edited.
    if (thinkingFor(this.getModel()).noThinkingBlocks && this.history.length > 80) {
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
            // Latency first: the least thinking the model accepts, low effort.
            ...(thinkingFor(model).thinking ? { thinking: thinkingFor(model).thinking } : {}),
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
        case "arrive":
          return this.actions.arrive();
        case "pause_recording":
          return this.actions.pauseRecording();
        case "resume_recording":
          return this.actions.resumeRecording();
        case "switch_camera":
          return this.actions.switchCamera();
        case "show_content":
          return this.actions.showContent(a.close ? null : typeof a.name === "string" ? a.name : "");
        case "show_qr":
          return this.actions.showQr(!!a.on);
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
        case "radio":
          return this.actions.radio(a.action === "off" ? "off" : a.action === "next" ? "next" : "on");
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
    if (/\b(radio|musique)\b/.test(t)) this.actions.radio(/coupe|arrête|éteins|stop/.test(t) ? "off" : /suivant|change|autre/.test(t) ? "next" : "on");
    else if (/^(stop|arrête)\b|arrête tout/.test(t)) this.actions.stopAll();
    else if (/termine l'épisode|fin de l'épisode|c'est fini pour aujourd'hui/.test(t)) {
      this.actions.endEpisode();
      this.speak("Épisode terminé.");
    } else if (/arriv/.test(t)) this.actions.arrive();
    else if (/\bpause\b|coupe l'enregistrement/.test(t)) this.actions.pauseRecording();
    else if (/reprend|on tourne|tu peux enregistrer/.test(t)) this.actions.resumeRecording();
    else if (/caméra|camera/.test(t)) this.speak(this.actions.switchCamera());
    else if (/\bqr\b/.test(t)) this.actions.showQr(!/enlève|cache|masque/.test(t));
    else if (/ferme/.test(t)) this.actions.showContent(null);
    else if (/montre|ouvre/.test(t) && /cours|parcours|programme|évaluation|scène|formation|bloc|activité/.test(t)) {
      const r = this.actions.showContent(t.replace(/.*?(montre|ouvre)( moi| nous)?( le| la| l'| les)?\s*/, ""));
      if (r.startsWith("Erreur")) this.speak("Je ne trouve pas ce contenu.");
    } else if (/plein écran|zoom/.test(t)) {
      this.actions.focusTile(1);
      this.speak("En grand.");
    } else if (/où en|statut|avance/.test(t)) this.speak(this.actions.status().split("\n")[0]);
    else if (/cours|formation|parcours|scène|3d|quiz|évaluation|question|ajoute|change|rends|modifie/.test(t)) {
      const r = this.actions.dispatch(text, /rends|change|modifie/.test(t) ? 1 : undefined);
      this.speak(r.startsWith("Erreur") ? "Impossible pour l'instant." : "C'est parti.");
    } else this.speak("Mode démo, sans clé Claude.");
  }
}
