import { allRecordingIds, chunksOf, openRecordings } from "./recorder";
import { useApp } from "./store";

/**
 * Sends recordings from the phone to the server's volume, chunk by chunk and in order, so they can be
 * found again from any device. Resumable: the server says which chunk it expects next.
 */
export interface UploadState {
  sent: number;
  total: number;
  done: boolean;
  error?: string;
}
const AUTO_KEY = "rs-auto-upload";
export const autoUpload = {
  get on() {
    return localStorage.getItem(AUTO_KEY) !== "0";
  },
  set(v: boolean) {
    localStorage.setItem(AUTO_KEY, v ? "1" : "0");
  },
};

/** "<episodeId>:tall:p2" → { episodeId, rec: "tall-p2" } */
function parse(id: string) {
  const [episodeId, variant, part] = id.split(":");
  return { episodeId, rec: part ? `${variant}-${part}` : variant };
}

let running = false;
let again = false;

export async function syncUploads(): Promise<void> {
  if (running) {
    again = true;
    return;
  }
  running = true;
  try {
    for (const id of await allRecordingIds()) {
      const { episodeId, rec } = parse(id);
      if (openRecordings.has(id)) continue; // still being written
      const base = `/api/recordings/${episodeId}/${rec}`;
      const patch = (p: Partial<UploadState>) => useApp.setState((s) => ({ uploads: { ...s.uploads, [id]: { ...(s.uploads[id] ?? { sent: 0, total: 0, done: false }), ...p } } }));
      try {
        const st = await fetch(`${base}/status`, { credentials: "same-origin" });
        if (!st.ok) continue;
        const { nextSeq, complete } = (await st.json()) as { nextSeq: number; complete: boolean };
        const chunks = await chunksOf(id);
        if (complete || !chunks.length) {
          patch({ sent: chunks.length, total: chunks.length, done: complete, error: undefined });
          continue;
        }
        patch({ sent: nextSeq, total: chunks.length, done: false, error: undefined });
        let failed = false;
        for (let i = nextSeq; i < chunks.length; i++) {
          const c = chunks[i];
          const r = await fetch(`${base}/chunk/${i}?mime=${encodeURIComponent(c.mime || "video/webm")}`, { method: "PUT", credentials: "same-origin", headers: { "Content-Type": "application/octet-stream" }, body: c.blob });
          if (r.status === 404) {
            failed = true; // an episode this server does not know (recorded against another server)
            break;
          }
          if (!r.ok) {
            const j = (await r.json().catch(() => ({}))) as { error?: string };
            patch({ error: j.error || `Erreur ${r.status}` });
            failed = true;
            break;
          }
          patch({ sent: i + 1 });
        }
        if (failed) continue;
        const done = await fetch(`${base}/complete`, { method: "POST", credentials: "same-origin" });
        patch({ done: done.ok, sent: chunks.length });
      } catch {
        patch({ error: "Connexion interrompue, reprise automatique" });
      }
    }
  } finally {
    running = false;
    if (again) {
      again = false;
      void syncUploads();
    }
  }
}

// Mobile data comes and goes: pick the upload back up whenever the network returns.
window.addEventListener("online", () => autoUpload.on && void syncUploads());
setInterval(() => {
  const s = useApp.getState();
  if (autoUpload.on && s.authed && Object.values(s.uploads).some((u) => u.error)) void syncUploads();
}, 30_000);
