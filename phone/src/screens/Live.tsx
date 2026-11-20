import { useEffect, useRef, useState } from "react";
import { audio } from "../audio";
import { link } from "../link";
import { fmtClock, fmtUsd, useApp } from "../store";
import { studio } from "../studio";
import { CostDetail, costSummary } from "./CostDetail";
import { ShowOverlay } from "./ShowOverlay";

/** Shows a compositor canvas inside the page by re-parenting the real element (what you see is what is recorded). */
function CanvasView({ canvas, className, onTap }: { canvas: HTMLCanvasElement; className?: string; onTap?: (x: number, y: number) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  // Taps are converted to canvas pixels (the canvas is drawn with object-fit: contain).
  const tap = (e: React.MouseEvent) => {
    if (!onTap) return;
    const r = canvas.getBoundingClientRect();
    const k = Math.min(r.width / canvas.width, r.height / canvas.height);
    const ox = (r.width - canvas.width * k) / 2;
    const oy = (r.height - canvas.height * k) / 2;
    onTap((e.clientX - r.left - ox) / k, (e.clientY - r.top - oy) / k);
  };
  useEffect(() => {
    const host = ref.current!;
    canvas.style.cssText = "width:100%;height:100%;object-fit:contain;display:block";
    host.appendChild(canvas);
    return () => void (canvas.parentElement === host && host.removeChild(canvas));
  }, [canvas]);
  return <div ref={ref} className={className} onClick={tap} style={onTap ? { cursor: "pointer" } : undefined} />;
}

function useTick(ms: number) {
  const [, set] = useState(0);
  useEffect(() => {
    const t = setInterval(() => set((n) => n + 1), ms);
    return () => clearInterval(t);
  }, [ms]);
}

/** Radio Monkey: what is on air, with on/off and next for when the bike is stopped. */
function RadioCard() {
  const r = useApp((x) => x.studio?.radio);
  if (!r) return null;
  const btn = "h-8 shrink-0 rounded-full px-3 text-xs font-bold";
  return (
    <div className="card flex items-center gap-2 rounded-[18px] px-2.5 py-1.5">
      <span aria-hidden className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-xl text-lg" style={{ background: r.on ? "#FFD166" : "var(--field)" }}>
        {r.on && r.track?.cover ? <img src={r.track.cover} alt="" className="h-full w-full object-cover" /> : "🐒"}
      </span>
      <span className="min-w-0 grow">
        <span className="block truncate whitespace-nowrap text-[10px] font-extrabold uppercase tracking-wider" style={{ color: r.on ? "var(--accent-text)" : "var(--muted)" }}>{r.on ? "● Radio Monkey" : "Radio Monkey"}</span>
        <span className="block truncate text-xs font-semibold">{r.on && r.track ? `${r.track.title} · ${r.track.artist}` : r.library ? `${r.library} morceau${r.library > 1 ? "x" : ""}` : "Aucun morceau"}</span>
      </span>
      {r.on && <button onClick={() => link.send({ t: "radio", action: "next" })} aria-label="Morceau suivant" className={`${btn} border border-line bg-field text-text`}>»</button>}
      <button disabled={!r.on && !r.library} onClick={() => link.send({ t: "radio", action: r.on ? "off" : "on" })} className={`${btn} border-0 ${r.on ? "bg-field text-text" : "mx-grad text-white"}`}>{r.on ? "Couper" : "Lancer"}</button>
    </div>
  );
}

export function Live() {
  useTick(500);
  const s = useApp((x) => x.studio);
  const recording = useApp((x) => x.recording);
  const recStartedAt = useApp((x) => x.recStartedAt);
  const claudeLine = useApp((x) => x.claudeLine);
  const userLine = useApp((x) => x.userLine);
  const partial = useApp((x) => x.partial);
  const connected = useApp((x) => x.connected);
  const [keyboard, setKeyboard] = useState(false);
  const [text, setText] = useState("");
  const [confirmEnd, setConfirmEnd] = useState(false);
  const opened = useApp((x) => x.opened);
  const [choice, setChoice] = useState<string | null>(null);
  const [costOpen, setCostOpen] = useState(false);
  const open = (key: string, mode: "edit" | "final") => {
    setChoice(null);
    useApp.getState().set({ opened: { key, mode } });
    link.send({ t: "show", key });
  };
  const ep = s?.episode;
  const needsTap = !audio.media; // the page was reloaded mid-ride

  if (!ep) return null;
  const total = ep.setup.etaMin * 60;
  const arrived = ep.phase === "arrived";
  const paused = s.rec === "paused";
  const elapsed = ((ep.arrivedAt ?? Date.now()) - ep.startedAt) / 1000;
  const left = Math.max(0, total - elapsed);
  const C = 2 * Math.PI * 46;
  const running = s.workers.filter((w) => w.status === "running");
  const head = running.length > 1 ? `${running.length} Claude au travail` : running.length === 1 ? (running[0].step || "Claude construit la formation") : s.workers.length ? "Claude a terminé" : "En attente d'un brief";
  const pct = Math.min(100, (s.cost.total / s.cost.cap) * 100);
  const speaking = s.speaking || audio.speaking;

  return (
    <div className="screen">
      <div className="relative min-w-0 grow overflow-hidden rounded-3xl border border-line bg-black">
        <CanvasView
          canvas={studio.wide.canvas}
          className="h-full w-full"
          onTap={(x, y) => {
            // Tapping a screen opens that content full size on the phone, and the video follows it.
            const slot = studio.comp.hitTile(studio.wide.canvas.width, x, y);
            const c = slot == null ? undefined : s.contents.find((x) => x.slot === slot);
            if (!c) return;
            // Ask first: the editor (the work in progress) or the final version.
            setChoice(c.key);
          }}
        />
        {needsTap && (
          <button onClick={() => void studio.rejoin().catch((e) => useApp.getState().error(String(e)))} className="mx-grad absolute inset-0 m-auto h-20 w-72 rounded-3xl border-0 font-display text-2xl font-extrabold text-white">
            Reprendre l'enregistrement
          </button>
        )}
      </div>

      <div className="side flex w-[270px] shrink-0 flex-col gap-2.5">
        <div className="flex items-center justify-between">
          {paused ? (
            <span className="flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-extrabold tracking-wide" style={{ background: "#FFD166", color: "#0B1640" }}>❚❚ EN PAUSE</span>
          ) : (
            <span className="flex items-center gap-1.5 rounded-full bg-rec-bg px-3 py-1.5 text-xs font-bold tracking-wide text-rec-text">
              <span aria-hidden className={`block h-[9px] w-[9px] rounded-full ${recording ? "pulse" : ""}`} style={{ background: recording ? "#FF3B3B" : "#6B7499" }} />
              {recording ? `REC ${fmtClock((Date.now() - recStartedAt) / 1000)}` : "PAS D'ENREG."}
            </span>
          )}
          <span className="text-xs font-semibold text-muted">ÉP. {ep.no} · {ep.setup.wide ? "9:16 + 16:9" : "9:16"}{connected ? "" : " · hors ligne"}</span>
        </div>

        <div className="card flex items-center gap-3 rounded-[22px] px-3 py-2">
          <div className="relative h-[84px] w-[84px] shrink-0">
            <svg aria-hidden width="84" height="84" viewBox="0 0 104 104">
              <defs>
                <linearGradient id="mx" x1="0" y1="0" x2="1" y2="1">
                  <stop offset="0" stopColor="#2F5BFF" /><stop offset="0.4" stopColor="#7B3FE4" /><stop offset="0.75" stopColor="#E8388F" /><stop offset="1" stopColor="#FF8A3D" />
                </linearGradient>
              </defs>
              <circle cx="52" cy="52" r="46" fill="none" stroke="var(--track)" strokeWidth="8" />
              <circle cx="52" cy="52" r="46" fill="none" stroke="url(#mx)" strokeWidth="8" strokeLinecap="round" strokeDasharray={`${(arrived ? 1 : left / total) * C} ${C}`} transform="rotate(-90 52 52)" />
            </svg>
            <div className="absolute inset-0 flex flex-col items-center justify-center">
              <span className="font-display text-[22px] font-extrabold leading-none tracking-tight">{fmtClock(arrived ? elapsed : left > 0 ? left : elapsed - total)}</span>
              <span className="text-[9px] font-semibold uppercase tracking-widest text-muted">{arrived ? "arrivés" : left > 0 ? "restantes" : "de retard"}</span>
            </div>
          </div>
          <div className="flex min-w-0 flex-col gap-1">
            <span className="eyebrow">{arrived ? "Arrivés" : "Top chrono"}</span>
            <span className="font-display text-lg font-bold leading-tight">{ep.setup.company || "Ride Studio"}</span>
            <span className="truncate text-xs text-muted">{[ep.setup.destination, `${ep.setup.etaMin} min`].filter(Boolean).join(" · ")}</span>
          </div>
        </div>

        <div className="card flex flex-col gap-1.5 rounded-[18px] px-3 py-2.5">
          <button onClick={() => setCostOpen(true)} aria-label="Détail du coût" className="flex flex-col gap-1 border-0 bg-transparent p-0 text-left text-text">
          <div className="flex w-full items-center justify-between gap-2">
            <span className="truncate text-xs font-bold">{head}</span>
            <span className="shrink-0 text-xs font-semibold" style={{ color: s.cost.capped ? "var(--bad)" : s.cost.warned ? "var(--warn)" : "var(--muted)" }}>{fmtUsd(s.cost.total)} / {s.cost.cap} $</span>
          </div>
          <div role="progressbar" aria-label="Dépense" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100} className="h-1.5 w-full overflow-hidden rounded-full bg-track">
            <div className="mx-grad h-1.5 rounded-full" style={{ width: `${pct}%` }} />
          </div>
          {costSummary(s.cost) && <span className="w-full truncate text-[11px] font-semibold text-muted">{costSummary(s.cost)}</span>}
          </button>
          {arrived && s.contents.length > 0 ? (
            <div className="flex flex-col gap-1">
              {s.contents.map((c) => (
                <div key={c.key} className="flex items-center gap-2">
                  <span className="min-w-0 grow truncate text-xs font-semibold">{c.done ? "✓ " : ""}{c.name}{c.title ? ` · ${c.title}` : ""}</span>
                  <button onClick={() => link.send({ t: "show", key: c.key })} className="h-8 shrink-0 rounded-full border-0 px-3 text-xs font-bold text-white mx-grad">Montrer</button>
                </div>
              ))}
            </div>
          ) : s.workers.length > 0 && (
            <div className="flex gap-1 overflow-hidden whitespace-nowrap">
              {s.workers.map((w) => (
                <span key={w.id} title={w.error || w.brief} className="rounded-full px-2 py-0.5 text-[11px] font-semibold" style={w.status === "running" ? { background: "var(--chip-on)", color: "var(--text)" } : w.status === "error" ? { background: "var(--rec-bg)", color: "var(--rec-text)" } : { background: "var(--field)", color: "var(--muted)" }}>
                  {w.status === "done" ? "✓ " : w.status === "error" ? "! " : ""}Claude {w.no} · {w.runner === "device" ? w.deviceName : w.runner === "cloud" ? "cloud" : "démo"}
                </span>
              ))}
            </div>
          )}
        </div>

        <RadioCard />

        <div className="flex min-h-0 grow flex-col gap-1 overflow-hidden rounded-[18px] bg-voice-bg px-3 py-2 text-voice-text">
          <div className="flex items-center justify-end">
            <span className="text-[11px] font-bold tracking-wider" style={{ color: speaking ? "#FF9BCB" : "#A9B3D9" }}>{speaking ? "CLAUDE PARLE" : partial ? "TU PARLES" : "CLAUDE ÉCOUTE"}</span>
          </div>
          {keyboard ? (
            <form className="flex gap-1.5" onSubmit={(e) => { e.preventDefault(); if (text.trim()) link.send({ t: "text", text }); setText(""); }}>
              <input autoFocus className="field !h-10 !text-sm" value={text} onChange={(e) => setText(e.target.value)} placeholder="Écrire à Claude" aria-label="Message à Claude" />
            </form>
          ) : (
            <>
              <p className="m-0 line-clamp-2 text-[13px] leading-snug">{claudeLine ? `« ${claudeLine} »` : "Parle quand tu veux."}</p>
              <p className="m-0 line-clamp-1 text-xs leading-snug opacity-75">{partial || userLine ? `Toi : ${partial || userLine}` : ""}</p>
            </>
          )}
        </div>

        {/* Monitor-only controls, for when the bike is stopped. Nothing here is needed while riding. */}
        <div className="flex gap-2">
          <button onClick={() => link.send({ t: "rec", action: paused ? "resume" : "pause" })} className="h-11 grow rounded-2xl text-sm font-extrabold" style={paused ? { background: "#FFD166", color: "#0B1640", border: 0 } : { background: "var(--surface)", color: "var(--text)", border: "1px solid var(--line)" }}>{paused ? "Reprendre" : "Pause"}</button>
          <button onClick={() => link.send({ t: "camera" })} aria-label="Changer de caméra" className="h-11 grow rounded-2xl border border-line bg-surface text-sm font-semibold text-text">{s.camera === "user" ? "Cam. arrière" : "Cam. avant"}</button>
          <button onClick={() => link.send({ t: "stop" })} aria-label="Arrêter tous les agents" className="h-11 grow rounded-2xl border-2 border-[#FF3B3B] bg-rec-bg text-sm font-extrabold text-rec-text">Stop</button>
        </div>
        <div className="flex gap-2">
          <button onClick={() => setKeyboard((k) => !k)} className="h-11 grow rounded-2xl border border-line bg-surface text-sm font-semibold text-text">{keyboard ? "Masquer" : "Clavier"}</button>
          {!arrived ? (
            <button onClick={() => link.send({ t: "arrive" })} className="h-11 grow rounded-2xl border-0 text-sm font-bold text-white mx-grad">Arrivé</button>
          ) : confirmEnd ? (
            <button onClick={() => studio.end()} className="h-11 grow rounded-2xl border-0 bg-[#FF3B3B] text-sm font-bold text-white">Confirmer la fin</button>
          ) : (
            <button onClick={() => { setConfirmEnd(true); setTimeout(() => setConfirmEnd(false), 4000); }} className="h-11 grow rounded-2xl border border-line bg-surface text-sm font-semibold text-text">Terminer l'épisode</button>
          )}
        </div>
      </div>
      {costOpen && <CostDetail c={s.cost} onClose={() => setCostOpen(false)} />}
      {choice && (() => {
        const c = s.contents.find((x) => x.key === choice);
        if (!c) return null;
        const editor = c.entity === "scene" || /edverse/.test(c.editUrl) ? "Éditeur 3D" : c.entity === "block" ? "Éditeur de bloc" : "Éditeur";
        return (
          <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-4" onClick={() => setChoice(null)}>
            <div className="card flex w-full max-w-xl flex-col gap-3 rounded-3xl p-5" onClick={(e) => e.stopPropagation()}>
              <div className="font-display text-xl font-extrabold">{c.name}{c.title ? ` · ${c.title}` : ""}</div>
              <div className="grid grid-cols-2 gap-3">
                <button onClick={() => open(c.key, "edit")} disabled={!c.editUrl} className="h-28 rounded-2xl border-2 border-[#7B3FE4] bg-chip-on font-display text-2xl font-extrabold text-text">{editor}</button>
                <button onClick={() => open(c.key, "final")} disabled={!c.url} className="mx-grad h-28 rounded-2xl border-0 font-display text-2xl font-extrabold text-white">Version finale</button>
              </div>
              {!c.url && <p className="m-0 text-xs text-muted">Contenu de démonstration : rien à ouvrir dans Mexty.</p>}
              <button onClick={() => setChoice(null)} className="h-10 self-end rounded-full border border-line bg-field px-4 text-sm font-semibold text-text">Annuler</button>
            </div>
          </div>
        );
      })()}
      {opened && s.contents.some((c) => c.key === opened.key) ? (
        <ShowOverlay s={s} contentKey={opened.key} mode={opened.mode} />
      ) : (
        s.show.key && arrived && <ShowOverlay s={s} contentKey={s.show.key} />
      )}
    </div>
  );
}
