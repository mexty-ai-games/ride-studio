#!/usr/bin/env node
import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, hostname, platform } from "node:os";
import { join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import WebSocket from "ws";
import { serverAllowed, serverOf, type DeviceToServer, type ServerToDevice, type TaskEvent, type TaskRun } from "../../shared/protocol.js";

const VERSION = "0.1.0";
const dir = join(homedir(), ".ride-agent");
const cfgFile = join(dir, "config.json");
const workDir = join(dir, "work"); // neutral cwd: no project settings, no repository
interface Cfg {
  server: string;
  token: string;
  name: string;
  concurrency: number;
  mcpServers?: { name: string; status: string }[];
}

function load(): Cfg | null {
  try {
    return JSON.parse(readFileSync(cfgFile, "utf8"));
  } catch {
    return null;
  }
}
function save(c: Cfg) {
  mkdirSync(workDir, { recursive: true });
  writeFileSync(cfgFile, JSON.stringify(c, null, 2));
  try {
    chmodSync(cfgFile, 0o600);
  } catch {
    /* Windows */
  }
}
const arg = (flag: string) => {
  const i = process.argv.indexOf(flag);
  return i > 0 ? process.argv[i + 1] : undefined;
};

async function pair() {
  const code = process.argv[3];
  const server = (arg("--server") || process.env.RIDE_STUDIO_URL || "").replace(/\/$/, "");
  if (!code || !server) {
    console.error("Usage: npm run agent -- pair <code> --server https://<ride-studio-host> [--name aiden]");
    process.exit(1);
  }
  const name = arg("--name") || hostname();
  const r = await fetch(`${server}/api/devices/pair`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code, name }) });
  if (!r.ok) {
    console.error(`Pairing failed (${r.status}): ${await r.text()}`);
    process.exit(1);
  }
  const j = (await r.json()) as { token: string; name: string };
  save({ server, token: j.token, name: j.name, concurrency: 2 });
  console.log(`Paired as "${j.name}". Start the daemon with: npm run agent`);
}

function claudeVersion(): Promise<string | null> {
  return new Promise((res) => execFile(platform() === "win32" ? "claude.cmd" : "claude", ["--version"], { timeout: 8000, shell: platform() === "win32" }, (err, out) => res(err ? null : out.trim().split("\n")[0])));
}

// Rough list prices (USD / Mtok: input, output, cache read) for the running estimate; the final figure comes from the SDK.
const PRICE: Record<string, [number, number, number]> = { haiku: [0.1, 0.5, 0.01], sonnet: [2, 10, 0.1], opus: [4, 20, 0.2] };
const price = (model: string) => PRICE[Object.keys(PRICE).find((k) => model.includes(k)) ?? "sonnet"];

function runTask(cfg: Cfg, task: TaskRun, emit: (e: TaskEvent) => void): AbortController {
  const abort = new AbortController();
  // Least privilege: no built-in tools at all, and only MCP tools of the allowed servers (MEXTY, EDVERSE).
  const permitted = (tool: string) => {
    const server = serverOf(tool);
    return !!server && serverAllowed(server, task.allowedTools);
  };
  let estimate = 0;
  const counted = new Set<string>();
  let sessionId: string | undefined;
  const names = new Map<string, string>();
  (async () => {
    const stream = query({
      prompt: task.brief,
      options: {
        cwd: workDir,
        model: task.model,
        resume: task.resume,
        maxTurns: task.maxTurns,
        abortController: abort,
        tools: [],
        permissionMode: "default",
        canUseTool: async (toolName, input) => {
          if (permitted(toolName)) return { behavior: "allow", updatedInput: input };
          emit({ kind: "text", text: `Outil refusé : ${toolName}` });
          return { behavior: "deny", message: "Ride Studio workers may only use the MEXTY and EDVERSE tools." };
        },
        systemPrompt: { type: "preset", preset: "claude_code", append: task.systemAppend },
      },
    });
    for await (const m of stream) {
      if (m.type === "system" && m.subtype === "init") {
        sessionId = m.session_id;
        cfg.mcpServers = m.mcp_servers.map((s) => ({ name: s.name, status: s.status }));
        save(cfg);
        emit({ kind: "init", sessionId: m.session_id, mcpServers: cfg.mcpServers, model: m.model });
        // Remote servers are often still "pending" when the session starts: only a server that is absent,
        // failed, waiting for a login or disabled counts as unusable.
        const usable = m.mcp_servers.filter((s) => serverAllowed(s.name, task.allowedTools) && (s.status === "connected" || s.status === "pending"));
        if (!usable.length) {
          // Without them the model can only answer in words: stop now and say why, instead of "done".
          const seen = m.mcp_servers.map((s) => `${s.name} (${s.status})`).join(", ") || "aucun";
          emit({ kind: "error", message: `Mexty n'est pas connecté dans Claude Code sur cet appareil. Serveurs MCP vus : ${seen}.` });
          abort.abort();
          return;
        }
      } else if (m.type === "assistant") {
        // One API response can arrive as several assistant messages (one per block), each repeating the same
        // usage: count each response once, or the estimate overshoots and drops back at the final figure.
        const u = m.message.usage;
        const [pi, po, pc] = price(task.model);
        if (!counted.has(m.message.id)) {
          counted.add(m.message.id);
          estimate += ((u.input_tokens + (u.cache_creation_input_tokens ?? 0) * 1.25) * pi + u.output_tokens * po + (u.cache_read_input_tokens ?? 0) * pc) / 1e6;
        }
        for (const b of m.message.content) {
          if (b.type === "text" && b.text.trim()) emit({ kind: "text", text: b.text.trim().slice(0, 600) });
          else if (b.type === "tool_use") {
            names.set(b.id, b.name);
            emit({ kind: "tool_use", id: b.id, name: b.name, input: b.input });
          }
        }
        emit({ kind: "usage", costUsd: estimate });
      } else if (m.type === "user" && Array.isArray(m.message.content)) {
        for (const b of m.message.content) {
          if (b.type !== "tool_result") continue;
          const out = typeof b.content === "string" ? b.content : (b.content ?? []).map((c) => (c.type === "text" ? c.text : "")).join("");
          emit({ kind: "tool_result", id: b.tool_use_id, name: names.get(b.tool_use_id), isError: !!b.is_error, output: out.slice(0, 20_000) });
        }
      } else if (m.type === "result") {
        emit({ kind: "result", ok: m.subtype === "success" && !m.is_error, sessionId: m.session_id, costUsd: m.total_cost_usd, turns: m.num_turns, summary: (m.subtype === "success" ? m.result : `Arrêt : ${m.subtype}`).slice(0, 600) });
      }
    }
  })().catch((e: Error) => {
    if (abort.signal.aborted) emit({ kind: "result", ok: false, sessionId, costUsd: estimate, turns: 0, summary: "Arrêté." });
    else emit({ kind: "error", message: e.message });
  });
  return abort;
}

async function daemon() {
  const cfg = load();
  if (!cfg) {
    console.error("Not paired yet. Run: npm run agent -- pair <code> --server https://<ride-studio-host>");
    process.exit(1);
  }
  mkdirSync(workDir, { recursive: true });
  const version = await claudeVersion();
  const active = new Map<string, AbortController>();
  let backoff = 1000;

  const connect = () => {
    // Outbound only: no inbound port is opened on this machine.
    const ws = new WebSocket(cfg.server.replace(/^http/, "ws") + "/ws/device", { headers: { Authorization: `Bearer ${cfg.token}` } });
    const send = (m: DeviceToServer) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(m));
    let ping: NodeJS.Timeout | null = null;
    ws.on("open", () => {
      backoff = 1000;
      console.log(`[ride-agent] connected to ${cfg.server} as "${cfg.name}"`);
      send({ t: "hello", name: cfg.name, platform: `${platform()} · node ${process.versions.node}`, agentVersion: VERSION, claudeCodeVersion: version, mcpServers: cfg.mcpServers ?? [], concurrency: cfg.concurrency });
      ping = setInterval(() => (ws.ping(), send({ t: "status", active: [...active.keys()], concurrency: cfg.concurrency })), 25_000);
    });
    ws.on("message", (raw) => {
      let m: ServerToDevice;
      try {
        m = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (m.t === "task.run") {
        const task = m;
        console.log(`[ride-agent] task ${task.taskId.slice(0, 8)} ${task.resume ? "(resume)" : "(new)"}: ${task.brief.slice(0, 80)}`);
        const ctl = runTask(cfg, task, (event) => {
          if (event.kind === "result" || event.kind === "error") active.delete(task.taskId);
          send({ t: "task.event", taskId: task.taskId, event });
        });
        active.set(task.taskId, ctl);
      } else if (m.t === "task.stop") {
        if (m.taskId === "*") {
          console.log(`[ride-agent] stop all (${active.size} running)`);
          for (const ctl of active.values()) ctl.abort();
        } else active.get(m.taskId)?.abort();
      }
    });
    ws.on("unexpected-response", (_q, res) => {
      if (res.statusCode === 401) {
        console.error("[ride-agent] this device is no longer paired. Pair it again from Settings.");
        process.exit(2);
      }
    });
    ws.on("error", (e) => console.warn(`[ride-agent] ${e.message}`));
    ws.on("close", () => {
      if (ping) clearInterval(ping);
      setTimeout(connect, backoff);
      backoff = Math.min(30_000, backoff * 2);
    });
  };
  connect();
}

if (process.argv[2] === "pair") void pair();
else if (process.argv[2] === "status") console.log(existsSync(cfgFile) ? `Paired with ${load()?.server} as "${load()?.name}"` : "Not paired.");
else void daemon();
