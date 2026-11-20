import { useEffect, useRef, useState } from "react";
import { IceQueue, signalUrl, type Signal } from "../rtc";

/**
 * The page a guest opens from the QR code: no account, no app, just a name. They see and hear the ride (the
 * video being recorded, the rider and Claude), and their camera and voice go straight to the rider's phone over
 * WebRTC, which records them and passes their voice to Claude.
 */
export function Guest({ code }: { code: string }) {
  const [info, setInfo] = useState<{ episodeNo: number; company: string; destination: string } | null>(null);
  const [err, setErr] = useState("");
  const [name, setName] = useState(() => localStorage.getItem("rs-guest-name") ?? "");
  const [joined, setJoined] = useState(false);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [mic, setMic] = useState(true);
  const [cam, setCam] = useState(true);
  const show = useRef<HTMLVideoElement>(null);
  const self = useRef<HTMLVideoElement>(null);
  const sound = useRef<HTMLAudioElement>(null);
  const call = useRef<{ ws: WebSocket; media: MediaStream; pc: RTCPeerConnection | null; ice: RTCIceServer[] } | null>(null);

  useEffect(() => {
    document.documentElement.dataset.theme = "dark";
    fetch(`/api/ride/join/${encodeURIComponent(code)}`)
      .then(async (r) => {
        const j = await r.json();
        if (r.ok) setInfo(j);
        else setErr(j.error || "Lien invalide.");
      })
      .catch(() => setErr("Pas de connexion."));
    return () => leave();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code]);

  /** A fresh peer connection and offer: on joining, and again whenever the rider's phone comes back. */
  const offer = async () => {
    const c = call.current;
    if (!c) return;
    c.pc?.close();
    const pc = new RTCPeerConnection({ iceServers: c.ice });
    c.pc = pc;
    const ice = new IceQueue(pc);
    (pc as RTCPeerConnection & { _ice?: IceQueue })._ice = ice;
    for (const kind of ["audio", "video"] as const) {
      const track = c.media.getTracks().find((t) => t.kind === kind);
      if (track) pc.addTransceiver(track, { direction: "sendrecv", streams: [c.media] });
      else pc.addTransceiver(kind, { direction: "recvonly" });
    }
    pc.onicecandidate = (e) => e.candidate && c.ws.send(JSON.stringify({ t: "ice", candidate: e.candidate.toJSON() }));
    pc.ontrack = (e) => {
      const stream = new MediaStream([e.track]);
      if (e.track.kind === "video" && show.current) {
        show.current.srcObject = stream;
        void show.current.play().catch(() => {});
      } else if (e.track.kind === "audio" && sound.current) {
        sound.current.srcObject = stream;
        void sound.current.play().catch(() => {});
      }
    };
    pc.onconnectionstatechange = () => {
      const s = pc.connectionState;
      setStatus(s === "connected" ? "" : s === "failed" ? "Connexion perdue, nouvel essai…" : s === "connecting" ? "Connexion…" : "");
      if (s === "failed" && call.current?.pc === pc) window.setTimeout(() => void offer(), 1500);
    };
    await pc.setLocalDescription(await pc.createOffer());
    c.ws.send(JSON.stringify({ t: "sdp", sdp: pc.localDescription!.toJSON() }));
  };

  const join = async () => {
    setBusy(true);
    setErr("");
    let media: MediaStream;
    try {
      localStorage.setItem("rs-guest-name", name.trim());
      media = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 24 } },
      });
    } catch (e) {
      setBusy(false);
      return setErr(/Permission|NotAllowed/i.test(String(e)) ? "Autorise la caméra et le micro pour rejoindre." : "Caméra ou micro indisponible.");
    }
    if (self.current) self.current.srcObject = media;
    const ws = new WebSocket(signalUrl(`?code=${encodeURIComponent(code)}&name=${encodeURIComponent(name.trim())}`));
    call.current = { ws, media, pc: null, ice: [] };
    let welcomed = false;
    ws.onmessage = async (e) => {
      const m = JSON.parse(String(e.data)) as Signal;
      const c = call.current;
      if (!c || c.ws !== ws) return;
      if (m.t === "hello") {
        c.ice = m.iceServers;
        welcomed = true;
        setJoined(true);
        setBusy(false);
      } else if (m.t === "host") {
        if (!m.online) return setStatus(c.pc?.connectionState === "connected" ? "" : "Fabien se reconnecte…");
        if (c.pc?.connectionState !== "connected") await offer();
      } else if (m.t === "sdp" && c.pc && m.sdp.type === "answer") {
        await c.pc.setRemoteDescription(m.sdp);
        (c.pc as RTCPeerConnection & { _ice?: IceQueue })._ice?.flush();
      } else if (m.t === "ice" && c.pc) {
        (c.pc as RTCPeerConnection & { _ice?: IceQueue })._ice?.add(m.candidate);
      } else if (m.t === "ended") {
        setErr("Le trajet est terminé. Merci d'être venu !");
        leave();
      }
    };
    ws.onclose = (e) => {
      if (call.current?.ws !== ws) return;
      if (e.code === 4000) setErr("Le trajet est complet.");
      else if (!welcomed) setErr("Ce trajet est terminé ou le lien n'est plus valable.");
      else setStatus("Déconnecté du trajet.");
      setBusy(false);
    };
  };

  function leave() {
    const c = call.current;
    call.current = null;
    if (!c) return;
    c.pc?.close();
    c.ws.close();
    c.media.getTracks().forEach((t) => t.stop());
    setJoined(false);
  }

  const toggleMic = () => {
    call.current?.media.getAudioTracks().forEach((t) => (t.enabled = !mic));
    setMic(!mic);
  };
  const toggleCam = () => {
    call.current?.media.getVideoTracks().forEach((t) => (t.enabled = !cam));
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

      <div className="relative min-h-0 grow overflow-hidden rounded-3xl border border-line bg-black" style={{ display: joined ? undefined : "none" }}>
        <video ref={show} autoPlay playsInline muted className="h-full w-full object-contain" />
        {status && <div className="absolute inset-x-0 top-3 mx-auto w-fit rounded-full bg-black/70 px-3 py-1 text-sm font-semibold text-white">{status}</div>}
        <video ref={self} autoPlay playsInline muted className="absolute bottom-3 right-3 h-36 w-28 rounded-2xl border-2 border-[#FF6FB5] object-cover" style={{ transform: "scaleX(-1)" }} />
      </div>
      <audio ref={sound} autoPlay hidden />

      {joined ? (
        <div className="flex gap-2">
          <button onClick={toggleMic} className={btn} style={mic ? undefined : { background: "#FFD166", color: "#0B1640" }}>{mic ? "Couper le micro" : "Micro coupé"}</button>
          <button onClick={toggleCam} className={btn}>{cam ? "Couper la caméra" : "Caméra coupée"}</button>
          <button onClick={leave} className="ml-auto h-12 rounded-2xl border-0 bg-[#FF3B3B] px-4 text-sm font-bold text-white">Quitter</button>
        </div>
      ) : (
        info && (
          <div className="card flex flex-col gap-3 rounded-3xl p-4">
            <p className="m-0 text-sm text-muted">Tu rejoins le trajet en vidéo, sans compte ni appli : tu vois et entends tout, et tu peux parler à Claude comme Fabien. Ta caméra et ta voix sont enregistrées dans la vidéo de l'épisode.</p>
            <label htmlFor="gname" className="label">Ton prénom</label>
            <input id="gname" className="field" value={name} onChange={(e) => setName(e.target.value)} maxLength={30} autoComplete="given-name" />
            <button onClick={join} disabled={busy || !name.trim()} className="mx-grad h-14 rounded-2xl border-0 font-display text-xl font-extrabold text-white">{busy ? "Connexion…" : "Rejoindre le trajet"}</button>
          </div>
        )
      )}
    </div>
  );
}
