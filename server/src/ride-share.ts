import { createHmac, randomBytes } from "node:crypto";

/**
 * "Partager le trajet": guests join the ride from a QR code, through a LiveKit room. The rider's phone is the
 * host: it records everything and relays the guests' voices to Claude, so a guest talks to Claude the same way.
 * Configured with LIVEKIT_URL (wss://…), LIVEKIT_API_KEY and LIVEKIT_API_SECRET.
 */
export const livekit = {
  url: (process.env.LIVEKIT_URL || "").replace(/\/$/, ""),
  key: process.env.LIVEKIT_API_KEY || "",
  secret: process.env.LIVEKIT_API_SECRET || "",
  get configured() {
    return !!(this.url && this.key && this.secret);
  },
};

const b64 = (o: unknown) => Buffer.from(typeof o === "string" ? o : JSON.stringify(o)).toString("base64url");

/** A LiveKit access token (HS256 JWT signed with the API secret). */
export function accessToken(o: { identity: string; name: string; room: string; ttlSec: number; admin?: boolean }): string {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: livekit.key,
    sub: o.identity,
    name: o.name,
    nbf: now - 10,
    exp: now + o.ttlSec,
    video: { room: o.room, roomJoin: true, canPublish: true, canSubscribe: true, canPublishData: !!o.admin, ...(o.admin ? { roomAdmin: true } : {}) },
  };
  const head = b64({ alg: "HS256", typ: "JWT" });
  const body = b64(payload);
  const sig = createHmac("sha256", livekit.secret).update(`${head}.${body}`).digest("base64url");
  return `${head}.${body}.${sig}`;
}

interface Invite {
  code: string;
  episodeId: string;
  room: string;
  exp: number;
  guests: Map<string, { name: string; joinedAt: number }>;
}

/** One invite per live episode; the code in the QR is the only key a guest needs. */
export class ShareHub {
  private invites = new Map<string, Invite>();

  roomOf(episodeId: string) {
    return `ride-${episodeId}`;
  }
  inviteFor(episodeId: string): Invite {
    for (const i of this.invites.values()) if (i.episodeId === episodeId && i.exp > Date.now()) return i;
    const code = randomBytes(9).toString("base64url");
    const inv: Invite = { code, episodeId, room: this.roomOf(episodeId), exp: Date.now() + 8 * 3600_000, guests: new Map() };
    this.invites.set(code, inv);
    return inv;
  }
  find(code: string): Invite | null {
    const i = this.invites.get(code);
    return i && i.exp > Date.now() ? i : null;
  }
  /** The episode ended: its invite stops working. */
  close(episodeId: string) {
    for (const [k, i] of this.invites) if (i.episodeId === episodeId) this.invites.delete(k);
  }
  guestToken(inv: Invite, name: string) {
    const identity = `guest-${randomBytes(4).toString("hex")}`;
    inv.guests.set(identity, { name, joinedAt: Date.now() });
    return { identity, token: accessToken({ identity, name, room: inv.room, ttlSec: 4 * 3600 }) };
  }
  hostToken(episodeId: string) {
    return accessToken({ identity: "host", name: "Fabien", room: this.roomOf(episodeId), ttlSec: 8 * 3600, admin: true });
  }
}
