import { useEffect, useState } from "react";
import { exportRecording, listRecordings, type Variant } from "../recorder";
import { fmtClock, fmtUsd, useApp } from "../store";

interface Clip {
  variant: Variant;
  url: string;
  file: File;
}

export function Arrival() {
  const s = useApp((x) => x.studio);
  const recording = useApp((x) => x.recording);
  const set = useApp((x) => x.set);
  const [clips, setClips] = useState<Clip[] | null>(null);
  const uploads = useApp((x) => x.uploads);
  const ep = s?.episode;

  useEffect(() => {
    if (!ep || recording) return;
    let urls: string[] = [];
    void (async () => {
      const out: Clip[] = [];
      for (const variant of ["tall", "wide"] as Variant[]) {
        const ids = await listRecordings(ep.id, variant);
        for (const [i, id] of ids.entries()) {
          const r = await exportRecording(id);
          if (!r) continue;
          const name = `ride-studio-ep${ep.no}-${variant === "tall" ? "9x16" : "16x9"}${ids.length > 1 ? `-partie${i + 1}` : ""}.${r.ext}`;
          const file = new File([r.blob], name, { type: r.blob.type });
          out.push({ variant, url: URL.createObjectURL(file), file });
        }
      }
      urls = out.map((c) => c.url);
      setClips(out);
    })();
    return () => urls.forEach((u) => URL.revokeObjectURL(u));
  }, [ep?.id, recording]);

  if (!ep) return null;
  const dur = ((ep.endedAt ?? Date.now()) - ep.startedAt) / 1000;
  const onTime = dur <= ep.setup.etaMin * 60 + 30;
  const first = ep.delivered[0];
  const save = (c: Clip) => {
    const a = document.createElement("a");
    a.href = c.url;
    a.download = c.file.name;
    a.click();
  };
  const share = async () => {
    const files = (clips ?? []).filter((c) => c.variant === "tall").map((c) => c.file);
    try {
      if (files.length && navigator.canShare?.({ files })) await navigator.share({ files, title: `Ride Studio${ep.setup.company ? ` · ${ep.setup.company}` : ""}`, text: "Formation construite sur Mexty pendant le trajet." });
      else (clips ?? []).forEach(save);
    } catch {
      /* share sheet dismissed */
    }
  };
  const stats: [string, string][] = [
    [String(ep.stats.slides), ep.stats.slides > 1 ? "écrans" : "écran"],
    [String(ep.stats.questions || ep.stats.nodes || ep.stats.objects || ep.stats.changes), ep.stats.questions ? "questions" : ep.stats.nodes ? "étapes" : ep.stats.objects ? "objets 3D" : "changements"],
    [fmtUsd(s.cost.total), s.cost.plan?.fiveHour ? `payé · plan Claude 5 h : ${Math.round(s.cost.plan.fiveHour.pct)} %` : `sur ${s.cost.cap} $ de plafond`],
  ];

  return (
    <div className="screen">
      <div className="side mx-grad relative flex w-[330px] shrink-0 flex-col gap-2.5 overflow-hidden rounded-3xl p-5 text-white">
        <div aria-hidden className="absolute -right-10 -top-10 h-[180px] w-[180px] rounded-full" style={{ border: "22px solid rgba(255,255,255,0.12)" }} />
        <div className="flex h-[52px] w-[52px] items-center justify-center rounded-full bg-white">
          <svg aria-hidden width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#0B1640" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>
        </div>
        <span className="text-xs font-bold uppercase tracking-widest">Arrivé en {fmtClock(dur)}{onTime ? "" : ` · prévu ${ep.setup.etaMin} min`}</span>
        <h1 className="m-0 font-display text-[46px] font-extrabold leading-[0.95] tracking-tighter">{ep.delivered.length ? "Formation livrée." : "Épisode terminé."}</h1>
        <p className="m-0 text-sm leading-snug">
          {ep.delivered.length
            ? `${ep.setup.company || "L'entreprise"} a sa formation${ep.setup.topic ? ` « ${ep.setup.topic} »` : ""}${first?.url ? ", sur Mexty." : " (contenu de démonstration)."}`
            : "Aucun contenu n'a été créé pendant cet épisode."}
        </p>
        <span className="mt-auto font-display text-lg font-bold">Demain, nouvelle entreprise.</span>
      </div>

      <div className="flex min-w-0 grow flex-col gap-2.5">
        <div className="grid grid-cols-3 gap-2.5">
          {stats.map(([n, l]) => (
            <div key={l} className="card flex flex-col gap-0.5 rounded-[18px] px-3.5 py-3">
              <span className="font-display text-3xl font-extrabold leading-none">{n}</span>
              <span className="text-xs text-muted">{l}</span>
            </div>
          ))}
        </div>

        <div className="card flex min-h-0 grow items-center gap-3.5 overflow-x-auto rounded-[20px] p-3.5">
          {clips === null && <span className="text-sm text-muted">{recording ? "Finalisation de la vidéo…" : "Préparation des vidéos…"}</span>}
          {clips?.length === 0 && <span className="text-sm text-muted">Aucune vidéo sur ce téléphone pour cet épisode.</span>}
          {clips?.map((c) => (
            <div key={c.url} className="flex shrink-0 flex-col items-center gap-1.5">
              <video src={c.url} controls playsInline preload="metadata" className="rounded-xl bg-navy" style={c.variant === "tall" ? { width: 72, height: 128 } : { width: 196, height: 110 }} />
              <button onClick={() => save(c)} className="rounded-full border border-line bg-field px-3 py-1 text-[11px] font-semibold text-text">{c.variant === "tall" ? "9:16" : "16:9"} · {(c.file.size / 1e6).toFixed(0)} Mo · Enregistrer</button>
            </div>
          ))}
          {!!clips?.length && (
            <div className="flex min-w-0 flex-col gap-1">
              <span className="text-sm font-bold">{clips.length} vidéo{clips.length > 1 ? "s" : ""} prête{clips.length > 1 ? "s" : ""}</span>
              <span className="text-xs leading-snug text-muted">{ep.beats.length ? `${ep.beats.length} moment${ep.beats.length > 1 ? "s" : ""} marqué${ep.beats.length > 1 ? "s" : ""} : ${ep.beats.map((b) => `${fmtClock((b.ts - ep.startedAt) / 1000)} ${b.label}`).join(" · ")}` : "Stockées sur ce téléphone jusqu'aux deux prochains épisodes."}</span>
              <span className="text-xs font-semibold text-accent-text">{(() => {
                const mine = Object.entries(uploads).filter(([k]) => k.startsWith(ep.id));
                if (!mine.length) return "Envoi vers le serveur en attente…";
                const err = mine.find(([, u]) => u.error)?.[1].error;
                if (err) return err;
                if (mine.every(([, u]) => u.done)) return "Sauvegardées sur le serveur : à retrouver dans Épisodes.";
                const sent = mine.reduce((a, [, u]) => a + u.sent, 0), total = mine.reduce((a, [, u]) => a + u.total, 0);
                return `Envoi vers le serveur : ${total ? Math.round((sent / total) * 100) : 0} %`;
              })()}</span>
            </div>
          )}
        </div>

        {ep.delivered.some((d) => d.url) && (
          <button
            onClick={() => set({ screen: "poster", poster: { items: ep.delivered.filter((d) => d.url), place: ep.setup.company || ep.setup.destination, back: "arrival" } })}
            className="card h-12 rounded-[18px] text-[15px] font-bold text-text"
          >
            Affiche QR à laisser sur place
          </button>
        )}
        <div className="grid grid-cols-3 gap-2.5">
          <button onClick={() => set({ screen: "setup" })} className="card h-14 rounded-[18px] text-[15px] font-bold text-text">Nouvel épisode</button>
          <button disabled={!first?.url} onClick={() => first?.url && window.open(first.url, "_blank", "noopener")} className="card h-14 rounded-[18px] text-[15px] font-bold text-text">Ouvrir la formation</button>
          <button disabled={!clips?.length} onClick={share} className="mx-grad h-14 rounded-[18px] border-0 font-display text-lg font-extrabold text-white">Partager la vidéo</button>
        </div>
      </div>
    </div>
  );
}
