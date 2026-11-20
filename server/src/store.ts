import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.js";

export type SecretName = "anthropic" | "elevenlabs" | "deepgram" | "openai";
export const SECRET_NAMES: SecretName[] = ["anthropic", "elevenlabs", "deepgram", "openai"];

export interface DeviceRecord {
  id: string;
  name: string;
  tokenHash: string;
  enabled: boolean;
  concurrency: number;
  pairedAt: number;
  lastSeen: number;
  platform?: string;
  claudeCodeVersion?: string | null;
}

export interface Settings {
  claude: {
    directorModel: string;
    workerModel: string;
    /** Permission profile: MCP tool prefixes a worker may call. Nothing else is allowed. */
    allowedTools: string[];
    maxTurns: number;
    workspace: string;
    templates: string[];
  };
  voice: {
    sttVendor: "elevenlabs" | "deepgram" | "openai";
    language: string;
    languageHints: string[];
    ttsVoiceId: string;
    ttsModel: string;
    /** 0..1 — higher = Claude stops more easily when the rider speaks. */
    bargeIn: number;
    sttModels: { elevenlabs: string; deepgram: string; openai: string };
  };
  budget: { capUsd: number };
  cloud: { enabled: boolean; concurrency: number; agentId: string; agentVersion: number | null; environmentId: string; vaultId: string };
  mexty: { frontUrl: string; apiUrl: string; mcpUrl: string; edverseMcpUrl: string; preview: "auto" | "mexty" | "mock" };
}

export const DEFAULT_SETTINGS: Settings = {
  claude: {
    directorModel: "claude-haiku-5-5",
    workerModel: "claude-sonnet-5-5",
    allowedTools: ["mcp__MEXTY", "mcp__EDVERSE"],
    maxTurns: 120,
    workspace: "",
    templates: ["AI Act", "Compliance Legal", "Vierge"],
  },
  voice: {
    sttVendor: "elevenlabs",
    language: "fr",
    languageHints: ["Mexty", "EdVerse", "Claude", "quiz", "parcours"],
    ttsVoiceId: "",
    ttsModel: "eleven_flash_v2_5",
    bargeIn: 0.5,
    sttModels: { elevenlabs: "scribe_v3_live", deepgram: "flux-general-multi", openai: "gpt-transcribe" },
  },
  budget: { capUsd: 30 },
  cloud: { enabled: false, concurrency: 2, agentId: "", agentVersion: null, environmentId: "", vaultId: "" },
  mexty: {
    frontUrl: "https://workspace.mexty.ai",
    apiUrl: "https://api.mexty.ai",
    mcpUrl: "https://mcp.mexty.ai/mcp/mexty",
    edverseMcpUrl: "https://mcp.mexty.ai/mcp/edverse",
    preview: "auto",
  },
};

export interface EpisodeRecord {
  id: string;
  no: number;
  company: string;
  topic: string;
  destination?: string;
  etaMin?: number;
  beats?: { label: string; ts: number }[];
  startedAt: number;
  endedAt: number;
  cost: { director: number; total: number; elevenlabs?: number; otherApis?: number; cloud?: number; planEquivalent?: number; voice?: number; workers?: number; plan?: unknown };
  stats: Record<string, number>;
  delivered: { entity: string; entityId: string; title: string; url?: string }[];
}

interface Db {
  settings: Settings;
  secrets: Partial<Record<SecretName, string>>; // encrypted
  devices: DeviceRecord[];
  episodes: EpisodeRecord[];
}

const file = join(config.dataDir, "ride-studio.json");

function enc(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", config.settingsKey, iv);
  const body = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return [iv, c.getAuthTag(), body].map((b) => b.toString("base64")).join(".");
}
function dec(blob: string): string | null {
  try {
    const [iv, tag, body] = blob.split(".").map((s) => Buffer.from(s, "base64"));
    const d = createDecipheriv("aes-256-gcm", config.settingsKey, iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(body), d.final()]).toString("utf8");
  } catch {
    return null; // key rotated: the secret has to be entered again
  }
}

function merge<T>(base: T, over: unknown): T {
  if (!over || typeof over !== "object" || Array.isArray(over) || !base || typeof base !== "object" || Array.isArray(base)) {
    return (over === undefined ? base : (over as T));
  }
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(over as Record<string, unknown>)) {
    if (k in out) out[k] = merge(out[k], v);
  }
  return out as T;
}

function load(): Db {
  const empty: Db = { settings: structuredClone(DEFAULT_SETTINGS), secrets: {}, devices: [], episodes: [] };
  if (!existsSync(file)) return empty;
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<Db>;
    return {
      settings: merge(structuredClone(DEFAULT_SETTINGS), raw.settings),
      secrets: raw.secrets ?? {},
      devices: raw.devices ?? [],
      episodes: raw.episodes ?? [],
    };
  } catch (e) {
    console.error("[store] unreadable data file, starting empty:", e);
    return empty;
  }
}

const db = load();
let timer: NodeJS.Timeout | null = null;
function save() {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    const tmp = file + ".tmp";
    writeFileSync(tmp, JSON.stringify(db, null, 1));
    renameSync(tmp, file);
  }, 150);
}

export const sha = (s: string) => createHash("sha256").update(s).digest("hex");

export const store = {
  get settings(): Settings {
    return db.settings;
  },
  patchSettings(patch: unknown) {
    db.settings = merge(db.settings, patch);
    save();
  },
  secret(name: SecretName): string | null {
    const env = process.env[`${name.toUpperCase()}_API_KEY`];
    if (env) return env;
    const blob = db.secrets[name];
    return blob ? dec(blob) : null;
  },
  setSecret(name: SecretName, value: string) {
    if (value) db.secrets[name] = enc(value.trim());
    else delete db.secrets[name];
    save();
  },
  /** What the phone may see: presence and last 4 characters only. */
  secretsView() {
    return Object.fromEntries(
      SECRET_NAMES.map((n) => {
        const v = store.secret(n);
        return [n, v ? { set: true, last4: v.slice(-4) } : { set: false, last4: "" }];
      }),
    ) as Record<SecretName, { set: boolean; last4: string }>;
  },
  get devices() {
    return db.devices;
  },
  addDevice(name: string): { device: DeviceRecord; token: string } {
    const token = randomBytes(32).toString("base64url");
    const device: DeviceRecord = { id: randomUUID(), name, tokenHash: sha(token), enabled: true, concurrency: 2, pairedAt: Date.now(), lastSeen: 0 };
    db.devices.push(device);
    save();
    return { device, token };
  },
  deviceByToken(token: string) {
    const h = sha(token);
    return db.devices.find((d) => d.tokenHash === h) ?? null;
  },
  touchDevices() {
    save();
  },
  removeDevice(id: string) {
    db.devices = db.devices.filter((d) => d.id !== id);
    save();
  },
  get episodes() {
    return db.episodes;
  },
  addEpisode(e: EpisodeRecord) {
    db.episodes.push(e);
    save();
  },
  removeEpisode(id: string) {
    db.episodes = db.episodes.filter((e) => e.id !== id);
    save();
  },
};
