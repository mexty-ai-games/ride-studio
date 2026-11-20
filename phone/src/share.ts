import { audio } from "./audio";
import { IceQueue, signalUrl, type Signal } from "./rtc";
import { api, useApp } from "./store";
import { studio } from "./studio";

interface Peer {
  id: string;
  name: string;
  pc: RTCPeerConnection;
  ice: IceQueue;
  removeVoice?: () => void;
  video?: HTMLVideoElement;
}

/**
 * The rider's phone hosts the shared ride, in plain WebRTC (one peer connection per guest, signalled through
 * Ride Studio). Each guest gets the picture being recorded and the rider's and Claude's voices; each guest's
 * camera and voice come into the recording and into the transcription, so a guest talks to Claude exactly
 * like the rider does. The guest makes the offer; the phone answers with its own tracks.
 */
class ShareHost {
  private ws: WebSocket | null = null;
  private peers = new Map<string, Peer>();
  private iceServers: RTCIceServer[] = [];
  private picture: MediaStreamTrack | null = null;
  private wanted = false;
  private retry: number | null = null;

  get live() {
    return this.wanted;
  }

  /** Create (or reuse) the invite and open the signalling socket. Returns the link the QR code opens. */
  async start(): Promise<string> {
    const j = await api<{ url: string }>("/api/ride/share", { method: "POST" });
    this.wanted = true;
    if (!this.ws) this.connect();
    return j.url;
  }

  private connect() {
    const ws = new WebSocket(signalUrl());
    this.ws = ws;
    ws.onmessage = (e) => void this.onSignal(JSON.parse(String(e.data)) as Signal);
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      // The signalling only matters while someone joins: open calls stay up; reconnect for the next guests.
      if (this.wanted) this.retry = window.setTimeout(() => this.connect(), 2000);
    };
  }

  private send(m: Signal) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m));
  }

  private async onSignal(m: Signal) {
    if (m.t === "hello") {
      this.iceServers = m.iceServers;
      return;
    }
    if (m.t === "join") return void this.peerFor(m.id, m.name);
    if (m.t === "leave") return this.drop(m.id);
    if ((m.t !== "sdp" && m.t !== "ice") || !m.id) return;
    const p = this.peers.get(m.id) ?? this.peerFor(m.id, "Invité");
    if (m.t === "ice") return p.ice.add(m.candidate);
    if (m.t === "sdp" && m.sdp.type === "offer") {
      await p.pc.setRemoteDescription(m.sdp);
      p.ice.flush();
      // Answer on the guest's own transceivers: what it sends comes in, what we send goes out on the same lines.
      const voice = audio.hostOut?.stream.getAudioTracks()[0] ?? null;
      const picture = this.pictureTrack();
      for (const t of p.pc.getTransceivers()) {
        const kind = t.receiver.track.kind;
        await t.sender.replaceTrack(kind === "audio" ? voice : picture).catch(() => {});
        t.direction = "sendrecv";
      }
      await p.pc.setLocalDescription(await p.pc.createAnswer());
      this.send({ t: "sdp", id: p.id, sdp: p.pc.localDescription!.toJSON() });
    }
  }

  /** The picture being recorded, once, shared by every guest (15 fps is plenty for a phone screen). */
  private pictureTrack() {
    if (!this.picture || this.picture.readyState === "ended") this.picture = studio.wide.canvas.captureStream(15).getVideoTracks()[0] ?? null;
    return this.picture;
  }

  private peerFor(id: string, name: string): Peer {
    const existing = this.peers.get(id);
    if (existing) {
      existing.name = name;
      return existing;
    }
    const pc = new RTCPeerConnection({ iceServers: this.iceServers });
    const p: Peer = { id, name, pc, ice: new IceQueue(pc) };
    this.peers.set(id, p);
    pc.onicecandidate = (e) => e.candidate && this.send({ t: "ice", id, candidate: e.candidate.toJSON() });
    pc.ontrack = (e) => {
      const stream = e.streams[0] ?? new MediaStream([e.track]);
      if (e.track.kind === "audio") {
        p.removeVoice?.();
        p.removeVoice = audio.addRemote(new MediaStream([e.track]));
      } else {
        const v = document.createElement("video");
        v.muted = true;
        v.playsInline = true;
        v.autoplay = true;
        v.srcObject = stream;
        void v.play().catch(() => {});
        p.video = v;
        studio.comp.guests.set(id, { video: v, name: p.name });
      }
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "failed" || pc.connectionState === "closed") this.drop(id);
    };
    this.publish();
    return p;
  }

  private drop(id: string) {
    const p = this.peers.get(id);
    if (!p) return;
    this.peers.delete(id);
    p.removeVoice?.();
    if (p.video) p.video.srcObject = null;
    studio.comp.guests.delete(id);
    p.pc.close();
    this.publish();
  }

  private publish() {
    useApp.getState().set({ guests: [...this.peers.values()].map((p) => ({ identity: p.id, name: p.name })) });
  }

  stop() {
    this.wanted = false;
    if (this.retry) clearTimeout(this.retry);
    void api("/api/ride/share", { method: "DELETE" }).catch(() => {});
    const ws = this.ws;
    this.ws = null;
    ws?.close();
    for (const id of [...this.peers.keys()]) this.drop(id);
    this.picture?.stop();
    this.picture = null;
  }
}

export const shareHost = new ShareHost();

// The episode ended: guests leave with it.
useApp.subscribe((s, prev) => {
  if (s.studio?.episode?.status === "ended" && prev.studio?.episode?.status === "live" && shareHost.live) shareHost.stop();
});
