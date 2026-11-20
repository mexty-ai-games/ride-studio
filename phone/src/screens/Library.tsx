import { useEffect, useState } from "react";
import { allRecordingIds } from "../recorder";
import { api, fmtClock, fmtUsd, useApp } from "../store";
import { autoUpload, syncUploads } from "../uploader";

interface Video { rec: string; variant: "tall" | "wide"; part: number; bytes: number; complete: boolean; url: string }
interface Episode {
  id: string; no: number; company: string; topic: string; destination?: string; startedAt: number; endedAt: number;
  cost: { total: number }; stats: Record<string, number>; beats?: { label: string; ts: number }[];
  delivered: { entity: string; entityId: string; title: string; url?: string }[]; videos: Video[];
}
interface Data { episodes: Episode[]; storage: { freeBytes: number; totalBytes: number; usedBytes: number } }
const gb = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} Go` : `${Math.round(n / 1e6)} Mo`);

/** Every past episode, with its videos on the server, whatever device they were recorded on. */
export function Library() {
  const set = useApp((s) => s.set);
  const uploads = useApp((s) => s.uploads);
  const [data, setData] = useState<Data | null>(null);
  const [local, setLocal] = useState<string[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [auto, setAuto] = useState(autoUpload.on);

  const load = () => {
    void api<Data>("/api/episodes").then(setData).catch((e) => useApp.getState().error(e.message));
    void allRecordingIds().then(setLocal).catch(() => {});
  };
  useEffect(() => {
    load();
    const t = setInterval(load, 6000);
    return () => clearInterval(t);
  }, []);

  const st = data?.storage;
  return (
    <div className="screen flex-col">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="eyebrow">Épisodes</div>
          <h1 className="m-0 font-display text-2xl font-extrabold tracking-tight">{data ? `${data.episodes.length} épisode${data.episodes.length > 1 ? "s" : ""}` : "Chargement…"}</h1>
        </div>
        <div className="flex items-center gap-2">
          {st && st.totalBytes > 0 && <span className="text-xs text-muted">Vidéos : {gb(st.usedBytes)} · libre : {gb(st.freeBytes)}</span>}
          <button aria-pressed={auto} onClick={() => { autoUpload.set(!auto); setAuto(!auto); if (!auto) void syncUploads(); }} className="h-11 rounded-full px-4 text-sm text-text" style={auto ? { border: "2px solid #7B3FE4", background: "var(--chip-on)", fontWeight: 700 } : { border: "1px solid var(--line)", background: "var(--field)", fontWeight: 500 }}>
            Envoi auto {auto ? "activé" : "coupé"}
          </button>
          {!auto && local.length > 0 && <button onClick={() => void syncUploads()} className="mx-grad h-11 rounded-full border-0 px-4 text-sm font-bold text-white">Envoyer maintenant</button>}
          <button onClick={() => set({ screen: "setup" })} className="h-11 rounded-full border border-line bg-field px-4 text-sm font-semibold text-text">Retour</button>
        </div>
      </div>

      <div className="flex min-h-0 grow flex-col gap-2.5 overflow-y-auto">
        {data?.episodes.length === 0 && <p className="text-sm text-muted">Aucun épisode terminé pour l'instant.</p>}
        {data?.episodes.map((e) => {
          const mine = Object.entries(uploads).filter(([k]) => k.startsWith(e.id));
          const onPhone = local.some((k) => k.startsWith(e.id));
          const sent = mine.reduce((a, [, u]) => a + u.sent, 0), total = mine.reduce((a, [, u]) => a + u.total, 0);
          const sending = mine.some(([, u]) => !u.done && !u.error) && total > 0;
          const err = mine.find(([, u]) => u.error)?.[1].error;
          const status = e.videos.length && e.videos.every((v) => v.complete) ? `${e.videos.length} vidéo${e.videos.length > 1 ? "s" : ""}` : sending ? `Envoi ${Math.round((sent / total) * 100)} %` : err ? err : onPhone ? "Sur ce téléphone, pas encore envoyé" : e.videos.length ? "Envoi incomplet" : "Pas de vidéo";
          const isOpen = open === e.id;
          return (
            <div key={e.id} className="card rounded-2xl">
              <button onClick={() => setOpen(isOpen ? null : e.id)} aria-expanded={isOpen} className="flex w-full items-center gap-3 border-0 bg-transparent px-4 py-3 text-left text-text">
                <span className="font-display text-2xl font-extrabold tabular-nums">{e.no}</span>
                <span className="min-w-0 grow">
                  <span className="block truncate text-sm font-bold">{e.company || "Sans nom"}{e.destination ? ` · ${e.destination}` : ""}</span>
                  <span className="block truncate text-xs text-muted">{new Date(e.startedAt).toLocaleDateString("fr-FR", { weekday: "short", day: "numeric", month: "short" })} · {fmtClock((e.endedAt - e.startedAt) / 1000)} · {e.topic || "sans sujet"}</span>
                </span>
                <span className="shrink-0 text-right">
                  <span className="block text-xs font-semibold" style={{ color: err ? "var(--bad)" : "var(--muted)" }}>{status}</span>
                  <span className="block text-xs text-muted">{fmtUsd(e.cost.total)}</span>
                </span>
              </button>
              {isOpen && (
                <div className="flex flex-wrap items-start gap-3.5 border-t border-line px-4 py-3">
                  {e.videos.map((v) => (
                    <div key={v.rec} className="flex flex-col items-center gap-1.5">
                      <video src={v.url} controls playsInline preload="metadata" className="rounded-xl bg-navy" style={v.variant === "tall" ? { width: 124, height: 220 } : { width: 320, height: 180 }} />
                      <a href={`${v.url}?dl=1`} className="rounded-full border border-line bg-field px-3 py-1 text-[11px] font-semibold text-text no-underline">{v.variant === "tall" ? "9:16" : "16:9"}{v.part > 1 ? ` · partie ${v.part}` : ""} · {gb(v.bytes)}{v.complete ? "" : " · incomplet"} · Télécharger</a>
                    </div>
                  ))}
                  <div className="flex min-w-[180px] grow flex-col gap-1.5 text-xs text-muted">
                    <span>{[e.stats.slides && `${e.stats.slides} écrans`, e.stats.questions && `${e.stats.questions} questions`, e.stats.nodes && `${e.stats.nodes} étapes`, e.stats.objects && `${e.stats.objects} objets 3D`].filter(Boolean).join(" · ") || `${e.stats.changes ?? 0} changements`}</span>
                    {e.beats?.length ? <span>Moments : {e.beats.map((b) => `${fmtClock((b.ts - e.startedAt) / 1000)} ${b.label}`).join(" · ")}</span> : null}
                    {e.delivered.filter((d) => d.url).map((d) => <a key={d.url} href={d.url} target="_blank" rel="noopener" className="font-semibold text-accent-text">Ouvrir « {d.title} »</a>)}
                    {e.delivered.some((d) => d.url && d.entityId) && (
                      <button onClick={() => set({ screen: "poster", poster: { items: e.delivered.filter((d) => d.url && d.entityId), place: e.company || e.destination || "", back: "library" } })} className="w-fit rounded-full border border-line bg-field px-3 py-1 text-xs font-semibold text-text">Affiche QR</button>
                    )}
                    <div className="mt-1 flex gap-2">
                      {e.videos.length > 0 && <button onClick={() => confirm("Supprimer les vidéos de cet épisode du serveur ?") && void api(`/api/episodes/${e.id}/videos`, { method: "DELETE" }).then(load)} className="h-9 rounded-full border border-line bg-field px-3 text-xs font-semibold text-text">Supprimer les vidéos</button>}
                      <button onClick={() => confirm(`Supprimer l'épisode ${e.no} et ses vidéos ?`) && void api(`/api/episodes/${e.id}`, { method: "DELETE" }).then(load)} className="h-9 rounded-full border border-line bg-field px-3 text-xs font-semibold text-bad">Supprimer l'épisode</button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
