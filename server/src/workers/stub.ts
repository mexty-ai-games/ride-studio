import { randomUUID } from "node:crypto";
import type { Emit, Running, TaskSpec } from "./types.js";

type Step = { tool: string; input: Record<string, unknown>; result: Record<string, unknown>; say?: string };

const hex = () => randomUUID().replace(/-/g, "").slice(0, 24);

/** What a real worker would do, as the same sequence of small MCP calls — for rehearsals without Claude Code. */
function script(brief: string, resume: string | undefined): { steps: Step[]; id: string } {
  const topic = (/sujet\s*:\s*([^.\n]{4,80})/i.exec(brief)?.[1] ?? "Formation sur mesure").trim();
  const b = brief.toLowerCase();
  const steps: Step[] = [];
  if (resume) {
    // Follow-up on the same content: a few visible edits.
    const [kind, id] = resume.split(":");
    if (kind === "evaluation") {
      for (const q of ["Cas pratique : la situation dégénère, que faites-vous en premier ?", "Question piège : laquelle de ces consignes est fausse ?"]) {
        steps.push({ tool: "mcp__MEXTY__add_evaluation_step", input: { evaluationId: id, title: q }, result: { step: { id: randomUUID() } } });
      }
    } else {
      steps.push({ tool: "mcp__MEXTY__add_slide", input: { courseId: id, title: "Cas pratique ajouté", content: "Une mise en situation tirée de votre quotidien." }, result: { success: true, slide: { id: randomUUID() } } });
    }
    return { steps, id: resume };
  }
  if (/quiz|évaluation|evaluation|question/.test(b)) {
    const id = hex();
    steps.push({ tool: "mcp__MEXTY__create_evaluation", input: { title: topic === "Formation sur mesure" ? "Quiz de validation" : `Quiz · ${topic}` }, result: { evaluation: { id } }, say: "Je crée l'évaluation." });
    const qs = ["Quel est le premier réflexe face à un incident ?", "Qui doit être prévenu, et dans quel ordre ?", "Vrai ou faux : on peut intervenir seul.", "Classez ces actions par priorité.", "Cas pratique : que faites-vous ?"];
    for (const q of qs) steps.push({ tool: "mcp__MEXTY__add_evaluation_step", input: { evaluationId: id, title: q }, result: { step: { id: randomUUID() }, stepCount: 0 } });
    return { steps, id: `evaluation:${id}` };
  }
  if (/parcours|programme|learning path/.test(b)) {
    const id = hex();
    steps.push({ tool: "mcp__MEXTY__create_program", input: { title: `Parcours · ${topic}` }, result: { program: { id } } });
    for (const n of ["Découvrir les enjeux", "Les règles essentielles", "S'entraîner sur des cas", "Évaluation finale"]) steps.push({ tool: "mcp__MEXTY__add_program_node", input: { programId: id, name: n }, result: { node: { id: randomUUID() } } });
    return { steps, id: `program:${id}` };
  }
  if (/3d|scène|scene|edverse/.test(b)) {
    const id = hex();
    steps.push({ tool: "mcp__EDVERSE__create_game", input: { title: `Scène 3D · ${topic}` }, result: { blockId: hex(), sceneId: id } });
    for (const o of ["Sol et lumière", "Poste de secours", "Bouée de sauvetage", "Panneau de consignes", "Personnage guide"]) steps.push({ tool: "mcp__EDVERSE__edit_scene", input: { sceneId: id, name: o }, result: { version: 1, objectId: randomUUID() } });
    return { steps, id: `scene:${id}` };
  }
  const id = hex();
  steps.push({ tool: "mcp__MEXTY__create_course", input: { title: topic }, result: { course: { id } }, say: "Je crée le cours." });
  const slides: [string, string[]][] = [
    [topic, ["Une formation courte, faite pour le terrain."]],
    ["Pourquoi c'est important", ["Les risques réels, en chiffres.", "Ce que la réglementation attend de vous."]],
    ["Les bons réflexes", ["Observer avant d'agir.", "Donner l'alerte tout de suite.", "Ne jamais intervenir seul."]],
    ["La procédure pas à pas", ["Étape 1 : sécuriser la zone.", "Étape 2 : prévenir le responsable.", "Étape 3 : accompagner les personnes."]],
    ["Cas pratique", ["Une situation tirée de votre quotidien.", "À vous de choisir la bonne réaction."]],
    ["À retenir", ["Trois réflexes, une procédure, un numéro à connaître."]],
  ];
  for (const [title, bullets] of slides) {
    const slideId = randomUUID();
    // One call per visible change: the slide, its title, then each element.
    steps.push({ tool: "mcp__MEXTY__add_slide", input: { courseId: id }, result: { success: true, slide: { id: slideId } } });
    steps.push({ tool: "mcp__MEXTY__update_slide", input: { courseId: id, slideId, title }, result: { success: true, slideId } });
    for (const text of bullets) steps.push({ tool: "mcp__MEXTY__update_slide", input: { courseId: id, slideId, text }, result: { success: true, slideId } });
  }
  return { steps, id: `course:${id}` };
}

export class StubRunner {
  run(spec: TaskSpec, emit: Emit): Running {
    const { steps, id } = script(spec.brief, spec.resume);
    let i = 0;
    let stopped = false;
    let cost = 0;
    emit({ kind: "init", sessionId: id, mcpServers: [{ name: "MEXTY", status: "démo" }, { name: "EDVERSE", status: "démo" }], model: "démo" });
    const next = () => {
      if (stopped) return;
      if (i >= steps.length) {
        emit({ kind: "result", ok: true, sessionId: id, costUsd: cost, turns: steps.length, summary: "Contenu de démonstration terminé." });
        return;
      }
      const s = steps[i++];
      const callId = randomUUID();
      if (s.say) emit({ kind: "text", text: s.say });
      emit({ kind: "tool_use", id: callId, name: s.tool, input: s.input });
      setTimeout(() => {
        if (stopped) return;
        cost += 0.012;
        emit({ kind: "tool_result", id: callId, name: s.tool, isError: false, output: JSON.stringify(s.result) });
        emit({ kind: "usage", costUsd: cost });
        setTimeout(next, 900 + Math.random() * 1300);
      }, 350);
    };
    setTimeout(next, 700);
    return {
      stop() {
        if (stopped) return;
        stopped = true;
        emit({ kind: "result", ok: false, sessionId: id, costUsd: cost, turns: i, summary: "Arrêté." });
      },
    };
  }
}
