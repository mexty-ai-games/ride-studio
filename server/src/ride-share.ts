import { randomBytes } from "node:crypto";
import type { WebSocket } from "ws";

/**
 * "Partager le trajet", in plain WebRTC: guests join from a QR code, with nothing to install and no account.
 * Ride Studio only carries the signalling (offers, answers, ICE candidates) between the rider's phone and each
 * guest; the audio and video go peer to peer. The rider's phone is the hub: it sends each guest the picture
 * being recorded and the rider's and Claude's voices, and takes each guest's camera and voice into the
 * recording and into the transcription, so a guest talks to Claude the same way the rider does.
 *
 * STUN finds the direct route; behind strict mobile NATs a TURN relay helps, set with TURN_URL (comma-separated
 * turn:/turns: URLs), TURN_USERNAME and TURN_CREDENTIAL. Without it, most connections still go through.
 */
export function iceServers(): RTCIceServerLike[] {
  const out: RTCIceServerLike[] = [{ urls: ["stun:stun.l.google.com:19302", "stun:stun.cloudflare.com:3478"] }];
  const turn = (process.env.TURN_URL || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (turn.length) out.push({ urls: turn, username: process.env.TURN_USERNAME || "", credential: process.env.TURN_CREDENTIAL || "" });
  return out;
}
interface RTCIceServerLike {
  urls: string[];
  username?: string;
  credential?: string;
}

interface Invite {
  code: string;
  episodeId: string;
  exp: number;
}
interface Guest {
  id: string;
  name: string;
  code: string;
  ws: WebSocket;
}

/** What goes over the signalling socket, both ways. `from`/`to` are guest ids; the host has none. */
export type Signal =
  | { t: "hello"; id?: string; iceServers: RTCIceServerLike[]; guests?: { id: string; name: string }[] }
  | { t: "join"; id: string; name: string }
  | { t: "leave"; id: string; name: string }
  | { t: "sdp"; id?: string; sdp: { type: string; sdp: string } }
  | { t: "ice"; id?: string; candidate: unknown }
  | { t: "host"; online: boolean }
  | { t: "ended" };

const MAX_GUESTS = 6;

/** One invite per live episode; the code in the QR is the only key a guest needs. */
export class ShareHub {
  private invites = new Map<string, Invite>();
  private host: WebSocket | null = null;
  private guests = new Map<string, Guest>();
  /** Joins and leaves, for the voice (who is talking with it). */
  onGuest: (name: string, joined: boolean) => void = () => {};

  inviteFor(episodeId: string): Invite {
    for (const i of this.invites.values()) if (i.episodeId === episodeId && i.exp > Date.now()) return i;
    const inv: Invite = { code: randomBytes(9).toString("base64url"), episodeId, exp: Date.now() + 8 * 3600_000 };
    this.invites.set(inv.code, inv);
    return inv;
  }
  find(code: string): Invite | null {
    const i = this.invites.get(code);
    return i && i.exp > Date.now() ? i : null;
  }
  get guestCount() {
    return this.guests.size;
  }
  /** The episode ended (or the rider stopped sharing): its invite stops working and guests are let go. */
  close(episodeId?: string) {
    for (const [k, i] of this.invites) if (!episodeId || i.episodeId === episodeId) this.invites.delete(k);
    for (const g of this.guests.values()) {
      send(g.ws, { t: "ended" });
      g.ws.close();
    }
    this.guests.clear();
  }

  /** The rider's phone (authenticated). A newer host socket replaces the old one. */
  attachHost(ws: WebSocket) {
    this.host?.close();
    this.host = ws;
    send(ws, { t: "hello", iceServers: iceServers(), guests: [...this.guests.values()].map((g) => ({ id: g.id, name: g.name })) });
    for (const g of this.guests.values()) send(g.ws, { t: "host", online: true });
    ws.on("message", (raw) => {
      const m = parse(raw);
      if (!m || (m.t !== "sdp" && m.t !== "ice") || !m.id) return;
      const g = this.guests.get(m.id);
      if (g) send(g.ws, { ...m, id: undefined });
    });
    ws.on("close", () => {
      if (this.host !== ws) return;
      this.host = null;
      for (const g of this.guests.values()) send(g.ws, { t: "host", online: false });
    });
  }

  /** A guest from the QR code: refused once the invite is gone or the ride is full. */
  attachGuest(ws: WebSocket, code: string, rawName: string): boolean {
    if (!this.find(code) || this.guests.size >= MAX_GUESTS) return false;
    const name = rawName.replace(/[^\p{L}\p{N} '\-]/gu, "").trim().slice(0, 30) || "Invité";
    const g: Guest = { id: randomBytes(6).toString("hex"), name, code, ws };
    this.guests.set(g.id, g);
    send(ws, { t: "hello", id: g.id, iceServers: iceServers() });
    send(ws, { t: "host", online: !!this.host });
    if (this.host) send(this.host, { t: "join", id: g.id, name });
    this.onGuest(name, true);
    ws.on("message", (raw) => {
      const m = parse(raw);
      if (!m || (m.t !== "sdp" && m.t !== "ice") || !this.host) return;
      send(this.host, { ...m, id: g.id });
    });
    ws.on("close", () => {
      if (!this.guests.delete(g.id)) return;
      if (this.host) send(this.host, { t: "leave", id: g.id, name });
      this.onGuest(name, false);
    });
    return true;
  }
}

function send(ws: WebSocket, m: Signal) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(m));
}
function parse(raw: unknown): Signal | null {
  try {
    const s = String(raw);
    return s.length > 64_000 ? null : (JSON.parse(s) as Signal);
  } catch {
    return null;
  }
}
