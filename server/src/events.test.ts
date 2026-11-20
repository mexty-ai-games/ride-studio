import assert from "node:assert/strict";
import { test } from "node:test";
import { deriveChange, viewerUrl } from "./events.js";

test("add_slide: course id from args, slide id from result wrapper", () => {
  const d = deriveChange("mcp__MEXTY__add_slide", { courseId: "66f0aa11bb22cc33dd44ee55", title: "Les vagues" }, JSON.stringify({ success: true, slide: { id: "8b1e6c1e-1111-2222-3333-444455556666" } }));
  assert.ok(d);
  assert.equal(d.event.entity, "course");
  assert.equal(d.event.entityId, "66f0aa11bb22cc33dd44ee55");
  assert.equal(d.event.path.slideId, "8b1e6c1e-1111-2222-3333-444455556666");
  assert.equal(d.event.op, "create");
  assert.match(d.event.label!, /Écran ajouté/);
});
test("create_course: id from result", () => {
  const d = deriveChange("mcp__MEXTY__create_course", { title: "Sécurité des bassins" }, JSON.stringify({ course: { id: "66f0aa11bb22cc33dd44ee55" } }));
  assert.equal(d?.event.entityId, "66f0aa11bb22cc33dd44ee55");
  assert.equal(d?.title, "Sécurité des bassins");
});
test("update_slide keeps op update; snake_case ids", () => {
  const d = deriveChange("mcp__MEXTY__update_slide", { course_id: "66f0aa11bb22cc33dd44ee55", slide_id: "slide-123456" }, '{"success":true,"slideId":"slide-123456"}');
  assert.equal(d?.event.op, "update");
  assert.equal(d?.event.path.slideId, "slide-123456");
});
test("program node and evaluation step", () => {
  const n = deriveChange("mcp__MEXTY__add_program_node", { programId: "66f0aa11bb22cc33dd44ee77", name: "Module 1" }, JSON.stringify({ node: { id: "node-abcdef" } }));
  assert.equal(n?.event.entity, "program");
  assert.equal(n?.event.path.nodeId, "node-abcdef");
  const s = deriveChange("mcp__MEXTY__add_evaluation_step", { evaluationId: "66f0aa11bb22cc33dd44ee88" }, JSON.stringify({ step: { id: "step-abcdef" }, stepCount: 3 }));
  assert.equal(s?.event.entity, "evaluation");
  assert.equal(s?.event.path.stepId, "step-abcdef");
});
test("edverse scene edit", () => {
  const d = deriveChange("mcp__EDVERSE__edit_scene", { sceneId: "66f0aa11bb22cc33dd44ee99", ops: [{ op: "add", name: "Bouée" }] }, '{"version":4}');
  assert.equal(d?.event.entity, "scene");
});
test("reads, failures and non-MCP tools give nothing", () => {
  assert.equal(deriveChange("mcp__MEXTY__get_course", { courseId: "66f0aa11bb22cc33dd44ee55" }, "{}"), null);
  assert.equal(deriveChange("mcp__MEXTY__add_slide", { courseId: "66f0aa11bb22cc33dd44ee55" }, '{"success":false}'), null);
  assert.equal(deriveChange("Bash", { command: "ls" }, ""), null);
});
test("viewer urls open live mode", () => {
  assert.equal(viewerUrl("https://w", "course", "c1"), "https://w/lms/courses/c1/slideshow?live=1&embedded=1");
  assert.equal(viewerUrl("https://w", "program", "p1"), "https://w/lms/programs?program=p1&live=1");
});

import { serverAllowed, serverOf } from "../../shared/protocol.js";

test("MCP servers are matched by name, whatever the prefix Claude Code gives them", () => {
  const allowed = ["mcp__MEXTY", "mcp__EDVERSE"];
  for (const s of ["MEXTY", "mexty", "claude_ai_MEXTY", "claude.ai Mexty", "EdVerse"]) assert.ok(serverAllowed(s, allowed), s);
  for (const s of ["github", "Gmail", "filesystem"]) assert.equal(serverAllowed(s, allowed), false, s);
  assert.equal(serverOf("mcp__claude_ai_MEXTY__add_slide"), "claude_ai_MEXTY");
  assert.equal(serverOf("mcp__MEXTY__save_block_props"), "MEXTY");
  assert.equal(serverOf("Bash"), null);
});
test("changes are recognised with a prefixed server name and an empty error field", () => {
  const d = deriveChange("mcp__claude_ai_EdVerse__edit_scene", { scene_id: "66f0aa11bb22cc33dd44ee99", ops: [{ op: "create" }] }, '{"version":3,"error":null,"applied":1}');
  assert.equal(d?.event.entity, "scene");
  assert.equal(d?.event.entityId, "66f0aa11bb22cc33dd44ee99");
  const e = deriveChange("mcp__MEXTY__add_slide", { courseId: "66f0aa11bb22cc33dd44ee55" }, 'Slide added.\n{"success":true,"slide":{"id":"slide-abcdef"}}');
  assert.equal(e?.event.path.slideId, "slide-abcdef");
  assert.equal(deriveChange("mcp__MEXTY__add_slide", { courseId: "66f0aa11bb22cc33dd44ee55" }, '{"error":"Course not found"}'), null);
});
