/** WebRTC signalling for "Partager le trajet" (server/src/ride-share.ts). */
export type Signal =
  | { t: "hello"; id?: string; iceServers: RTCIceServer[]; guests?: { id: string; name: string }[] }
  | { t: "join"; id: string; name: string }
  | { t: "leave"; id: string; name: string }
  | { t: "sdp"; id?: string; sdp: RTCSessionDescriptionInit }
  | { t: "ice"; id?: string; candidate: RTCIceCandidateInit }
  | { t: "host"; online: boolean }
  | { t: "ended" };

export function signalUrl(query = "") {
  return `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws/rtc${query}`;
}

/** Candidates that arrive before the remote description wait for it. */
export class IceQueue {
  private pending: RTCIceCandidateInit[] = [];
  constructor(private pc: RTCPeerConnection) {}
  add(c: RTCIceCandidateInit) {
    if (this.pc.remoteDescription) void this.pc.addIceCandidate(c).catch(() => {});
    else this.pending.push(c);
  }
  flush() {
    for (const c of this.pending.splice(0)) void this.pc.addIceCandidate(c).catch(() => {});
  }
}
