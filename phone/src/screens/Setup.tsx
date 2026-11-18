import { useEffect, useState } from "react";
import type { EpisodeSetup } from "../../../shared/protocol";
import { api, useApp } from "../store";
import { studio } from "../studio";

interface SettingsLite {
  settings: { claude: { templates: string[] }; budget: { capUsd: number } };
}
const KEY = "rs-setup";
const days = ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"];

function Check({ ok, warn, children }: { ok: boolean; warn?: boolean; children: React.ReactNode }) {
  return (
    <span className="flex items-center gap-2 text-[13px]">
      <span aria-hidden className="block h-2 w-2 shrink-0 rounded-full" style={{ background: ok ? "#FF6FB5" : warn ? "#FFD166" : "#6B7499" }} />
      <span style={{ opacity: ok ? 1 : 0.8 }}>{children}</span>
    </span>
  );
}

export function Setup() {
  const studioState = useApp((s) => s.studio);
  const connected = useApp((s) => s.connected);
  const set = useApp((s) => s.set);
  const [templates, setTemplates] = useState<string[]>(["AI Act", "Compliance Legal", "Vierge"]);
  const [busy, setBusy] = useState(false);
  const [headset, setHeadset] = useState<boolean | null>(null);
  const [f, setF] = useState<EpisodeSetup>(() => {
    const base: EpisodeSetup = { company: "", destination: "", etaMin: 25, topic: "", template: "AI Act", budgetCap: 30, wide: true };
    try {
      return { ...base, ...JSON.parse(localStorage.getItem(KEY) || "{}") };
    } catch {
      return base;
    }
  });
  const up = (p: Partial<EpisodeSetup>) => setF((x) => ({ ...x, ...p }));

  useEffect(() => {
    void api<SettingsLite>("/api/settings").then((j) => {
      setTemplates(j.settings.claude.templates);
      setF((x) => ({ ...x, budgetCap: x.budgetCap || j.settings.budget.capUsd }));
    }).catch(() => {});
    // A headset shows up as an extra audio input; labels are only readable once the mic was granted.
    void navigator.mediaDevices?.enumerateDevices().then((d) => {
      const inputs = d.filter((x) => x.kind === "audioinput");
      setHeadset(inputs.some((x) => /bluetooth|casque|headset|hands-free|airpods|buds|cardo|sena|x1/i.test(x.label)) ? true : inputs.some((x) => x.label) ? false : null);
    }).catch(() => {});
  }, []);

  const r = studioState?.readiness;
  const live = studioState?.episode?.status === "live";
  const go = async () => {
    setBusy(true);
    localStorage.setItem(KEY, JSON.stringify(f));
    try {
      if (live) {
        await studio.rejoin();
        set({ screen: "live" });
      } else await studio.topChrono(f);
    } catch (e) {
      useApp.getState().error(/Permission|NotAllowed/i.test(String(e)) ? "Autorise le micro et la caméra pour enregistrer." : (e as Error).message);
    }
    setBusy(false);
  };
  const nextNo = (studioState?.episode?.no ?? 0) + (live ? 0 : 1);

  return (
    <div className="screen">
      <div className="card flex min-w-0 grow flex-col gap-3.5 rounded-3xl px-5 py-4">
        <div className="flex items-end justify-between gap-3">
          <div className="flex flex-col gap-0.5">
            <span className="eyebrow">Épisode {nextNo || 1} · {days[new Date().getDay()]}</span>
            <h1 className="m-0 font-display text-[34px] font-extrabold leading-none tracking-tight">Où va-t-on aujourd'hui ?</h1>
          </div>
          <div className="flex gap-2">
            <button onClick={() => set({ screen: "bakeoff" })} className="h-11 rounded-full border border-line bg-field px-4 text-sm font-semibold text-text">Test micro</button>
            <button onClick={() => set({ screen: "settings" })} className="h-11 rounded-full border border-line bg-field px-4 text-sm font-semibold text-text">Réglages</button>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          {(
            [
              ["company", "Entreprise", "Grand Canyon Water Park"],
              ["destination", "Destination", "Hang Dong"],
              ["topic", "Formation à livrer", "Sécurité des bassins et évacuation"],
            ] as const
          ).map(([k, label, ph]) => (
            <div key={k} className="flex flex-col gap-1.5">
              <label htmlFor={k} className="label">{label}</label>
              <input id={k} className="field" placeholder={ph} value={f[k]} onChange={(e) => up({ [k]: e.target.value })} />
            </div>
          ))}
          <div className="flex flex-col gap-1.5">
            <label htmlFor="eta" className="label">Trajet estimé (min)</label>
            <input id="eta" className="field" type="number" inputMode="numeric" min={1} max={180} value={f.etaMin} onChange={(e) => up({ etaMin: Number(e.target.value) })} />
          </div>
        </div>
        <div className="flex flex-col gap-1.5">
          <span className="label">Modèle de départ</span>
          <div className="flex flex-wrap gap-2">
            {templates.map((t) => (
              <button key={t} aria-pressed={f.template === t} onClick={() => up({ template: t })} className="h-11 rounded-full px-4 text-sm text-text" style={f.template === t ? { border: "2px solid #7B3FE4", background: "var(--chip-on)", fontWeight: 700 } : { border: "1px solid var(--line)", background: "var(--field)", fontWeight: 500 }}>
                {t}
              </button>
            ))}
            <button aria-pressed={f.wide} onClick={() => up({ wide: !f.wide })} className="ml-auto h-11 rounded-full px-4 text-sm text-text" style={f.wide ? { border: "2px solid #7B3FE4", background: "var(--chip-on)", fontWeight: 700 } : { border: "1px solid var(--line)", background: "var(--field)", fontWeight: 500 }}>
              {f.wide ? "9:16 + 16:9" : "9:16 seul"}
            </button>
          </div>
        </div>
      </div>

      <div className="side flex w-[280px] shrink-0 flex-col gap-2.5">
        <div className="flex grow flex-col gap-3 rounded-3xl bg-navy p-4 text-[#F4F6FF]">
          <div className="flex items-baseline justify-between">
            <label htmlFor="cap" className="text-xs font-semibold text-[#B9C1E6]">Plafond de dépense</label>
            <span className="font-display text-3xl font-extrabold leading-none">
              <input id="cap" type="number" inputMode="numeric" min={1} max={500} value={f.budgetCap} onChange={(e) => up({ budgetCap: Number(e.target.value) })} className="w-16 border-0 bg-transparent text-right font-display text-3xl font-extrabold text-[#F4F6FF] outline-none" /> $
            </span>
          </div>
          <span className="text-xs leading-snug text-[#B9C1E6]">Claude prévient à 80 %, s'arrête au plafond et te le dit.</span>
          <div className="mt-auto flex flex-col gap-1.5">
            <Check ok={connected}>{connected ? "Studio en ligne" : "Connexion au studio…"}</Check>
            <Check ok={headset === true} warn>{headset === true ? "Casque détecté" : headset === false ? "Pas de casque détecté : micro du téléphone" : "Casque : vérifié au départ"}</Check>
            <Check ok={!!r?.director} warn>{r?.director ? "Claude en ligne" : "Claude en mode démo (pas de clé)"}</Check>
            <Check ok={!!r?.stt.length && !!r?.tts} warn>{r?.stt.length && r?.tts ? "Voix prête" : !r?.stt.length ? "Pas de transcription (clé manquante)" : "Voix de secours, non enregistrée"}</Check>
            <Check ok={!r?.stub} warn>{r?.stub ? "Workers de démonstration" : `${r?.devicesOnline ? `${r.devicesOnline} appareil${r.devicesOnline > 1 ? "s" : ""} en ligne` : "Cloud prêt"}${r?.mexty ? " · aperçu Mexty" : " · aperçu simplifié"}`}</Check>
          </div>
        </div>
        <button onClick={go} disabled={busy || !connected || (!live && !f.company.trim())} className="mx-grad flex h-[72px] items-center justify-center gap-3 rounded-[22px] border-0 font-display text-2xl font-extrabold tracking-tight text-white">
          <span aria-hidden className="block h-3.5 w-3.5 rounded-full bg-white" />
          {live ? "Reprendre l'épisode" : "Top chrono"}
        </button>
      </div>
    </div>
  );
}
