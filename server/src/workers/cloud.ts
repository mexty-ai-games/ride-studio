import Anthropic from "@anthropic-ai/sdk";
import { store } from "../store.js";
import type { Emit, Running, TaskSpec } from "./types.js";

/**
 * Cloud fallback: Claude Managed Agents, billed to the API key in Settings.
 * The agent only has the MEXTY and EDVERSE MCP toolsets (no bash, files or web). MCP credentials come from
 * the vault named in Settings — the keys never pass through this process.
 */
export class CloudRunner {
  private active = new Set<string>();

  available(): boolean {
    const c = store.settings.cloud;
    return c.enabled && !!store.secret("anthropic") && !!c.vaultId && this.active.size < c.concurrency;
  }
  configured(): boolean {
    const c = store.settings.cloud;
    return c.enabled && !!store.secret("anthropic") && !!c.vaultId;
  }

  /** Create the agent and environment once and remember their ids (control plane, not the request path). */
  private async ensure(client: Anthropic, spec: TaskSpec) {
    const s = store.settings;
    let { agentId, agentVersion, environmentId } = s.cloud;
    if (!environmentId) {
      const env = await client.beta.environments.create({ name: "ride-studio", config: { type: "cloud", networking: { type: "limited", allow_package_managers: false, allow_mcp_servers: true } } });
      environmentId = env.id;
    }
    if (!agentId) {
      const servers = [
        { name: "MEXTY", url: s.mexty.mcpUrl },
        { name: "EDVERSE", url: s.mexty.edverseMcpUrl },
      ];
      const agent = await client.beta.agents.create({
        name: "Ride Studio worker",
        model: spec.model,
        system: spec.systemAppend,
        mcp_servers: servers.map((m) => ({ type: "url" as const, ...m })),
        // The permission profile is "Mexty + EdVerse only": these two toolsets and nothing else.
        tools: servers.map((m) => ({ type: "mcp_toolset" as const, mcp_server_name: m.name, default_config: { permission_policy: { type: "always_allow" as const } } })),
      });
      agentId = agent.id;
      agentVersion = agent.version;
    }
    store.patchSettings({ cloud: { agentId, agentVersion, environmentId } });
    return { agentId, agentVersion, environmentId };
  }

  run(spec: TaskSpec, emit: Emit): Running {
    const key = store.secret("anthropic");
    if (!key) {
      emit({ kind: "error", message: "Clé Anthropic absente" });
      return { stop() {} };
    }
    const client = new Anthropic({ apiKey: key });
    let sessionId = spec.resume ?? "";
    let stopped = false;
    this.active.add(spec.taskId);
    const names = new Map<string, string>();

    const cost = async () => {
      const s = await client.beta.sessions.retrieve(sessionId);
      const amount = (s.usage as { list_cost?: { amount?: string } } | null)?.list_cost?.amount;
      return amount ? Number(amount) / 100 : 0;
    };

    (async () => {
      const { agentId, agentVersion, environmentId } = await this.ensure(client, spec);
      if (!sessionId) {
        const session = await client.beta.sessions.create({
          agent: agentVersion ? { type: "agent", id: agentId, version: agentVersion } : agentId,
          environment_id: environmentId,
          vault_ids: [store.settings.cloud.vaultId],
          title: `Ride Studio ${spec.taskId}`,
        });
        sessionId = session.id;
      }
      emit({ kind: "init", sessionId, mcpServers: [{ name: "MEXTY", status: "cloud" }, { name: "EDVERSE", status: "cloud" }], model: spec.model });
      // Stream first, then send, so no early event is missed.
      const stream = await client.beta.sessions.events.stream(sessionId);
      await client.beta.sessions.events.send(sessionId, { events: [{ type: "user.message", content: [{ type: "text", text: spec.brief }] }] });
      let summary = "";
      let turns = 0;
      for await (const ev of stream) {
        if (stopped) break;
        if (ev.type === "agent.message") {
          const text = ev.content.map((b) => (b.type === "text" ? b.text : "")).join("").trim();
          if (text) {
            summary = text;
            emit({ kind: "text", text });
          }
        } else if (ev.type === "agent.mcp_tool_use") {
          turns++;
          const name = `mcp__${ev.mcp_server_name}__${ev.name}`;
          names.set(ev.id, name);
          emit({ kind: "tool_use", id: ev.id, name, input: ev.input });
          if (ev.evaluated_permission === "ask") {
            // Only tools of the two allowed MCP servers are ever approved; nobody is watching, so anything else is denied.
            const ok = spec.allowedTools.some((p) => name.toLowerCase().startsWith(p.toLowerCase()));
            await client.beta.sessions.events.send(sessionId, { events: [{ type: "user.tool_confirmation", tool_use_id: ev.id, result: ok ? "allow" : "deny" }] });
          }
        } else if (ev.type === "agent.mcp_tool_result") {
          const out = (ev.content ?? []).map((b) => (b.type === "text" ? b.text : "")).join("");
          emit({ kind: "tool_result", id: ev.mcp_tool_use_id, name: names.get(ev.mcp_tool_use_id), isError: !!ev.is_error, output: out.slice(0, 20_000) });
        } else if (ev.type === "span.model_request_end") {
          emit({ kind: "usage", costUsd: await cost().catch(() => 0) });
        } else if (ev.type === "session.error") {
          emit({ kind: "text", text: `Erreur de session : ${JSON.stringify(ev.error).slice(0, 200)}` });
        } else if (ev.type === "session.status_idle") {
          if (ev.stop_reason.type !== "requires_action") break;
        } else if (ev.type === "session.status_terminated") {
          break;
        }
      }
      emit({ kind: "result", ok: !stopped, sessionId, costUsd: await cost().catch(() => 0), turns, summary: summary.slice(0, 600) });
    })()
      .catch((e: unknown) => emit({ kind: "error", message: e instanceof Anthropic.APIError ? `Managed Agents ${e.status}: ${e.message}` : (e as Error).message }))
      .finally(() => this.active.delete(spec.taskId));

    return {
      stop: () => {
        stopped = true;
        if (sessionId) void client.beta.sessions.events.send(sessionId, { events: [{ type: "user.interrupt" }] }).catch(() => {});
      },
    };
  }
}
