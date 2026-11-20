import { Room, RoomEvent, Track, type RemoteParticipant, type RemoteTrack } from "livekit-client";
import { audio } from "./audio";
import { link } from "./link";
import { api, useApp } from "./store";
import { studio } from "./studio";

/**
 * The rider's phone hosts the shared ride: it publishes what guests see and hear (the video being recorded,
 * the rider's voice and Claude's), and takes each guest's camera and voice into the recording and into the
 * transcription, so a guest talks to Claude exactly like the rider does.
 */
class ShareHost {
  private room: Room | null = null;
  private removers = new Map<string, () => void>();

  get live() {
    return !!this.room;
  }

  /** Create (or reuse) the invite and join the room as host. Returns the link the QR code opens. */
  async start(): Promise<string> {
    const j = await api<{ url: string; livekitUrl: string; token: string }>("/api/ride/share", { method: "POST" });
    if (this.room) return j.url;
    const room = new Room({ adaptiveStream: true, dynacast: true });
    room.on(RoomEvent.TrackSubscribed, (track: RemoteTrack, _pub, p: RemoteParticipant) => this.onTrack(track, p));
    room.on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack, _pub, p: RemoteParticipant) => this.drop(`${p.identity}:${track.sid}`));
    room.on(RoomEvent.ParticipantConnected, (p: RemoteParticipant) => {
      link.send({ t: "guest", name: p.name || "Invité", joined: true });
      this.publishGuests(room);
    });
    room.on(RoomEvent.ParticipantDisconnected, (p: RemoteParticipant) => {
      for (const k of [...this.removers.keys()]) if (k.startsWith(`${p.identity}:`)) this.drop(k);
      studio.comp.guests.delete(p.identity);
      link.send({ t: "guest", name: p.name || "Invité", joined: false });
      this.publishGuests(room);
    });
    room.on(RoomEvent.Disconnected, () => this.cleanup());
    await room.connect(j.livekitUrl, j.token);
    this.room = room;
    // What guests see and hear: the picture being recorded, and the rider with Claude.
    const voice = audio.hostOut?.stream.getAudioTracks()[0];
    if (voice) await room.localParticipant.publishTrack(voice, { name: "ride-audio", source: Track.Source.Microphone, dtx: false });
    const picture = studio.wide.canvas.captureStream(15).getVideoTracks()[0];
    if (picture) await room.localParticipant.publishTrack(picture, { name: "ride-video", source: Track.Source.Camera, simulcast: false, videoEncoding: { maxBitrate: 900_000, maxFramerate: 15 } });
    return j.url;
  }

  private onTrack(track: RemoteTrack, p: RemoteParticipant) {
    const key = `${p.identity}:${track.sid}`;
    if (track.kind === Track.Kind.Audio) {
      this.removers.set(key, audio.addRemote(new MediaStream([track.mediaStreamTrack])));
    } else if (track.kind === Track.Kind.Video) {
      const v = track.attach() as HTMLVideoElement;
      v.muted = true;
      v.playsInline = true;
      studio.comp.guests.set(p.identity, { video: v, name: p.name || "Invité" });
      this.removers.set(key, () => {
        track.detach(v);
        studio.comp.guests.delete(p.identity);
      });
    }
  }

  private drop(key: string) {
    this.removers.get(key)?.();
    this.removers.delete(key);
  }

  private publishGuests(room: Room) {
    useApp.getState().set({ guests: [...room.remoteParticipants.values()].map((p) => ({ identity: p.identity, name: p.name || "Invité" })) });
  }

  private cleanup() {
    for (const k of [...this.removers.keys()]) this.drop(k);
    studio.comp.guests.clear();
    this.room = null;
    useApp.getState().set({ guests: [] });
  }

  stop() {
    void this.room?.disconnect();
    this.cleanup();
  }
}

export const shareHost = new ShareHost();

// The episode ended: guests leave with it.
useApp.subscribe((s, prev) => {
  if (s.studio?.episode?.status === "ended" && prev.studio?.episode?.status === "live") shareHost.stop();
});
