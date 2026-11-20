import { BIN_FRAME, BIN_MIC, BIN_TTS, type ChangeEvent, type Entity, type PhoneToServer, type ServerToPhone } from "../../shared/protocol";
import { useApp } from "./store";

type Handlers = {
  tts(id: number, pcm: Int16Array): void;
  ttsCancel(): void;
  say(id: number, text: string, audio: boolean): void;
  frame(slot: number, jpeg: Blob): void;
  cue(kind: "started" | "finished", entity: Entity): void;
  change(event: ChangeEvent, slot: number | null): void;
};

/** The single WebSocket to the backend: JSON control messages plus binary mic, voice and preview frames. */
class Link {
  private ws: WebSocket | null = null;
  private retry = 500;
  private wantOpen = false;
  handlers: Partial<Handlers> = {};
  onOpen: (() => void) | null = null;

  open() {
    this.wantOpen = true;
    if (this.ws && this.ws.readyState <= WebSocket.OPEN) return;
    const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws/phone`);
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 500;
      useApp.getState().set({ connected: true });
      this.onOpen?.();
    };
    ws.onclose = () => {
      useApp.getState().set({ connected: false });
      if (this.ws === ws) this.ws = null;
      // Mobile data drops are normal on the road: keep coming back.
      if (this.wantOpen) setTimeout(() => this.open(), (this.retry = Math.min(5000, this.retry * 1.6)));
    };
    ws.onmessage = (e) => (typeof e.data === "string" ? this.text(JSON.parse(e.data) as ServerToPhone) : this.binary(e.data as ArrayBuffer));
  }
  close() {
    this.wantOpen = false;
    this.ws?.close();
  }
  send(m: PhoneToServer) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m));
  }
  mic(pcm: Int16Array) {
    const ws = this.ws;
    // Under back-pressure drop audio rather than queueing seconds of stale speech.
    if (ws?.readyState !== WebSocket.OPEN || ws.bufferedAmount > 256_000) return;
    const out = new Uint8Array(1 + pcm.byteLength);
    out[0] = BIN_MIC;
    out.set(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength), 1);
    ws.send(out);
  }

  private binary(buf: ArrayBuffer) {
    const kind = new Uint8Array(buf, 0, 1)[0];
    if (kind === BIN_FRAME) this.handlers.frame?.(new Uint8Array(buf, 1, 1)[0], new Blob([new Uint8Array(buf, 2)], { type: "image/jpeg" }));
    else if (kind === BIN_TTS) {
      const id = new DataView(buf).getUint32(1, true);
      this.handlers.tts?.(id, new Int16Array(buf.slice(5)));
    }
  }

  private text(m: ServerToPhone) {
    const app = useApp.getState();
    switch (m.t) {
      case "state": {
        const prev = app.studio?.episode;
        const ep = m.state.episode;
        let screen = app.screen;
        if (ep?.status === "live" && screen !== "live" && screen !== "bakeoff") screen = "live";
        if (ep?.status === "ended" && prev?.status === "live") screen = "arrival";
        // An overlay the rider opened follows what the voice shows next ("ferme" closes it).
        const was = app.studio?.show.key ?? null;
        const opened = app.opened && m.state.show.key !== was ? m.state.show.key : app.opened;
        app.set({ studio: m.state, screen, opened });
        break;
      }
      case "say":
        app.set({ claudeLine: m.text });
        this.handlers.say?.(m.id, m.text, m.audio);
        break;
      case "tts.cancel":
        this.handlers.ttsCancel?.();
        break;
      case "user":
        app.set({ userLine: m.text, partial: "" });
        break;
      case "stt": {
        if (app.screen === "bakeoff") {
          const cur = app.bake[m.vendor] ?? { partial: "", finals: [] };
          const next = { ...cur };
          if (m.kind === "partial") next.partial = m.text ?? "";
          else if (m.kind === "final" || m.kind === "eot" || m.kind === "error" || m.kind === "open") {
            next.finals = [...cur.finals, { vendor: m.vendor, kind: m.kind, text: m.text ?? "", ts: m.ts, ms: m.ms }].slice(-40);
            if (m.kind !== "open") next.partial = "";
          }
          app.set({ bake: { ...app.bake, [m.vendor]: next } });
        } else if (m.kind === "partial") app.set({ partial: m.text ?? "" });
        else if (m.kind === "error") app.error(m.text ?? "Erreur de transcription");
        break;
      }
      case "cue":
        this.handlers.cue?.(m.kind, m.entity);
        break;
      case "change":
        this.handlers.change?.(m.event, m.slot);
        app.set({ changes: [...app.changes.filter((c) => Date.now() - c.at < 4000), { event: m.event, slot: m.slot, at: Date.now() }] });
        break;
      case "bakeoff.saved":
        app.set({ bakeSaved: { url: m.url, seconds: m.seconds } });
        break;
      case "error":
        app.error(m.message);
        break;
    }
  }
}

export const link = new Link();
