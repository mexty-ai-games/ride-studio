import { useEffect, useState } from "react";
import type { EpisodeSetup } from "../../../shared/protocol";
import { api, useApp } from "../store";
import { studio } from "../studio";

interface SettingsLite {
  settings: { budget: { capUsd: number } };
}
const WIDE_KEY = "rs-wide";

/** One big button. Everything about the episode is said aloud afterwards. */
export function Setup() {
  const studioState = useApp((s) => s.studio);
  const connected = useApp((s) => s.connected);
  const set = useApp((s) => s.set);
  const [busy, setBusy] = useState(false);
  const [cap, setCap] = useState(30);
  const [wide, setWide] = useState(() => localStorage.getItem(WIDE_KEY) !== "0");

  useEffect(() => {
    void api<SettingsLite>("/api/settings").then((j) => setCap(j.settings.budget.capUsd)).catch(() => {});
  }, []);

  const r = studioState?.readiness;
  const live = studioState?.episode?.status === "live";
  const go = async () => {
    setBusy(true);
    try {
      if (live) {
        await studio.rejoin();
        set({ screen: "live" });
      } else {
        const setup: EpisodeSetup = { company: "", destination: "", etaMin: 25, topic: "", template: "", budgetCap: cap, wide };
        await studio.topChrono(setup);
      }
    } catch (e) {
      useApp.getState().error(/Permission|NotAllowed/i.test(String(e)) ? "Autorise le micro et la caméra pour enregistrer." : (e as Error).message);
    }
    setBusy(false);
  };

  // What will limit this episode, in one line.
  const notes = [
    !connected && "Connexion au studio…",
    r && !r.director && "Claude en mode démo (pas de clé)",
    r && !r.stt.length && "Pas de transcription (clé manquante)",
    r && r.stt.length > 0 && !r.tts && "Voix de secours, non enregistrée",
    r?.stub && "Aucune machine en ligne : contenu de démonstration",
    r && !r.stub && !r.mexty && "Aperçu simplifié (Mexty injoignable)",
  ].filter(Boolean) as string[];
  const small = "h-11 rounded-full border border-line bg-field px-4 text-sm font-semibold text-text";

  return (
    <div className="screen flex-col items-center justify-center !gap-5">
      <button onClick={go} disabled={busy || !connected} className="mx-grad flex h-[42dvh] max-h-[220px] min-h-[120px] w-full max-w-[640px] items-center justify-center gap-5 rounded-[36px] border-0 font-display text-[clamp(40px,9vw,72px)] font-extrabold tracking-tight text-white shadow-2xl">
        <span aria-hidden className="block h-6 w-6 rounded-full bg-white" />
        {live ? "Reprendre" : "Démarrer"}
      </button>
      <p className="m-0 min-h-5 text-center text-sm" style={{ color: notes.length ? "var(--warn)" : "var(--muted)" }}>
        {notes.length ? notes.join(" · ") : r ? `Prêt · ${r.devicesOnline ? `${r.devicesOnline} machine${r.devicesOnline > 1 ? "s" : ""} en ligne` : "cloud"} · plafond ${cap} $` : ""}
      </p>
      <div className="flex flex-wrap justify-center gap-2">
        <button onClick={() => set({ screen: "library" })} className={small}>Épisodes</button>
        <button onClick={() => set({ screen: "radio" })} className={small}>Radio Monkey</button>
        <button onClick={() => set({ screen: "settings" })} className={small}>Réglages</button>
        <button onClick={() => set({ screen: "bakeoff" })} className={small}>Test micro</button>
        <button aria-pressed={wide} onClick={() => { localStorage.setItem(WIDE_KEY, wide ? "0" : "1"); setWide(!wide); }} className={small}>{wide ? "9:16 + 16:9" : "9:16 seul"}</button>
      </div>
    </div>
  );
}
