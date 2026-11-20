import { useEffect, useRef, useState } from "react";
import { api, fmtClock, useApp } from "../store";

interface Track {
  id: string;
  title: string;
  artist: string;
  durationSec?: number;
  bytes: number;
  source: "upload" | "url";
  enabled: boolean;
  plays: number;
  lastPlayedAt?: number;
  url: string;
}
interface Data {
  tracks: Track[];
  tokenSet: boolean;
}

/**
 * Radio Monkey's library: add a song from a link (a Suno audio URL, any https audio file) or from the phone,
 * switch tracks on or off, delete them. What has been on air is listed publicly on fabien.ninja.
 */
export function RadioScreen() {
  const set = useApp((s) => s.set);
  const on = useApp((s) => s.studio?.radio);
  const [data, setData] = useState<Data | null>(null);
  const [url, setUrl] = useState("");
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const file = useRef<HTMLInputElement>(null);

  const load = () => void api<Data>("/api/radio/tracks").then(setData).catch((e) => useApp.getState().error(e.message));
  useEffect(load, []);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      setUrl("");
      setTitle("");
      load();
    } catch (e) {
      useApp.getState().error((e as Error).message);
    }
    setBusy(false);
  };
  const addUrl = () => run(() => api("/api/radio/tracks/url", { method: "POST", json: { url: url.trim(), title: title.trim() } }));
  const upload = (f: File) =>
    run(async () => {
      const q = new URLSearchParams({ name: f.name, title: title.trim() || f.name.replace(/\.[a-z0-9]{2,4}$/i, "") });
      const r = await fetch(`/api/radio/tracks/upload?${q}`, { method: "PUT", body: f, headers: { "Content-Type": f.type || "application/octet-stream" }, credentials: "same-origin" });
      if (!r.ok) throw new Error(((await r.json().catch(() => ({}))) as { error?: string }).error || `Erreur ${r.status}`);
    });

  const small = "h-9 rounded-full border border-line bg-field px-3 text-xs font-semibold text-text";
  return (
    <div className="screen flex-col">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="eyebrow">Radio Monkey</div>
          <h1 className="m-0 font-display text-2xl font-extrabold tracking-tight">{data ? `${data.tracks.length} morceau${data.tracks.length > 1 ? "x" : ""}` : "Chargement…"}</h1>
        </div>
        <button onClick={() => set({ screen: "setup" })} className="h-11 rounded-full border border-line bg-field px-4 text-sm font-semibold text-text">Retour</button>
      </div>

      <p className="m-0 text-xs leading-snug text-muted">
        La radio se lance pendant un épisode, sur ton ordre (« mets la radio », « coupe la radio », « morceau suivant ») ou avec le bouton de l'écran de tournage. Elle baisse toute seule quand Claude parle ou qu'une notification sonne. Les morceaux passés à l'antenne sont listés sur fabien.ninja.
      </p>

      <form className="card flex flex-wrap items-center gap-2 rounded-2xl p-3" onSubmit={(e) => { e.preventDefault(); if (url.trim()) void addUrl(); }}>
        <input className="field min-w-[220px] grow !h-10 !text-sm" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="Lien audio (Suno, https://…mp3)" aria-label="Lien du morceau" inputMode="url" />
        <input className="field w-[200px] !h-10 !text-sm" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Titre (facultatif)" aria-label="Titre du morceau" />
        <button type="submit" disabled={busy || !url.trim()} className="mx-grad h-10 rounded-full border-0 px-4 text-sm font-bold text-white">Ajouter</button>
        <button type="button" disabled={busy} onClick={() => file.current?.click()} className="h-10 rounded-full border border-line bg-field px-4 text-sm font-semibold text-text">Depuis le téléphone</button>
        <input ref={file} type="file" accept="audio/*" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void upload(f); }} />
        {busy && <span className="text-xs text-muted">Envoi…</span>}
      </form>

      <div className="flex min-h-0 grow flex-col gap-2 overflow-y-auto">
        {data?.tracks.length === 0 && <p className="text-sm text-muted">Aucun morceau pour l'instant. Ajoute un lien Suno ou un fichier audio.</p>}
        {data?.tracks.map((t) => {
          const live = on?.on && on.track?.id === t.id;
          return (
            <div key={t.id} className="card flex flex-wrap items-center gap-3 rounded-2xl px-4 py-2.5" style={{ opacity: t.enabled ? 1 : 0.55 }}>
              <span className="min-w-[160px] grow">
                <span className="block truncate text-sm font-bold">{live ? "▶ " : ""}{t.title}</span>
                <span className="block truncate text-xs text-muted">
                  {[t.artist, t.durationSec ? fmtClock(t.durationSec) : null, `${(t.bytes / 1e6).toFixed(1)} Mo`, t.plays ? `${t.plays} passage${t.plays > 1 ? "s" : ""}` : "jamais diffusé"].filter(Boolean).join(" · ")}
                </span>
              </span>
              <audio src={t.url} controls preload="none" className="h-9 w-[220px]" />
              <button onClick={() => void run(() => api(`/api/radio/tracks/${t.id}`, { method: "PATCH", json: { enabled: !t.enabled } }))} className={small} aria-pressed={t.enabled}>{t.enabled ? "Dans la playlist" : "Hors playlist"}</button>
              <button onClick={() => confirm(`Supprimer « ${t.title} » ?`) && void run(() => api(`/api/radio/tracks/${t.id}`, { method: "DELETE" }))} className={`${small} text-bad`}>Supprimer</button>
            </div>
          );
        })}
      </div>

      {data && (
        <p className="m-0 text-[11px] text-muted">
          Ajout automatique (routine Suno) : <code>POST /api/radio/tracks/url</code> avec <code>{"{ url, title, artist, cover, prompt }"}</code> et l'en-tête <code>Authorization: Bearer RADIO_TOKEN</code> — {data.tokenSet ? "jeton configuré." : "variable RADIO_TOKEN pas encore définie sur le serveur."}
        </p>
      )}
    </div>
  );
}
