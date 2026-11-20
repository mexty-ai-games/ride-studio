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
 * Réglages → Radio Monkey: send audio files from this device or add a song from a link (a Suno audio URL,
 * any https audio file), switch tracks in or out of the playlist, delete them. Only this password-protected
 * app can add music; fabien.ninja just lists what has been on air.
 */
export function RadioLibrary() {
  const on = useApp((s) => s.studio?.radio);
  const [data, setData] = useState<Data | null>(null);
  const [url, setUrl] = useState("");
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);

  const load = () => void api<Data>("/api/radio/tracks").then(setData).catch((e) => useApp.getState().error(e.message));
  useEffect(load, []);

  const run = async (fn: () => Promise<unknown>, label = "Envoi…") => {
    setBusy(label);
    try {
      await fn();
      setUrl("");
      setTitle("");
    } catch (e) {
      useApp.getState().error((e as Error).message);
    }
    load();
    setBusy(null);
  };
  const addUrl = () => run(() => api("/api/radio/tracks/url", { method: "POST", json: { url: url.trim(), title: title.trim() } }));
  /** One or several files, one after the other. The title field only applies when a single file is sent. */
  const upload = (files: File[]) =>
    run(async () => {
      const failed: string[] = [];
      for (const [i, f] of files.entries()) {
        setBusy(files.length > 1 ? `Envoi ${i + 1}/${files.length}…` : "Envoi…");
        const q = new URLSearchParams({ name: f.name, title: (files.length === 1 && title.trim()) || f.name.replace(/\.[a-z0-9]{2,4}$/i, "") });
        const r = await fetch(`/api/radio/tracks/upload?${q}`, { method: "PUT", body: f, headers: { "Content-Type": f.type || "application/octet-stream" }, credentials: "same-origin" });
        if (!r.ok) failed.push(`${f.name} : ${((await r.json().catch(() => ({}))) as { error?: string }).error || `erreur ${r.status}`}`);
      }
      if (failed.length) throw new Error(failed.join(" · "));
    });

  const small = "h-9 rounded-full border border-line bg-field px-3 text-xs font-semibold text-text";
  return (
    <>
      <h2 className="m-0 mb-1 font-display text-xl font-extrabold">Radio Monkey</h2>
      <p className="m-0 mb-3 text-xs leading-snug text-muted">
        La musique sous les épisodes. Elle se lance sur ton ordre (« mets la radio », « coupe la radio », « morceau suivant ») ou avec le bouton de l'écran de tournage, et baisse toute seule quand Claude parle ou qu'une notification sonne. Les morceaux passés à l'antenne sont listés sur fabien.ninja.
      </p>

      <form className="mb-3 flex flex-wrap items-center gap-2 rounded-2xl bg-field p-3" onSubmit={(e) => { e.preventDefault(); if (url.trim()) void addUrl(); }}>
        <input className="field min-w-[200px] grow !h-10 !text-sm" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="Lien audio (Suno, https://…mp3)" aria-label="Lien du morceau" inputMode="url" />
        <input className="field w-[200px] !h-10 !text-sm" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Titre (facultatif)" aria-label="Titre du morceau" />
        <button type="submit" disabled={!!busy || !url.trim()} className="h-10 rounded-full border border-line bg-surface px-4 text-sm font-semibold text-text">Ajouter le lien</button>
        <button type="button" disabled={!!busy} onClick={() => file.current?.click()} className="mx-grad h-10 rounded-full border-0 px-4 text-sm font-bold text-white">Envoyer des fichiers audio</button>
        <input ref={file} type="file" accept="audio/*,.mp3,.m4a,.wav,.ogg,.flac" multiple hidden onChange={(e) => { const fs = [...(e.target.files ?? [])]; e.target.value = ""; if (fs.length) void upload(fs); }} />
        {busy && <span role="status" className="text-xs font-semibold text-muted">{busy}</span>}
      </form>

      <div className="flex flex-col gap-2">
        {data?.tracks.length === 0 && <p className="text-sm text-muted">Aucun morceau pour l'instant. Ajoute un lien Suno ou un fichier audio.</p>}
        {data?.tracks.map((t) => {
          const live = on?.on && on.track?.id === t.id;
          return (
            <div key={t.id} className="flex flex-wrap items-center gap-3 rounded-2xl bg-field px-4 py-2.5" style={{ opacity: t.enabled ? 1 : 0.55 }}>
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
        <p className="m-0 mt-3 text-[11px] text-muted">
          Ajout automatique (routine Suno) : <code>POST /api/radio/tracks/url</code> avec <code>{"{ url, title, artist, cover, prompt }"}</code> et l'en-tête <code>Authorization: Bearer RADIO_TOKEN</code> — {data.tokenSet ? "jeton configuré." : "variable RADIO_TOKEN pas encore définie sur le serveur."}
        </p>
      )}
    </>
  );
}
