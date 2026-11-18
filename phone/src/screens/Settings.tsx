import { useEffect, useState } from "react";
import { api, fmtUsd, setTheme, useApp } from "../store";

interface Device { id: string; name: string; enabled: boolean; concurrency: number; online: boolean; platform: string; claudeCodeVersion: string | null; mcpServers: { name: string; status: string }[]; activeSessions: number; lastSeen: number }
interface View {
  settings: {
    claude: { directorModel: string; workerModel: string; allowedTools: string[]; maxTurns: number; workspace: string; templates: string[] };
    voice: { sttVendor: string; language: string; languageHints: string[]; ttsVoiceId: string; ttsModel: string; bargeIn: number; sttModels: Record<string, string> };
    budget: { capUsd: number };
    cloud: { enabled: boolean; concurrency: number; vaultId: string; agentId: string };
    mexty: { frontUrl: string; apiUrl: string; preview: string };
  };
  secrets: Record<string, { set: boolean; last4: string }>;
  devices: Device[];
  readiness: { mexty: boolean };
  spend: { thisMonth: { total: number; episodes: number }; months: { month: string; total: number; episodes: number }[]; episodes: { id: string; no: number; company: string; startedAt: number; cost: { total: number } }[] };
  mextyLink: { secretSet: boolean; webhookUrl: string };
  publicUrl: string;
}
const TABS = ["Appareils", "Claude Code", "Voix", "Clés API", "Budget"] as const;

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="flex items-center justify-between gap-4 border-b border-line py-2.5 last:border-0">
      <span className="flex min-w-0 flex-col">
        <span className="text-sm font-semibold">{label}</span>
        {hint && <span className="text-xs leading-snug text-muted">{hint}</span>}
      </span>
      <span className="w-[46%] shrink-0">{children}</span>
    </label>
  );
}
function Toggle({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button role="switch" aria-checked={on} aria-label={label} onClick={() => onChange(!on)} className="relative h-8 w-14 rounded-full border-0 transition-colors" style={{ background: on ? "#7B3FE4" : "var(--track)" }}>
      <span className="absolute top-1 block h-6 w-6 rounded-full bg-white transition-all" style={{ left: on ? 28 : 4 }} />
    </button>
  );
}

export function Settings() {
  const set = useApp((s) => s.set);
  const theme = useApp((s) => s.theme);
  const [tab, setTab] = useState<(typeof TABS)[number]>("Appareils");
  const [v, setV] = useState<View | null>(null);
  const [pair, setPair] = useState<{ code: string; expiresAt: number; server: string } | null>(null);
  const [voices, setVoices] = useState<{ id: string; name: string; languages: string[] }[]>([]);
  const [keyDraft, setKeyDraft] = useState<Record<string, string>>({});

  const load = () => api<View>("/api/settings").then(setV).catch((e) => useApp.getState().error(e.message));
  useEffect(() => {
    void load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    if (tab === "Voix") void api<{ voices: typeof voices }>("/api/voices").then((j) => setVoices(j.voices)).catch(() => {});
  }, [tab, v?.secrets.elevenlabs?.set]);

  const patch = (p: unknown) => api<View>("/api/settings", { method: "PATCH", json: p }).then(setV).catch((e) => useApp.getState().error(e.message));
  const dev = (id: string, p: unknown) => api(`/api/devices/${id}`, { method: "PATCH", json: p }).then(load);
  if (!v) return <div className="screen" />;
  const st = v.settings;
  const server = pair?.server || v.publicUrl || location.origin;

  return (
    <div className="screen">
      <div className="side flex w-[190px] shrink-0 flex-col gap-1.5">
        <button onClick={() => set({ screen: "setup" })} className="h-11 rounded-2xl border border-line bg-surface text-left text-sm font-semibold text-text px-4">← Retour</button>
        {TABS.map((t) => (
          <button key={t} aria-current={tab === t} onClick={() => setTab(t)} className="h-11 rounded-2xl px-4 text-left text-sm text-text" style={tab === t ? { border: "2px solid #7B3FE4", background: "var(--chip-on)", fontWeight: 700 } : { border: "1px solid transparent", background: "transparent", fontWeight: 500 }}>
            {t}
          </button>
        ))}
        <button onClick={() => setTheme(theme === "dark" ? "light" : "dark")} className="mt-auto h-11 rounded-2xl border border-line bg-surface px-4 text-left text-sm font-semibold text-text">Thème {theme === "dark" ? "sombre" : "clair"}</button>
      </div>

      <div className="card min-w-0 grow overflow-y-auto rounded-3xl px-5 py-3">
        {tab === "Appareils" && (
          <>
            <h2 className="m-0 mb-1 font-display text-xl font-extrabold">Appareils</h2>
            <p className="m-0 mb-2 text-xs text-muted">Les workers tournent sur tes machines, avec leur propre connexion Claude Code. Les appareils en ligne passent en premier.</p>
            {v.devices.length === 0 && <p className="text-sm text-muted">Aucun appareil associé.</p>}
            {v.devices.map((d) => (
              <div key={d.id} className="flex items-center gap-3 border-b border-line py-2.5">
                <span aria-hidden className="block h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: d.online ? "#5FE0C0" : "#6B7499" }} />
                <div className="min-w-0 grow">
                  <div className="text-sm font-bold">{d.name} <span className="font-medium text-muted">· {d.online ? "en ligne" : d.lastSeen ? "hors ligne" : "jamais connecté"}</span></div>
                  <div className="truncate text-xs text-muted">
                    {[d.platform, d.claudeCodeVersion && `Claude Code ${d.claudeCodeVersion}`, d.mcpServers.length ? `MCP : ${d.mcpServers.map((m) => `${m.name} (${m.status})`).join(", ")}` : null, `${d.activeSessions} session${d.activeSessions > 1 ? "s" : ""} active${d.activeSessions > 1 ? "s" : ""}`].filter(Boolean).join(" · ")}
                  </div>
                </div>
                <label className="flex items-center gap-1.5 text-xs text-muted">
                  en parallèle
                  <input type="number" min={1} max={8} value={d.concurrency} onChange={(e) => void dev(d.id, { concurrency: Number(e.target.value) })} className="field !h-9 !w-14 !px-2 text-center" />
                </label>
                <Toggle on={d.enabled} onChange={(on) => void dev(d.id, { enabled: on })} label={`Activer ${d.name}`} />
                <button onClick={() => confirm(`Dissocier ${d.name} ?`) && void api(`/api/devices/${d.id}`, { method: "DELETE" }).then(load)} className="h-9 rounded-full border border-line bg-field px-3 text-xs font-semibold text-text">Dissocier</button>
              </div>
            ))}
            <div className="mt-3 rounded-2xl bg-field p-3">
              {pair && pair.expiresAt > Date.now() ? (
                <>
                  <div className="text-xs text-muted">Sur la machine à associer (valable 10 minutes, un seul appareil) :</div>
                  <div className="my-1 font-display text-4xl font-extrabold tracking-[0.2em]">{pair.code}</div>
                  <code className="block select-all break-all text-xs">npx ride-agent pair {pair.code} --server {server}</code>
                </>
              ) : (
                <button onClick={() => void api<typeof pair>("/api/devices/pair-code", { method: "POST" }).then(setPair)} className="mx-grad h-11 rounded-full border-0 px-5 text-sm font-bold text-white">Associer un appareil</button>
              )}
            </div>
            <h3 className="mb-0 mt-4 text-sm font-bold">Repli cloud (Claude Managed Agents)</h3>
            <Row label="Activer le repli cloud" hint="Facturé sur ta clé API Anthropic, quand aucun appareil n'est libre."><Toggle on={st.cloud.enabled} onChange={(on) => void patch({ cloud: { enabled: on } })} label="Repli cloud" /></Row>
            <Row label="Sessions en parallèle"><input type="number" min={1} max={8} className="field" value={st.cloud.concurrency} onChange={(e) => void patch({ cloud: { concurrency: Number(e.target.value) } })} /></Row>
            <Row label="Coffre des accès MCP" hint="Identifiant du vault Anthropic qui contient les accès MEXTY et EDVERSE."><input className="field" placeholder="vlt_…" defaultValue={st.cloud.vaultId} onBlur={(e) => void patch({ cloud: { vaultId: e.target.value.trim() } })} /></Row>
          </>
        )}

        {tab === "Claude Code" && (
          <>
            <h2 className="m-0 mb-1 font-display text-xl font-extrabold">Claude Code</h2>
            <Row label="Modèle des workers"><select className="field" value={st.claude.workerModel} onChange={(e) => void patch({ claude: { workerModel: e.target.value } })}>{["claude-sonnet-5-5", "claude-opus-5-5", "claude-haiku-5-5", "claude-fable-5-2"].map((m) => <option key={m}>{m}</option>)}</select></Row>
            <Row label="Modèle de la co-animatrice" hint="Haiku pour répondre en moins d'une seconde."><select className="field" value={st.claude.directorModel} onChange={(e) => void patch({ claude: { directorModel: e.target.value } })}>{["claude-haiku-5-5", "claude-sonnet-5-5"].map((m) => <option key={m}>{m}</option>)}</select></Row>
            <Row label="Profil de permissions" hint="Les workers n'ont accès à aucun autre outil : ni fichiers, ni terminal, ni web.">
              <div className="flex flex-wrap gap-1.5">{st.claude.allowedTools.map((t) => <span key={t} className="rounded-full bg-chip-on px-2.5 py-1 text-xs font-bold">{t.replace("mcp__", "")}</span>)}<span className="self-center text-xs text-muted">uniquement</span></div>
            </Row>
            <Row label="Espace de travail Mexty par défaut"><input className="field" defaultValue={st.claude.workspace} onBlur={(e) => void patch({ claude: { workspace: e.target.value.trim() } })} /></Row>
            <Row label="Modèles de départ" hint="Séparés par des virgules."><input className="field" defaultValue={st.claude.templates.join(", ")} onBlur={(e) => void patch({ claude: { templates: e.target.value.split(",").map((x) => x.trim()).filter(Boolean) } })} /></Row>
            <Row label="Aperçu en direct" hint={v.readiness.mexty ? "Session de service Mexty disponible." : v.mextyLink.secretSet ? "Mexty ne répond pas encore : aperçu simplifié en attendant." : "Secret partagé non configuré : aperçu simplifié."}>
              <select className="field" value={st.mexty.preview} onChange={(e) => void patch({ mexty: { preview: e.target.value } })}><option value="auto">Automatique</option><option value="mexty">Mexty (mode live)</option><option value="mock">Simplifié</option></select>
            </Row>
            <Row label="Adresse de Mexty"><input className="field" defaultValue={st.mexty.frontUrl} onBlur={(e) => void patch({ mexty: { frontUrl: e.target.value.trim().replace(/\/$/, "") } })} /></Row>
            <Row label="API de Mexty"><input className="field" defaultValue={st.mexty.apiUrl} onBlur={(e) => void patch({ mexty: { apiUrl: e.target.value.trim().replace(/\/$/, "") } })} /></Row>
          </>
        )}

        {tab === "Voix" && (
          <>
            <h2 className="m-0 mb-1 font-display text-xl font-extrabold">Voix</h2>
            <Row label="Transcription" hint="Choisie après le test micro."><select className="field" value={st.voice.sttVendor} onChange={(e) => void patch({ voice: { sttVendor: e.target.value } })}><option value="elevenlabs">ElevenLabs Scribe</option><option value="deepgram">Deepgram</option><option value="openai">OpenAI</option></select></Row>
            {(["elevenlabs", "deepgram", "openai"] as const).map((k) => (
              <Row key={k} label={`Modèle ${k}`}><input className="field" defaultValue={st.voice.sttModels[k]} onBlur={(e) => void patch({ voice: { sttModels: { [k]: e.target.value.trim() } } })} /></Row>
            ))}
            <Row label="Langue"><select className="field" value={st.voice.language} onChange={(e) => void patch({ voice: { language: e.target.value } })}><option value="fr">Français</option><option value="en">English</option></select></Row>
            <Row label="Mots à reconnaître" hint="Noms propres et jargon, séparés par des virgules."><input className="field" defaultValue={st.voice.languageHints.join(", ")} onBlur={(e) => void patch({ voice: { languageHints: e.target.value.split(",").map((x) => x.trim()).filter(Boolean) } })} /></Row>
            <Row label="Voix de Claude"><select className="field" value={st.voice.ttsVoiceId} onChange={(e) => void patch({ voice: { ttsVoiceId: e.target.value } })}><option value="">Automatique (voix française)</option>{voices.map((x) => <option key={x.id} value={x.id}>{x.name}{x.languages.length ? ` · ${x.languages.slice(0, 3).join(", ")}` : ""}</option>)}</select></Row>
            <Row label="Modèle de voix"><select className="field" value={st.voice.ttsModel} onChange={(e) => void patch({ voice: { ttsModel: e.target.value } })}>{["eleven_flash_v2_5", "eleven_v4_turbo", "eleven_v3_conversational", "eleven_multilingual_v2"].map((m) => <option key={m}>{m}</option>)}</select></Row>
            <Row label="Couper la parole" hint="Plus haut : Claude se tait plus facilement quand tu parles."><input type="range" min={0} max={1} step={0.05} value={st.voice.bargeIn} onChange={(e) => void patch({ voice: { bargeIn: Number(e.target.value) } })} className="w-full accent-[#7B3FE4]" aria-label="Sensibilité" /></Row>
          </>
        )}

        {tab === "Clés API" && (
          <>
            <h2 className="m-0 mb-1 font-display text-xl font-extrabold">Clés API</h2>
            <p className="m-0 mb-2 text-xs text-muted">Chiffrées sur le serveur. Elles ne sont jamais renvoyées au téléphone : seuls les quatre derniers caractères s'affichent.</p>
            {([["anthropic", "Anthropic", "Co-animatrice et repli cloud"], ["elevenlabs", "ElevenLabs", "Voix de Claude et transcription Scribe"], ["deepgram", "Deepgram", "Transcription, optionnel"], ["openai", "OpenAI", "Transcription, optionnel"]] as const).map(([k, name, hint]) => (
              <div key={k} className="flex items-center gap-3 border-b border-line py-2.5 last:border-0">
                <div className="w-44 shrink-0">
                  <div className="text-sm font-semibold">{name}</div>
                  <div className="text-xs text-muted">{v.secrets[k]?.set ? `Enregistrée · …${v.secrets[k].last4}` : hint}</div>
                </div>
                <input className="field" type="password" autoComplete="off" placeholder={v.secrets[k]?.set ? "Remplacer la clé" : "Coller la clé"} value={keyDraft[k] ?? ""} onChange={(e) => setKeyDraft({ ...keyDraft, [k]: e.target.value })} aria-label={`Clé ${name}`} />
                <button disabled={!keyDraft[k]} onClick={() => void api<View>(`/api/secrets/${k}`, { method: "PUT", json: { value: keyDraft[k] } }).then((x) => { setV(x); setKeyDraft({ ...keyDraft, [k]: "" }); })} className="mx-grad h-11 shrink-0 rounded-full border-0 px-4 text-sm font-bold text-white">Enregistrer</button>
                {v.secrets[k]?.set && <button onClick={() => confirm(`Supprimer la clé ${name} ?`) && void api<View>(`/api/secrets/${k}`, { method: "PUT", json: { value: "" } }).then(setV)} className="h-11 shrink-0 rounded-full border border-line bg-field px-3 text-xs font-semibold text-text">Supprimer</button>}
              </div>
            ))}
          </>
        )}

        {tab === "Budget" && (
          <>
            <h2 className="m-0 mb-1 font-display text-xl font-extrabold">Budget</h2>
            <Row label="Plafond par épisode" hint="Co-animatrice, voix et workers confondus. Alerte à 80 %, arrêt au plafond."><input type="number" min={1} max={500} className="field" value={st.budget.capUsd} onChange={(e) => void patch({ budget: { capUsd: Number(e.target.value) } })} /></Row>
            <div className="mt-3 grid grid-cols-3 gap-2.5">
              <div className="rounded-2xl bg-field p-3"><div className="font-display text-2xl font-extrabold">{fmtUsd(v.spend.thisMonth.total)}</div><div className="text-xs text-muted">ce mois-ci · {v.spend.thisMonth.episodes} épisode{v.spend.thisMonth.episodes > 1 ? "s" : ""}</div></div>
              {v.spend.months.slice(-3, -1).map((m) => <div key={m.month} className="rounded-2xl bg-field p-3"><div className="font-display text-2xl font-extrabold">{fmtUsd(m.total)}</div><div className="text-xs text-muted">{m.month} · {m.episodes} ép.</div></div>)}
            </div>
            <p className="mb-1 mt-3 text-xs text-muted">Les sessions sur tes appareils passent par ton abonnement Claude Code : leur montant est une valeur équivalente au tarif public, comptée dans le plafond.</p>
            {v.spend.episodes.map((e) => (
              <div key={e.id} className="flex justify-between border-b border-line py-1.5 text-sm last:border-0"><span>Ép. {e.no} · {e.company || "sans nom"} <span className="text-muted">· {new Date(e.startedAt).toLocaleDateString("fr-FR")}</span></span><span className="font-semibold tabular-nums">{fmtUsd(e.cost.total)}</span></div>
            ))}
          </>
        )}
      </div>
    </div>
  );
}
