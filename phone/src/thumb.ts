import { useApp } from "./store";
import { studio } from "./studio";

/**
 * The card picture of a session on fabien.ninja: a frame of the 16:9 picture, taken while Mexty content is on
 * screen (the most telling moment), refreshed every minute, and sent when the episode ends.
 */
let last: Blob | null = null;
let timer: number | null = null;

function grab() {
  const s = useApp.getState().studio;
  if (!s?.episode || s.episode.status !== "live") return;
  if (last && !s.tiles.length) return; // keep a frame with content rather than a bare camera
  studio.wide.canvas.toBlob((b) => b && (last = b), "image/jpeg", 0.82);
}

async function send(episodeId: string) {
  grab();
  await new Promise((ok) => setTimeout(ok, 300));
  if (!last) return;
  const body = last;
  last = null;
  await fetch(`/api/recordings/${episodeId}/thumb`, { method: "PUT", credentials: "same-origin", headers: { "Content-Type": "image/jpeg" }, body }).catch(() => {});
}

useApp.subscribe((s, prev) => {
  const now = s.studio?.episode, before = prev.studio?.episode;
  if (now?.status === "live" && !timer) {
    last = null;
    timer = window.setInterval(grab, 60_000);
    window.setTimeout(grab, 20_000);
  }
  if (before?.status === "live" && now?.status !== "live") {
    if (timer) clearInterval(timer);
    timer = null;
    void send(before.id);
  }
});
