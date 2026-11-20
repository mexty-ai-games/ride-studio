#!/usr/bin/env node
import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, hostname, platform } from "node:os";
import { join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import WebSocket from "ws";
import { serverAllowed, serverOf, type DeviceToServer, type ServerToDevice, type TaskEvent, type TaskRun } from "../../shared/protocol.js";

const VERSION = "0.1.1";
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
/** Verbose logs: full tool inputs and outputs (`npm run agent -- --verbose`, or RIDE_AGENT_VERBOSE=1). */
const VERBOSE = process.argv.includes("--verbose") || process.env.RIDE_AGENT_VERBOSE === "1";
const clock = () => new Date().toTimeString().slice(0, 8);
const oneLine = (v: unknown, max: number) => {
  const s = (typeof v === "string" ? v : JSON.stringify(v) ?? "").replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
};
/** One line per thing that happens, prefixed with the time and, for a task, its short id. */
function log(msg: string, task?: string) {
  console.log(`${clock()} ${task ? `[${task}] ` : ""}${msg}`);
}
/** What a task is doing, as it happens: what Claude Code says, each MEXTY / EDVERSE call and how it went. */
function logEvent(tag: string, e: TaskEvent, started: number) {
  switch (e.kind) {
    case "init":
      log(`Claude Code ready · model ${e.model} · MCP: ${e.mcpServers.map((m) => `${m.name} (${m.status})`).join(", ") || "none"}`, tag);
      break;
    case "text":
      log(`says: ${oneLine(e.text, VERBOSE ? 2000 : 160)}`, tag);
      break;
    case "tool_use":
      log(`→ ${e.name.replace(/^mcp__/, "")} ${oneLine(e.input, VERBOSE ? 4000 : 140)}`, tag);
      break;
    case "tool_result":
      if (e.isError || VERBOSE) log(`${e.isError ? "✗" : "✓"} ${(e.name ?? "").replace(/^mcp__/, "")} ${oneLine(e.output, VERBOSE ? 4000 : 240)}`, tag);
      else log(`✓ ${(e.name ?? "").replace(/^mcp__/, "")}`, tag);
      break;
    case "result":
      log(`${e.ok ? "done" : "stopped"} in ${Math.round((Date.now() - started) / 1000)} s · ${e.turns} turns · $${(e.costUsd ?? 0).toFixed(3)} · ${oneLine(e.summary, 200)}`, tag);
      break;
    case "error":
      log(`ERROR: ${e.message}`, tag);
      break;
    case "plan":
      if (e.fiveHour) log(`Claude plan: ${Math.round(e.fiveHour.pct)} % of the 5-hour window used`, tag);
      break;
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
  // On Windows the shell finds claude.exe (native install) as well as claude.cmd (npm install).
  return new Promise((res) => execFile("claude", ["--version"], { timeout: 8000, shell: platform() === "win32" }, (err, out) => res(err ? null : out.trim().split("\n")[0])));
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
  /**
   * Claude plan usage (5-hour and 7-day windows), as Claude Code's /usage shows it. The SDK marks this API as
   * experimental: when it is missing or fails, nothing is sent and the studio shows the API equivalent only.
   */
  let planTimer: NodeJS.Timeout | null = null;
  const readPlan = async (q: unknown) => {
    const fn = (q as { usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET?: (o: { skipBehaviors: boolean }) => Promise<any> }).usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET;
    if (typeof fn !== "function") return;
    try {
      const u = await fn.call(q, { skipBehaviors: true });
      if (!u?.rate_limits_available || !u.rate_limits) return;
      const w = (x: { utilization: number | null; resets_at: string | null } | null | undefined) => (x && typeof x.utilization === "number" ? { pct: x.utilization, resetsAt: x.resets_at ?? null } : null);
      emit({ kind: "plan", subscription: u.subscription_type ?? null, fiveHour: w(u.rate_limits.five_hour), sevenDay: w(u.rate_limits.seven_day) });
    } catch {
      /* experimental API: ignore */
    }
  };
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
        void readPlan(stream);
        planTimer = setInterval(() => void readPlan(stream), 90_000);
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
        if (planTimer) clearInterval(planTimer);
        await readPlan(stream);
        emit({ kind: "result", ok: m.subtype === "success" && !m.is_error, sessionId: m.session_id, costUsd: m.total_cost_usd, turns: m.num_turns, summary: (m.subtype === "success" ? m.result : `Arrêt : ${m.subtype}`).slice(0, 600) });
      }
    }
  })().finally(() => planTimer && clearInterval(planTimer)).catch((e: Error) => {
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

  let retry: NodeJS.Timeout | null = null;
  const url = cfg.server.replace(/^http/, "ws") + "/ws/device";
  log(`ride-agent ${VERSION} · Claude Code ${version ?? "not found on PATH"} · server ${cfg.server} · device "${cfg.name}"${VERBOSE ? " · verbose" : ""}`);

  const connect = () => {
    retry = null;
    // Outbound only: no inbound port is opened on this machine.
    const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${cfg.token}` } });
    const send = (m: DeviceToServer) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(m));
    let ping: NodeJS.Timeout | null = null;
    let lastPong = Date.now();
    // Every way a connection can end leads here, once: retry with a growing delay.
    let ended = false;
    const reconnect = (why: string) => {
      if (ended) return;
      ended = true;
      if (ping) clearInterval(ping);
      log(`disconnected (${why}) · retrying in ${Math.round(backoff / 1000)} s`);
      retry = setTimeout(connect, backoff);
      backoff = Math.min(30_000, backoff * 2);
    };
    ws.on("open", () => {
      backoff = 1000;
      lastPong = Date.now();
      log(`connected to ${cfg.server} as "${cfg.name}" · waiting for tasks`);
      send({ t: "hello", name: cfg.name, platform: `${platform()} · node ${process.versions.node}`, agentVersion: VERSION, claudeCodeVersion: version, mcpServers: cfg.mcpServers ?? [], concurrency: cfg.concurrency });
      ping = setInterval(() => {
        // A socket a proxy dropped silently never closes by itself: no answer to our pings for 75 s ends it.
        if (Date.now() - lastPong > 75_000) {
          log("no answer from the server for 75 s");
          ws.terminate();
          return;
        }
        ws.ping();
        send({ t: "status", active: [...active.keys()], concurrency: cfg.concurrency });
      }, 25_000);
    });
    ws.on("pong", () => (lastPong = Date.now()));
    ws.on("message", (raw) => {
      let m: ServerToDevice;
      try {
        m = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (m.t === "welcome") {
        if (VERBOSE) log(`server knows this device as "${m.name}"`);
      } else if (m.t === "task.run") {
        const task = m;
        const tag = task.taskId.slice(0, 8);
        const started = Date.now();
        log(`new task${task.resume ? " (continues a session)" : ""} · ${task.model} · ${oneLine(task.brief, VERBOSE ? 4000 : 200)}`, tag);
        const ctl = runTask(cfg, task, (event) => {
          logEvent(tag, event, started);
          if (event.kind === "result" || event.kind === "error") active.delete(task.taskId);
          send({ t: "task.event", taskId: task.taskId, event });
        });
        active.set(task.taskId, ctl);
      } else if (m.t === "task.stop") {
        if (m.taskId === "*") {
          log(`stop all (${active.size} running)`);
          for (const ctl of active.values()) ctl.abort();
        } else {
          log("stop", m.taskId.slice(0, 8));
          active.get(m.taskId)?.abort();
        }
      }
    });
    ws.on("unexpected-response", (req, res) => {
      if (res.statusCode === 401) {
        log(`this device is no longer paired (401). Pair it again from Settings: npm run agent -- pair <code> --server ${cfg.server}`);
        process.exit(2);
      }
      // A 502/503 while the server restarts, a 404 on a wrong address: say so, and try again. Before, the
      // agent stopped here silently and never reconnected.
      req.destroy();
      reconnect(`HTTP ${res.statusCode}${res.statusCode === 404 ? ": is the server address right?" : ""}`);
    });
    ws.on("error", (e) => reconnect(e.message));
    ws.on("close", (code, reason) => reconnect(`closed ${code}${reason.length ? ` ${reason.toString()}` : ""}`));
  };
  connect();
}

if (process.argv[2] === "pair") void pair();
else if (process.argv[2] === "status" || process.argv.includes("--status")) console.log(existsSync(cfgFile) ? `Paired with ${load()?.server} as "${load()?.name}"` : "Not paired.");
else void daemon();
