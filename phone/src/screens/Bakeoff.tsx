import { useEffect, useState } from "react";
import { audio } from "../audio";
import { link } from "../link";
import { useApp } from "../store";

const NAMES: Record<string, string> = { elevenlabs: "ElevenLabs Scribe", deepgram: "Deepgram", openai: "OpenAI" };

/** M0: the same microphone audio goes to every vendor with a key, side by side, with end-of-turn times. */
export function Bakeoff() {
  const bake = useApp((s) => s.bake);
  const saved = useApp((s) => s.bakeSaved);
  const ready = useApp((s) => s.studio?.readiness.stt ?? []);
  const set = useApp((s) => s.set);
  const [on, setOn] = useState(false);

  useEffect(() => () => {
    link.send({ t: "stt.stop" });
    audio.stop();
  }, []);

  const toggle = async () => {
    if (on) {
      link.send({ t: "stt.stop" });
      audio.stop();
      setOn(false);
      return;
    }
    try {
      await audio.start(false);
      set({ bake: {}, bakeSaved: null });
      link.send({ t: "stt.start", bakeoff: true });
      setOn(true);
    } catch (e) {
      useApp.getState().error((e as Error).message);
    }
  };

  return (
    <div className="screen flex-col">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="eyebrow">Test de transcription</div>
          <h1 className="m-0 font-display text-2xl font-extrabold tracking-tight">Même micro, {ready.length || "aucun"} fournisseur{ready.length > 1 ? "s" : ""}</h1>
        </div>
        <div className="flex items-center gap-2">
          {saved && <a href={saved.url} className="text-sm font-semibold text-accent-text">Audio brut ({saved.seconds} s)</a>}
          <button onClick={() => set({ screen: "setup" })} className="h-11 rounded-full border border-line bg-field px-4 text-sm font-semibold text-text">Retour</button>
          <button onClick={toggle} disabled={!ready.length} className={`h-11 rounded-full border-0 px-5 text-sm font-bold text-white ${on ? "bg-[#FF3B3B]" : "mx-grad"}`}>{on ? "Arrêter" : "Démarrer"}</button>
        </div>
      </div>
      {!ready.length && <p className="m-0 text-sm text-muted">Ajoute au moins une clé (ElevenLabs, Deepgram ou OpenAI) dans Réglages → Clés API.</p>}
      <div className="grid min-h-0 grow gap-3" style={{ gridTemplateColumns: `repeat(${Math.max(1, ready.length)}, minmax(0, 1fr))` }}>
        {ready.map((v) => {
          const b = bake[v] ?? { partial: "", finals: [] };
          const turns = b.finals.filter((f) => f.kind === "eot");
          return (
            <div key={v} className="card flex min-h-0 flex-col gap-2 rounded-2xl p-3">
              <div className="flex items-baseline justify-between">
                <span className="font-display text-lg font-bold">{NAMES[v] ?? v}</span>
                <span className="text-xs text-muted">{turns.length} tour{turns.length > 1 ? "s" : ""}</span>
              </div>
              <div className="flex min-h-0 grow flex-col-reverse gap-1.5 overflow-y-auto">
                {b.partial && <p className="m-0 text-sm italic text-muted">{b.partial}</p>}
                {[...b.finals].reverse().filter((f) => f.kind !== "final").map((f, i) => (
                  <p key={i} className="m-0 text-sm leading-snug" style={f.kind === "error" ? { color: "var(--bad)" } : undefined}>
                    <span className="mr-1.5 rounded bg-field px-1.5 py-0.5 text-[10px] font-bold tabular-nums text-muted">{f.kind === "open" ? "prêt" : `${((f.ms ?? 0) / 1000).toFixed(2)} s`}</span>
                    {f.text}
                  </p>
                ))}
              </div>
            </div>
          );
        })}
      </div>
      <p className="m-0 text-xs text-muted">Chaque ligne est une fin de tour détectée, avec son heure depuis le départ : compare la justesse des mots et le délai entre la fin de ta phrase et la ligne.</p>
    </div>
  );
}
