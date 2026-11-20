import { bareTool, type ChangeEvent, type ChangeOp, type Entity } from "../../shared/protocol.js";

/** Tool families → the entity whose viewer should show the change. First match wins. */
const FAMILIES: [RegExp, Entity][] = [
  [/scene|set_material|set_environment|import_asset/, "scene"],
  [/slide|course/, "course"],
  [/evaluation/, "evaluation"],
  [/program/, "program"],
  [/block|game|props/, "block"],
];

const ID_KEYS: Record<Entity, RegExp> = {
  course: /^course_?id$/i,
  program: /^program_?id$/i,
  evaluation: /^evaluation_?id$/i,
  block: /^(block|game|owned_?block)_?id$/i,
  scene: /^scene_?id$/i,
};
const PATH_KEYS: [keyof ChangeEvent["path"], RegExp][] = [
  ["slideId", /^slide_?id$/i],
  ["nodeId", /^node_?id$/i],
  ["stepId", /^step_?id$/i],
  ["propsId", /^props_?id$/i],
  ["objectId", /^(object|entity|target)_?id$/i],
  ["elementId", /^element_?id$/i],
];
/** Result wrappers whose own `id` is the id of that thing: { slide: { id } }. */
const WRAPPERS: Record<string, keyof ChangeEvent["path"] | Entity> = {
  slide: "slideId", node: "nodeId", step: "stepId", course: "course", program: "program", evaluation: "evaluation", block: "block", game: "block", scene: "scene",
};

const READ_ONLY = /^(get|list|read|search|find|preview|check|compare|screenshot|propose|verify|open)_/;

export function parseJsonLoose(text: string): unknown {
  const t = text.trim();
  if (!t) return null;
  try {
    if (t[0] === "{" || t[0] === "[") return JSON.parse(t);
  } catch {
    /* fall through: a JSON object inside some text */
  }
  const a = t.indexOf("{");
  const b = t.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  try {
    return JSON.parse(t.slice(a, b + 1));
  } catch {
    return null;
  }
}

function walk(v: unknown, visit: (key: string, value: unknown, parent: string) => void, parent = "", depth = 0) {
  if (!v || typeof v !== "object" || depth > 4) return;
  if (Array.isArray(v)) {
    for (const x of v.slice(0, 20)) walk(x, visit, parent, depth + 1);
    return;
  }
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    visit(k, val, parent);
    walk(val, visit, k, depth + 1);
  }
}

const isId = (v: unknown): v is string => typeof v === "string" && v.length >= 6 && v.length <= 80 && !/\s/.test(v);

export interface Derived {
  event: ChangeEvent;
  /** Display title for the tile, when the tool call carries one. */
  title?: string;
  /** Title of the changed item (slide, node, step…), when the call sets one. */
  itemTitle?: string;
  /** Short text lines the mock viewer can show for this change. */
  lines: string[];
}

/**
 * Secondary change-event source: derive a granular change from one successful MCP tool call.
 * The arguments and the result carry the ids, so follow-cam can start before Mexty's own event lands.
 */
export function deriveChange(toolName: string, input: unknown, resultText: string): Derived | null {
  const tool = bareTool(toolName);
  if (tool === toolName && !toolName.startsWith("mcp__")) return null; // not an MCP tool
  if (READ_ONLY.test(tool)) return null;
  const family = FAMILIES.find(([re]) => re.test(tool));
  if (!family) return null;
  const entity = family[1];
  const result = parseJsonLoose(resultText);
  if (result && typeof result === "object" && ((result as { success?: unknown }).success === false || !!(result as { error?: unknown }).error)) return null;

  let entityId = "";
  const path: ChangeEvent["path"] = {};
  const scan = (src: unknown, fromResult: boolean) =>
    walk(src, (k, v, parent) => {
      if (!isId(v)) return;
      if (!entityId && ID_KEYS[entity].test(k)) entityId = v;
      for (const [field, re] of PATH_KEYS) if (!path[field] && re.test(k)) path[field] = v;
      if (fromResult && (k === "id" || k === "_id")) {
        const w = WRAPPERS[parent];
        if (w === entity && !entityId) entityId = v;
        else if (w && w !== entity && !(w in ID_KEYS) && !path[w as keyof ChangeEvent["path"]]) path[w as keyof ChangeEvent["path"]] = v;
      }
    });
  scan(input, false);
  scan(result, true);
  // create_* returns the new thing at the top level: { id } / { courseId }.
  if (!entityId && result && typeof result === "object") {
    const top = result as Record<string, unknown>;
    if (/^create_/.test(tool) && isId(top.id)) entityId = top.id;
  }
  if (!entityId) return null;

  const op: ChangeOp = /^(create|add|import|generate)_/.test(tool) ? "create" : /^(delete|remove)_/.test(tool) ? "delete" : /^reorder_/.test(tool) ? "reorder" : "update";
  const inp = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const title = [inp.title, inp.name, inp.question, inp.label].find((x) => typeof x === "string" && x) as string | undefined;
  const clean = (v: string) => v.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 160);
  const lines: string[] = [];
  walk(input, (k, v) => {
    if (typeof v !== "string" || v === title || lines.length >= 5) return;
    if (!/^(text|content|description|body|subtitle|prompt|bullet|html|markdown|answer|label)$/i.test(k)) return;
    const c = clean(v);
    if (c.length > 2 && !lines.includes(c)) lines.push(c);
  });
  const entityLevel = /^(create|update)_(course|program|evaluation|block|game)$|^update_program_info$/.test(tool);
  return {
    event: { entity, entityId, path, op, tool, label: labelFor(tool, op, title), source: "tool", ts: Date.now() },
    title: entityLevel ? title : undefined,
    itemTitle: entityLevel ? undefined : title && clean(title),
    lines,
  };
}

const NOUN: [RegExp, string][] = [
  [/slide/, "Écran"], [/node/, "Étape du parcours"], [/link/, "Lien"], [/step/, "Question"], [/props/, "Contenu"], [/files/, "Code"],
  [/scene|material|environment|asset/, "Scène 3D"], [/course/, "Cours"], [/program/, "Parcours"], [/evaluation/, "Évaluation"], [/block|game/, "Bloc"],
];
export function labelFor(tool: string, op: ChangeOp, title?: string): string {
  const noun = NOUN.find(([re]) => re.test(tool))?.[1] ?? "Contenu";
  const verb = op === "create" ? "ajouté" : op === "delete" ? "supprimé" : op === "reorder" ? "réordonné" : "modifié";
  return title ? `${noun} ${verb} · ${title.slice(0, 48)}` : `${noun} ${verb}`;
}

export function viewerUrl(front: string, entity: Entity, id: string, extra: { propsId?: string } = {}): string {
  switch (entity) {
    case "course": return `${front}/lms/courses/${id}/slideshow?live=1&embedded=1`;
    case "program": return `${front}/lms/programs?program=${id}&live=1`;
    case "evaluation": return `${front}/lms/evaluations/${id}/play?live=1`;
    case "scene": return `${front}/edverse/editor/${id}?live=1`;
    case "block": return previewUrl(front, id, extra.propsId);
  }
}

/** Mexty's block runtime page: the block with exactly this props variant. */
export function previewUrl(front: string, blockId: string, propsId?: string, edverse = false): string {
  return `${front}/preview.html?blockId=${blockId}${propsId ? `&propsId=${propsId}` : ""}${edverse ? "&edverse=1" : ""}`;
}

/** Where a finished content opens for someone to try it: the learner view, not the editor or live mode. */
export function openUrl(front: string, entity: Entity, id: string, extra: { propsId?: string; edverse?: boolean; game?: { blockId: string; propsId?: string } } = {}): string {
  switch (entity) {
    case "course": return `${front}/lms/courses/${id}/slideshow?embedded=1`;
    // embedded=1: the page alone, without the workspace top bar and sidebar.
    case "program": return `${front}/lms/programs?program=${id}&embedded=1`;
    case "evaluation": return `${front}/lms/evaluations/${id}/play?embedded=1`;
    case "block": return previewUrl(front, id, extra.propsId, extra.edverse);
    // A scene is played through its game (the block that holds it); without one, the editor is all there is.
    case "scene": return extra.game ? previewUrl(front, extra.game.blockId, extra.game.propsId, true) : `${front}/edverse/editor/${id}`;
  }
}
export const ENTITY_LABEL: Record<Entity, string> = { course: "COURS", program: "PARCOURS", evaluation: "ÉVALUATION", block: "BLOC", scene: "BLOC 3D" };
