import { useEffect, useMemo, useState } from "react";
import { api, useApp, type PosterItem } from "../store";

type Size = "A4" | "A5" | "A6";
type Look = "mexty" | "light" | "dark";

const LOOKS: Record<Look, { label: string; bg: string; text: string; sub: string; card: string }> = {
  mexty: { label: "Mexty", bg: "linear-gradient(140deg,#2f5bff 0%,#7b3fe4 40%,#e8388f 75%,#ff8a3d 100%)", text: "#fff", sub: "rgba(255,255,255,.9)", card: "#fff" },
  light: { label: "Clair", bg: "#ffffff", text: "#0B1640", sub: "#3b4570", card: "#F2F4FF" },
  dark: { label: "Nuit", bg: "#0B1640", text: "#fff", sub: "rgba(255,255,255,.85)", card: "#fff" },
};

const propsIdOf = (url?: string) => {
  try {
    return url ? new URL(url).searchParams.get("propsId") || undefined : undefined;
  } catch {
    return undefined;
  }
};
const kindLabel = (e: string) => (e === "program" ? "Parcours" : e === "course" ? "Cours" : e === "evaluation" ? "Évaluation" : "Activité");

/**
 * The QR poster left on site (a monument, a museum, a shop): at the end of the ride the content becomes a public
 * Mexty link anyone opens for free, without an account, and this page lays it out to print and laminate.
 */
export function Poster() {
  const poster = useApp((s) => s.poster);
  const set = useApp((s) => s.set);
  const items = poster?.items ?? [];
  const [pick, setPick] = useState(() => Math.max(0, items.findIndex((i) => i.entity === "program")));
  const item: PosterItem | undefined = items[pick];
  const [title, setTitle] = useState(item?.title ?? "");
  const [place, setPlace] = useState(poster?.place ?? "");
  const [text, setText] = useState("Scannez et apprenez gratuitement, ici et maintenant. Sans compte, sans appli.");
  const [size, setSize] = useState<Size>("A4");
  const [look, setLook] = useState<Look>("mexty");
  const [link, setLink] = useState<{ url: string; visits: number } | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!item) return;
    setTitle(item.title);
    setLink(null);
    setErr("");
    setBusy(true);
    api<{ url: string; visits: number }>("/api/poster/link", { method: "POST", json: { entity: item.entity, entityId: item.entityId, propsId: propsIdOf(item.url) } })
      .then(setLink)
      .catch((e: Error) => setErr(e.message))
      .finally(() => setBusy(false));
  }, [item?.entity, item?.entityId]);

  // The printed page: exactly the poster, at the chosen paper size.
  useEffect(() => {
    const st = document.createElement("style");
    st.textContent = `@page { size: ${size} portrait; margin: 0 } @media print { body * { visibility: hidden !important } #rs-poster, #rs-poster * { visibility: visible !important } #rs-poster { position: fixed !important; inset: 0 !important; width: 100% !important; height: 100% !important; max-width: none !important; border-radius: 0 !important; box-shadow: none !important; -webkit-print-color-adjust: exact; print-color-adjust: exact } }`;
    document.head.appendChild(st);
    return () => st.remove();
  }, [size]);

  const L = LOOKS[look];
  const qr = useMemo(() => (link ? `/api/qr.svg?u=${encodeURIComponent(link.url)}` : ""), [link]);
  const back = () => set({ screen: poster?.back ?? "setup", poster: null });

  if (!items.length)
    return (
      <div className="screen flex-col items-start">
        <p className="text-muted">Aucun contenu livré pour faire une affiche.</p>
        <button onClick={back} className="h-11 rounded-full border border-line bg-field px-4 text-sm font-semibold text-text">Retour</button>
      </div>
    );

  return (
    <div className="screen">
      <div className="side flex w-[340px] shrink-0 flex-col gap-3 overflow-y-auto">
        <div className="flex items-center justify-between gap-2">
          <div>
            <div className="eyebrow">Affiche QR</div>
            <h1 className="m-0 font-display text-2xl font-extrabold tracking-tight">À laisser sur place</h1>
          </div>
          <button onClick={back} className="h-10 rounded-full border border-line bg-field px-4 text-sm font-semibold text-text">Retour</button>
        </div>
        {items.length > 1 && (
          <div className="flex flex-col gap-1.5">
            <span className="label">Ce que le QR ouvre</span>
            {items.map((it, i) => (
              <button key={it.entityId} onClick={() => setPick(i)} className={`card rounded-2xl px-3 py-2 text-left text-sm ${i === pick ? "outline outline-2 outline-[#7b3fe4]" : ""}`}>
                <span className="block text-[11px] font-bold uppercase tracking-wider text-muted">{kindLabel(it.entity)}</span>
                <span className="font-semibold">{it.title}</span>
              </button>
            ))}
          </div>
        )}
        <label className="label" htmlFor="pt">Titre</label>
        <input id="pt" className="field" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={80} />
        <label className="label" htmlFor="pp">Lieu</label>
        <input id="pp" className="field" value={place} onChange={(e) => setPlace(e.target.value)} maxLength={80} placeholder="Ex. Pont du Gard" />
        <label className="label" htmlFor="px">Message</label>
        <textarea id="px" className="field h-24 py-2" value={text} onChange={(e) => setText(e.target.value)} maxLength={180} />
        <div className="flex gap-2">
          {(["A4", "A5", "A6"] as Size[]).map((s) => (
            <button key={s} onClick={() => setSize(s)} className={`h-10 grow rounded-full border border-line px-3 text-sm font-semibold ${size === s ? "bg-text text-bg" : "bg-field text-text"}`}>{s}</button>
          ))}
        </div>
        <div className="flex gap-2">
          {(Object.keys(LOOKS) as Look[]).map((k) => (
            <button key={k} onClick={() => setLook(k)} className={`h-10 grow rounded-full border border-line px-3 text-sm font-semibold ${look === k ? "bg-text text-bg" : "bg-field text-text"}`}>{LOOKS[k].label}</button>
          ))}
        </div>
        {err && <div role="alert" className="rounded-xl bg-rec-bg px-3 py-2 text-sm font-semibold text-rec-text">{err}</div>}
        {link && (
          <p className="m-0 break-all text-xs text-muted">
            Lien public : <a href={link.url} target="_blank" rel="noopener" className="font-semibold text-accent-text">{link.url}</a>
            {link.visits ? ` · ${link.visits} visite${link.visits > 1 ? "s" : ""}` : ""}
          </p>
        )}
        <button disabled={!link} onClick={() => window.print()} className="mx-grad h-14 shrink-0 rounded-2xl border-0 font-display text-xl font-extrabold text-white">{busy ? "Création du lien…" : "Imprimer"}</button>
      </div>

      <div className="flex min-w-0 grow items-start justify-center overflow-auto">
        <div
          id="rs-poster"
          className="flex w-full max-w-[460px] flex-col items-center gap-[4%] overflow-hidden rounded-2xl px-[8%] py-[9%] text-center shadow-2xl"
          style={{ aspectRatio: "210 / 297", background: L.bg, color: L.text, containerType: "inline-size" }}
        >
          {place && <div style={{ fontSize: "4.2cqw", fontWeight: 800, letterSpacing: ".18em", textTransform: "uppercase", color: L.sub }}>{place}</div>}
          <div className="font-display" style={{ fontSize: "9.5cqw", fontWeight: 800, lineHeight: 1.02, letterSpacing: "-.02em" }}>{title || item?.title}</div>
          <div style={{ fontSize: "4.4cqw", lineHeight: 1.35, color: L.sub, maxWidth: "88%" }}>{text}</div>
          <div className="mt-auto flex flex-col items-center" style={{ background: L.card, borderRadius: "5cqw", padding: "4cqw" }}>
            {qr ? <img src={qr} alt="QR code vers la formation" style={{ width: "52cqw", height: "52cqw", display: "block" }} /> : <div style={{ width: "52cqw", height: "52cqw" }} />}
          </div>
          <div style={{ fontSize: "3.6cqw", fontWeight: 700, color: L.sub }}>{item ? `${kindLabel(item.entity)} gratuit · ` : ""}fait avec Mexty · mexty.ai</div>
        </div>
      </div>
    </div>
  );
}
