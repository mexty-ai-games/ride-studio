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

export interface CostState {
  director: number;
  voice: number;
  workers: number;
  total: number;
  cap: number;
  warned: boolean;
  capped: boolean;
}

export interface EpisodeState {
  id: string;
  no: number;
  setup: EpisodeSetup;
  startedAt: number;
  endedAt?: number;
  status: "live" | "ended";
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
}

// ---- phone <-> server (JSON text frames) ----
export type PhoneToServer =
  | { t: "episode.start"; setup: EpisodeSetup }
  | { t: "episode.end" }
  | { t: "stt.start"; bakeoff?: boolean; vendors?: string[] }
  | { t: "stt.stop" }
  | { t: "bargein" }
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
  | { kind: "result"; ok: boolean; sessionId?: string; costUsd: number; turns: number; summary: string }
  | { kind: "error"; message: string };

export type DeviceToServer =
  | DeviceHello
  | { t: "status"; active: string[]; concurrency: number }
  | { t: "task.event"; taskId: string; event: TaskEvent };

export type ServerToDevice = TaskRun | { t: "task.stop"; taskId: string } | { t: "welcome"; deviceId: string; name: string };

/** MCP tool name → bare tool ("mcp__MEXTY__add_slide" → "add_slide"). */
export function bareTool(name: string): string {
  const m = /^mcp__[^_]+(?:_[^_]+)*__(.+)$/.exec(name);
  return m ? m[1] : name;
}
