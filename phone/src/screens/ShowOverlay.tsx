import type { StudioState } from "../../../shared/protocol";
import { link } from "../link";
import { fmtClock, useApp } from "../store";

/**
 * A content open on the phone for someone to try. Mexty only lets its pages be framed by *.mexty.ai, and only
 * sends its login cookie there, so the iframe works once Ride Studio is served from a mexty.ai address;
 * anywhere else the content opens in a new tab.
 */
export const canFrameMexty = () => /(^|\.)mexty\.ai$/.test(location.hostname);

export function ShowOverlay({ s, contentKey, mode = "final" }: { s: StudioState; contentKey: string; mode?: "edit" | "final" }) {
  const setMode = (m: "edit" | "final") => useApp.getState().set({ opened: { key: contentKey, mode: m } });
  const recording = useApp((x) => x.recording);
  const recStartedAt = useApp((x) => x.recStartedAt);
  const c = s.contents.find((x) => x.key === contentKey);
  if (!c) return null;
  const src = mode === "edit" ? c.editUrl : c.url;
  const paused = s.rec === "paused";
  const btn = "h-10 rounded-full border border-line bg-surface px-3 text-sm font-semibold text-text";
  return (
    <div className="fixed inset-0 z-40 flex flex-col bg-bg">
      <div className="flex shrink-0 items-center gap-2 px-3 py-2" style={{ paddingTop: "max(8px, env(safe-area-inset-top))" }}>
        <span className="truncate font-display text-base font-extrabold">{c.name}{c.title ? ` · ${c.title}` : ""}</span>
        <span className="ml-auto flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-bold" style={paused ? { background: "#FFD166", color: "#0B1640" } : { background: "var(--rec-bg)", color: "var(--rec-text)" }}>
          <span aria-hidden className={`block h-2 w-2 rounded-full ${paused ? "" : "pulse"}`} style={{ background: paused ? "#0B1640" : "#FF3B3B" }} />
          {paused ? "EN PAUSE" : recording ? `REC ${fmtClock((Date.now() - recStartedAt) / 1000)}` : "REC"}
        </span>
        {c.editUrl && (
          <span className="flex shrink-0 overflow-hidden rounded-full border border-line" role="group" aria-label="Vue">
            {(["edit", "final"] as const).map((m) => (
              <button key={m} aria-pressed={mode === m} onClick={() => setMode(m)} className="h-10 border-0 px-3 text-sm font-semibold" style={mode === m ? { background: "#7B3FE4", color: "#fff" } : { background: "var(--surface)", color: "var(--text)" }}>
                {m === "edit" ? "Éditeur" : "Version finale"}
              </button>
            ))}
          </span>
        )}
        <button onClick={() => link.send({ t: "rec", action: paused ? "resume" : "pause" })} className={btn}>{paused ? "Reprendre" : "Pause"}</button>
        <button onClick={() => link.send({ t: "camera" })} className={btn} aria-label="Changer de caméra">{s.camera === "user" ? "Caméra arrière" : "Caméra avant"}</button>
        <button onClick={() => link.send({ t: "qr", on: !s.show.qr })} aria-pressed={s.show.qr} className={btn}>QR</button>
        <button onClick={() => { useApp.getState().set({ opened: null }); link.send({ t: "show", key: null }); }} className={btn} aria-label="Fermer">Fermer</button>
      </div>
      <div className="min-h-0 grow">
        {!src ? (
          <div className="flex h-full items-center justify-center p-6 text-center text-sm text-muted">Contenu de démonstration : rien à ouvrir dans Mexty.</div>
        ) : canFrameMexty() ? (
          <iframe key={src} src={src} title={c.name} className="h-full w-full border-0 bg-white" allow="autoplay; fullscreen; xr-spatial-tracking; accelerometer; gyroscope" />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
            <a href={src} target="_blank" rel="noopener" className="mx-grad rounded-2xl px-6 py-4 font-display text-xl font-extrabold text-white no-underline">Ouvrir {c.name}</a>
            <p className="m-0 max-w-md text-xs text-muted">Pour l'afficher ici, Ride Studio doit être servi depuis une adresse mexty.ai. Dans un autre onglet, la vidéo continue de tourner mais l'image se fige tant que l'onglet Ride Studio n'est pas au premier plan.</p>
          </div>
        )}
      </div>
    </div>
  );
}
