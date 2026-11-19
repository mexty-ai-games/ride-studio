import type { WebSocket } from "ws";
import type { DeviceHello, DeviceToServer, ServerToDevice } from "../../../shared/protocol.js";
import { store, type DeviceRecord } from "../store.js";
import type { Emit, Running, TaskSpec } from "./types.js";

interface Link {
  ws: WebSocket;
  record: DeviceRecord;
  hello: DeviceHello | null;
  tasks: Map<string, Emit>;
}

/** Paired machines that keep an outbound WebSocket open to this backend. */
export class DeviceHub {
  private links = new Map<string, Link>();
  onChange: () => void = () => {};

  attach(ws: WebSocket, record: DeviceRecord) {
    this.links.get(record.id)?.ws.close(4000, "replaced");
    const link: Link = { ws, record, hello: null, tasks: new Map() };
    this.links.set(record.id, link);
    this.send(link, { t: "welcome", deviceId: record.id, name: record.name });
    ws.on("message", (raw) => {
      let m: DeviceToServer;
      try {
        m = JSON.parse(raw.toString());
      } catch {
        return;
      }
      record.lastSeen = Date.now();
      if (m.t === "hello") {
        link.hello = m;
        record.platform = m.platform;
        record.claudeCodeVersion = m.claudeCodeVersion;
        store.touchDevices();
        this.onChange();
      } else if (m.t === "task.event") {
        link.tasks.get(m.taskId)?.(m.event);
        if (m.event.kind === "result" || m.event.kind === "error") {
          link.tasks.delete(m.taskId);
          this.onChange();
        }
      }
    });
    ws.on("close", () => {
      if (this.links.get(record.id) !== link) return;
      this.links.delete(record.id);
      for (const emit of link.tasks.values()) emit({ kind: "error", message: `Appareil « ${record.name} » déconnecté` });
      this.onChange();
    });
    this.onChange();
  }

  private send(link: Link, m: ServerToDevice) {
    if (link.ws.readyState === link.ws.OPEN) link.ws.send(JSON.stringify(m));
  }

  /** First enabled, online device with a free slot — preferring the one that already holds this worker's session. */
  pick(preferId?: string): string | null {
    const free = [...this.links.values()].filter((l) => l.record.enabled && l.hello && l.tasks.size < l.record.concurrency);
    return (free.find((l) => l.record.id === preferId) ?? free[0])?.record.id ?? null;
  }
  isOnline(id: string) {
    return this.links.has(id);
  }
  nameOf(id: string) {
    return this.links.get(id)?.record.name ?? store.devices.find((d) => d.id === id)?.name ?? "appareil";
  }

  run(deviceId: string, spec: TaskSpec, emit: Emit): Running {
    const link = this.links.get(deviceId);
    if (!link) {
      emit({ kind: "error", message: "Appareil hors ligne" });
      return { stop() {} };
    }
    link.tasks.set(spec.taskId, emit);
    this.send(link, { t: "task.run", ...spec });
    this.onChange();
    return { stop: () => this.send(link, { t: "task.stop", taskId: spec.taskId }) };
  }

  /** Tell every connected machine to abort everything it is running, including tasks this server lost track of. */
  stopAll() {
    for (const link of this.links.values()) this.send(link, { t: "task.stop", taskId: "*" });
  }

  disconnect(id: string) {
    this.links.get(id)?.ws.close(4001, "unpaired");
  }

  view() {
    return store.devices.map((d) => {
      const l = this.links.get(d.id);
      return {
        id: d.id,
        name: d.name,
        enabled: d.enabled,
        concurrency: d.concurrency,
        online: !!l?.hello,
        platform: d.platform ?? "",
        claudeCodeVersion: d.claudeCodeVersion ?? null,
        mcpServers: l?.hello?.mcpServers ?? [],
        activeSessions: l?.tasks.size ?? 0,
        lastSeen: d.lastSeen,
      };
    });
  }
  onlineCount() {
    return [...this.links.values()].filter((l) => l.hello && l.record.enabled).length;
  }
}
