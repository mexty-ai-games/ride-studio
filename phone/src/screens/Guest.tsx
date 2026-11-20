import { useEffect, useRef, useState } from "react";
import { Room, RoomEvent, Track, type RemoteTrack } from "livekit-client";

/**
 * The page a guest opens from the QR code: no account, just a name. They see and hear the ride (the video
 * being recorded, the rider and Claude), and their camera and voice go to the rider's phone, which records them
 * and passes their voice to Claude.
 */
export function Guest({ code }: { code: string }) {
  const [info, setInfo] = useState<{ episodeNo: number; company: string; destination: string } | null>(null);
  const [err, setErr] = useState("");
  const [name, setName] = useState(() => localStorage.getItem("rs-guest-name") ?? "");
  const [room, setRoom] = useState<Room | null>(null);
  const [busy, setBusy] = useState(false);
  const [mic, setMic] = useState(true);
  const [cam, setCam] = useState(true);
  const show = useRef<HTMLVideoElement>(null);
  const self = useRef<HTMLVideoElement>(null);
  const sounds = useRef<HTMLDivElement>(null);

  useEffect(() => {
    document.documentElement.dataset.theme = "dark";
    fetch(`/api/ride/join/${encodeURIComponent(code)}`).then(async (r) => {
      const j = await r.json();
      if (r.ok) setInfo(j);
      else setErr(j.error || "Lien invalide.");
    }).catch(() => setErr("Pas de connexion."));
  }, [code]);

  useEffect(() => () => void room?.disconnect(), [room]);

  const join = async () => {
    setBusy(true);
    setErr("");
    try {
      localStorage.setItem("rs-guest-name", name.trim());
      const r = await fetch(`/api/ride/join/${encodeURIComponent(code)}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Impossible de rejoindre.");
      const rm = new Room({ adaptiveStream: true, dynacast: true });
      rm.on(RoomEvent.TrackSubscribed, (track: RemoteTrack, _p, participant) => {
        if (track.kind === Track.Kind.Video && participant.identity === "host" && show.current) track.attach(show.current);
        else if (track.kind === Track.Kind.Audio) sounds.current?.appendChild(track.attach());
      });
      rm.on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack) => track.detach().forEach((el) => el.remove()));
      rm.on(RoomEvent.Disconnected, () => setRoom(null));
      await rm.connect(j.livekitUrl, j.token);
      await rm.startAudio();
      await rm.localParticipant.enableCameraAndMicrophone();
      const own = rm.localParticipant.getTrackPublication(Track.Source.Camera)?.track;
      if (own && self.current) own.attach(self.current);
      setRoom(rm);
    } catch (e) {
      setErr(/Permission|NotAllowed/i.test(String(e)) ? "Autorise la caméra et le micro pour rejoindre." : (e as Error).message);
    }
    setBusy(false);
  };

  const toggleMic = async () => {
    await room?.localParticipant.setMicrophoneEnabled(!mic);
    setMic(!mic);
  };
  const toggleCam = async () => {
    await room?.localParticipant.setCameraEnabled(!cam);
    setCam(!cam);
  };
  const btn = "h-12 rounded-2xl border border-line bg-surface px-4 text-sm font-bold text-text";

  return (
    <div className="flex min-h-dvh flex-col gap-3 bg-bg p-3 text-text">
      <div>
        <div className="eyebrow">Ride Studio{info ? ` · épisode ${info.episodeNo}` : ""}</div>
        <h1 className="m-0 font-display text-2xl font-extrabold tracking-tight">{info?.company ? `En route vers ${info.company}` : "Rejoindre le trajet"}</h1>
      </div>
      {err && <div role="alert" className="rounded-xl bg-rec-bg px-3 py-2 text-sm font-semibold text-rec-text">{err}</div>}

      <div className="relative min-h-0 grow overflow-hidden rounded-3xl border border-line bg-black" style={{ display: room ? undefined : "none" }}>
        <video ref={show} autoPlay playsInline className="h-full w-full object-contain" />
        <video ref={self} autoPlay playsInline muted className="absolute bottom-3 right-3 h-36 w-28 rounded-2xl border-2 border-[#FF6FB5] object-cover" style={{ transform: "scaleX(-1)" }} />
      </div>
      <div ref={sounds} hidden />

      {room ? (
        <div className="flex gap-2">
          <button onClick={toggleMic} className={btn} style={mic ? undefined : { background: "#FFD166", color: "#0B1640" }}>{mic ? "Couper le micro" : "Micro coupé"}</button>
          <button onClick={toggleCam} className={btn}>{cam ? "Couper la caméra" : "Caméra coupée"}</button>
          <button onClick={() => void room.disconnect()} className="ml-auto h-12 rounded-2xl border-0 bg-[#FF3B3B] px-4 text-sm font-bold text-white">Quitter</button>
        </div>
      ) : (
        info && (
          <div className="card flex flex-col gap-3 rounded-3xl p-4">
            <p className="m-0 text-sm text-muted">Tu rejoins le trajet en vidéo : tu vois et entends tout, et tu peux parler à Claude comme Fabien. Ta caméra et ta voix sont enregistrées dans la vidéo de l'épisode.</p>
            <label htmlFor="gname" className="label">Ton prénom</label>
            <input id="gname" className="field" value={name} onChange={(e) => setName(e.target.value)} maxLength={30} autoComplete="given-name" />
            <button onClick={join} disabled={busy || !name.trim()} className="mx-grad h-14 rounded-2xl border-0 font-display text-xl font-extrabold text-white">{busy ? "Connexion…" : "Rejoindre le trajet"}</button>
          </div>
        )
      )}
    </div>
  );
}
