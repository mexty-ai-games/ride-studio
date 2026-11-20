import type { CostState, PlanWindow } from "../../../shared/protocol";
import { fmtUsd } from "../store";

const PLAN: Record<string, string> = { pro: "Pro", max: "Max", team: "Team", enterprise: "Enterprise" };
const planName = (c: CostState) => (c.plan?.subscription ? `Claude ${PLAN[c.plan.subscription] ?? c.plan.subscription}` : "Claude");
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString("fr-FR", { weekday: "short", hour: "2-digit", minute: "2-digit" }) : "");
const delta = (w: PlanWindow) => Math.max(0, Math.round(w.pct - w.start));

/** One line for the cost card: real money, and the Claude plan share when machines did the work. */
export function costSummary(c: CostState): string {
  const w = c.plan?.fiveHour;
  return w ? `${planName(c)} · 5 h : ${Math.round(w.pct)} %${delta(w) ? ` (+${delta(w)})` : ""}` : c.planEquivalent > 0 ? `Plan Claude · équiv. API ${fmtUsd(c.planEquivalent)}` : "";
}

/** The exact spend of the episode, by who bills it. */
export function CostDetail({ c, onClose }: { c: CostState; onClose: () => void }) {
  const row = (label: string, hint: string, value: string, muted = false) => (
    <div className="flex items-baseline justify-between gap-4 border-b border-line py-2 last:border-0">
      <span className="flex min-w-0 flex-col">
        <span className="text-sm font-semibold">{label}</span>
        <span className="text-xs text-muted">{hint}</span>
      </span>
      <span className="shrink-0 text-sm font-bold tabular-nums" style={muted ? { color: "var(--muted)" } : undefined}>{value}</span>
    </div>
  );
  const win = (name: string, w: PlanWindow | null | undefined) =>
    w ? row(`${planName(c)} · fenêtre ${name}`, `${delta(w) ? `+${delta(w)} % pendant l'épisode · ` : ""}remise à zéro ${when(w.resetsAt)}`, `${Math.round(w.pct)} %`) : null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div className="card flex max-h-full w-full max-w-lg flex-col overflow-y-auto rounded-3xl p-5" onClick={(e) => e.stopPropagation()}>
        <div className="mb-1 flex items-baseline justify-between">
          <span className="font-display text-xl font-extrabold">Coût de l'épisode</span>
          <span className="text-sm font-bold">{fmtUsd(c.total)} / {c.cap} $</span>
        </div>
        <span className="eyebrow mt-2">Payé à l'usage</span>
        {row("Orchestrateur", "La voix : API Claude, clé Anthropic", fmtUsd(c.director))}
        {row("ElevenLabs", "Voix de Claude et transcription Scribe", fmtUsd(c.elevenlabs))}
        {c.otherApis > 0 && row("Autres API", "Transcription Deepgram ou OpenAI", fmtUsd(c.otherApis))}
        {c.cloud > 0 && row("Workers cloud", "Claude Managed Agents, clé Anthropic", fmtUsd(c.cloud))}
        <span className="eyebrow mt-3">Inclus dans le plan Claude</span>
        {win("5 h", c.plan?.fiveHour)}
        {win("7 jours", c.plan?.sevenDay)}
        {!c.plan && c.planEquivalent > 0 && <p className="my-1 text-xs text-muted">Utilisation du plan pas encore lue sur la machine (mettre à jour le démon).</p>}
        {row("Workers sur ta machine", "Ce que ce travail coûterait via l'API : non facturé", fmtUsd(c.planEquivalent), true)}
        <p className="mb-0 mt-3 text-xs text-muted">Le plafond de {c.cap} $ ne compte que l'argent réellement dépensé. Tarifs publics, estimations.</p>
        <button onClick={onClose} className="mt-3 h-10 self-end rounded-full border border-line bg-field px-4 text-sm font-semibold text-text">Fermer</button>
      </div>
    </div>
  );
}
