// Wire protocol shared by the phone PWA, the backend and the device agent.

export type Entity = "program" | "course" | "evaluation" | "block" | "scene";
export type ChangeOp = "create" | "update" | "delete" | "reorder";

/** Granular content change. Same core shape as Mexty's `content:changed` event. */
export interface ChangeEvent {
  episodeId?: string;
  workerId?: string;
  entity: Entity;
  entityId: string;
  path: { slideId?: string; elementId?: string; nodeId?: string; stepId?: string; objectId?: string; propsId?: string };
  op: ChangeOp;
  tool?: string;
  /** Short human label, e.g. "Écran 3 · titre". */
  label?: string;
  /** Where the event came from: Mexty backend (primary) or the worker's own tool call (secondary). */
  source: "mexty" | "tool" | "stub";
  ts: number;
}

export interface EpisodeSetup {
  company: string;
  destination: string;
  etaMin: number;
  topic: string;
  template: string;
  budgetCap: number;
  wide: boolean; // also record the 16:9 canvas
}

export type LayoutMode = "auto" | "single" | "split" | "grid";

export interface TileState {
  slot: number; // 0..3, also the id in binary preview frames
  workerId: string;
  workerNo: number; // "CLAUDE n"
  entity: Entity;
  entityId: string;
  title: string;
  step: string;
  lastChangeTs: number;
  lastChange?: ChangeEvent;
  mode: "mexty" | "mock";
  /** Where the finished content opens for a person to try it (learner view, block preview.html with its props). */
  url?: string;
}

/** A content built during the episode, as the rider names it ("Cours 1", "Programme d'étude"). */
export interface ContentLink {
  key: string;
  name: string;
  entity: Entity;
  title: string;
  url: string;
  /** The same content in Mexty's editor (legacy block editor, EdVerse 3D editor, course slides…). */
  editUrl: string;
  slot: number | null;
  done: boolean;
}

export interface WorkerState {
  id: string;
  no: number;
  brief: string;
  runner: "device" | "cloud" | "stub";
  deviceName?: string;
  status: "queued" | "running" | "idle" | "done" | "error" | "stopped";
  step: string;
  changes: number;
  costUsd: number;
  startedAt: number;
  error?: string;
}

/** One window of the Claude plan's usage limit, in percent; `start` is the reading at the start of the episode. */
export interface PlanWindow {
  pct: number;
  start: number;
  resetsAt: string | null;
}
export interface PlanUsage {
  /** "pro", "max", "team"… */
  subscription: string | null;
  fiveHour: PlanWindow | null;
  sevenDay: PlanWindow | null;
  ts: number;
}

/** Spend of the episode, in USD, by who bills it. */
export interface CostState {
  /** The voice (orchestrator): Claude API, billed to the Anthropic key. */
  director: number;
  /** Claude's voice and the Scribe transcription. */
  elevenlabs: number;
  /** Deepgram or OpenAI transcription. */
  otherApis: number;
  /** Workers on Claude Managed Agents, billed to the Anthropic key. */
  cloud: number;
  /** Workers on the rider's machines run on the Claude plan: what they would cost on the API, not billed. */
  planEquivalent: number;
  /** Money actually spent: director + elevenlabs + otherApis + cloud. The cap applies to this. */
  total: number;
  cap: number;
  warned: boolean;
  capped: boolean;
  plan: PlanUsage | null;
}

export interface EpisodeState {
  id: string;
  no: number;
  setup: EpisodeSetup;
  startedAt: number;
  endedAt?: number;
  status: "live" | "ended";
  /** "arrived": the ride is over (the chrono stops) but the episode and the recording go on. */
  phase: "ride" | "arrived";
  arrivedAt?: number;
  beats: { label: string; ts: number }[];
  delivered: { entity: Entity; entityId: string; title: string; url?: string }[];
  stats: { slides: number; questions: number; nodes: number; objects: number; changes: number };
}

export interface Readiness {
  director: boolean; // Anthropic key present
  stt: string[]; // vendors with a key
  tts: boolean;
  devicesOnline: number;
  cloud: boolean;
  mexty: boolean; // service session can be minted
  stub: boolean; // demo mode: no real workers available
  /** The ride can be shared with guests (plain WebRTC, always on). */
  share: boolean;
}

/** A Radio Monkey track as the phone plays it. */
export interface RadioTrackView {
  id: string;
  title: string;
  artist: string;
  durationSec?: number;
  cover?: string;
  url: string;
}

/** Radio Monkey: music under the episode, on and off only when Fabien asks. */
export interface RadioState {
  on: boolean;
  track: RadioTrackView | null;
  /** When the current track started on air (the phone joins mid-track at the right offset). */
  startedAt: number;
  /** Tracks available to play. */
  library: number;
}

export interface StudioState {
  episode: EpisodeState | null;
  workers: WorkerState[];
  tiles: TileState[];
  layout: LayoutMode;
  focus: number | null;
  cost: CostState;
  readiness: Readiness;
  speaking: boolean;
  /** The phone records while "on"; "paused" closes the current file, "on" again starts the next one. */
  rec: "on" | "paused";
  camera: "user" | "environment";
  /** A content shown to someone: full picture in the recording and open on the phone. */
  show: { key: string | null; qr: boolean };
  contents: ContentLink[];
  radio: RadioState;
}

// ---- phone <-> server (JSON text frames) ----
export type PhoneToServer =
  | { t: "episode.start"; setup: EpisodeSetup }
  | { t: "episode.end" }
  | { t: "arrive" }
  | { t: "rec"; action: "pause" | "resume" }
  /** Who is speaking: speech frames from the phone (its mic with the pitch, or a guest's stream), every ~0.5 s. */
  | { t: "voice"; now: number; frames: { ts: number; src: string; f0?: number }[] }
  | { t: "camera"; facing?: "user" | "environment" }
  | { t: "show"; key: string | null }
  | { t: "qr"; on: boolean }
  | { t: "radio"; action: "on" | "off" | "next" }
  /** The phone finished playing a track (next one, please) or learnt its length. */
  | { t: "radio.ended"; trackId: string }
  | { t: "radio.meta"; trackId: string; durationSec: number }
  | { t: "stt.start"; bakeoff?: boolean; vendors?: string[] }
  | { t: "stt.stop" }
  | { t: "bargein" }
  /** Emergency stop: every running agent and the voice, at once. The episode and the recording go on. */
  | { t: "stop" }
  | { t: "text"; text: string }
  | { t: "ping"; ts: number };

export type ServerToPhone =
  | { t: "state"; state: StudioState }
  | { t: "stt"; vendor: string; kind: "partial" | "final" | "eot" | "error" | "open"; text?: string; ts: number; ms?: number }
  | { t: "user"; text: string }
  | { t: "say"; id: number; text: string; audio: boolean }
  | { t: "tts.end"; id: number }
  | { t: "tts.cancel" }
  | { t: "change"; event: ChangeEvent; slot: number | null }
  | { t: "beat"; label: string; ts: number }
  /** A piece of content started or finished: the phone plays its bird phrase. */
  | { t: "cue"; kind: "started" | "finished"; entity: Entity; slot: number | null }
  | { t: "bakeoff.saved"; id: string; url: string; seconds: number }
  | { t: "pong"; ts: number }
  | { t: "error"; message: string };

// Binary frames: first byte is the kind.
export const BIN_MIC = 0x01; // phone -> server: PCM16LE mono 16 kHz
export const BIN_TTS = 0x02; // server -> phone: [0x02][u32 utterance id LE] PCM16LE mono 24 kHz
export const BIN_FRAME = 0x03; // server -> phone: [0x03][u8 slot] JPEG
export const MIC_RATE = 16000;
export const TTS_RATE = 24000;

// ---- device agent <-> server ----
export interface DeviceHello {
  t: "hello";
  name: string;
  platform: string;
  agentVersion: string;
  claudeCodeVersion: string | null;
  mcpServers: { name: string; status: string }[];
  concurrency: number;
}

export interface TaskRun {
  t: "task.run";
  taskId: string;
  /** Agent SDK session to resume, so follow-ups keep their context. */
  resume?: string;
  brief: string;
  model: string;
  allowedTools: string[];
  systemAppend: string;
  maxTurns: number;
}

export type TaskEvent =
  | { kind: "init"; sessionId: string; mcpServers: { name: string; status: string }[]; model: string }
  | { kind: "text"; text: string }
  | { kind: "tool_use"; id: string; name: string; input: unknown }
  | { kind: "tool_result"; id: string; name?: string; isError: boolean; output: string }
  | { kind: "usage"; costUsd: number }
  /** Claude plan usage limits, read on the machine (Claude Code's /usage). */
  | { kind: "plan"; subscription: string | null; fiveHour: { pct: number; resetsAt: string | null } | null; sevenDay: { pct: number; resetsAt: string | null } | null }
  | { kind: "result"; ok: boolean; sessionId?: string; costUsd: number; turns: number; summary: string }
  | { kind: "error"; message: string };

export type DeviceToServer =
  | DeviceHello
  | { t: "status"; active: string[]; concurrency: number }
  | { t: "task.event"; taskId: string; event: TaskEvent };

/** `taskId: "*"` stops every task on the device. */
export type ServerToDevice = TaskRun | { t: "task.stop"; taskId: string } | { t: "welcome"; deviceId: string; name: string };

/** Letters and digits only, lowercase: "claude.ai MEXTY" → "claudeaimexty". */
const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
/** "mcp__MEXTY" → "mexty". */
const allowedKey = (p: string) => squash(p.replace(/^mcp__/i, ""));
/**
 * Is this MCP server one of the allowed ones? Names vary with how the server was added to Claude Code
 * ("MEXTY", "mexty", "claude.ai MEXTY", …), so the allowed name only has to appear in it.
 */
export function serverAllowed(server: string, allowedTools: string[]): boolean {
  const s = squash(server);
  return allowedTools.some((p) => s.includes(allowedKey(p)));
}
/** "mcp__claude_ai_MEXTY__add_slide" → "claude_ai_MEXTY" (null for a built-in tool). */
export function serverOf(tool: string): string | null {
  const m = /^mcp__(.+?)__[^_].*$/.exec(tool);
  return m ? m[1] : null;
}

/** MCP tool name → bare tool ("mcp__MEXTY__add_slide" → "add_slide"). */
export function bareTool(name: string): string {
  const m = /^mcp__[^_]+(?:_[^_]+)*__(.+)$/.exec(name);
  return m ? m[1] : name;
}
