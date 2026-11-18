import { useEffect, useState } from "react";
import { link } from "./link";
import { Arrival } from "./screens/Arrival";
import { Bakeoff } from "./screens/Bakeoff";
import { Live } from "./screens/Live";
import { Settings } from "./screens/Settings";
import { Setup } from "./screens/Setup";
import { api, useApp } from "./store";

function Login() {
  const [code, setCode] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr("");
    try {
      await api("/api/login", { method: "POST", json: { code } });
      useApp.getState().set({ authed: true });
    } catch (x) {
      setErr((x as Error).message);
    }
    setBusy(false);
  };
  return (
    <div className="screen items-center justify-center">
      <form onSubmit={submit} className="card w-full max-w-sm rounded-3xl p-6 flex flex-col gap-4">
        <div>
          <div className="eyebrow">Ride Studio</div>
          <h1 className="m-0 font-display text-3xl font-extrabold tracking-tight">Code d'accès</h1>
        </div>
        <input className="field" type="password" autoComplete="current-password" autoFocus value={code} onChange={(e) => setCode(e.target.value)} aria-label="Code d'accès" />
        {err && <div role="alert" className="text-sm text-bad">{err}</div>}
        <button disabled={busy || !code} className="mx-grad h-14 rounded-2xl border-0 font-display text-xl font-extrabold text-white">Entrer</button>
      </form>
    </div>
  );
}

export function App() {
  const authed = useApp((s) => s.authed);
  const screen = useApp((s) => s.screen);
  const errors = useApp((s) => s.errors);

  useEffect(() => {
    void api<{ authed: boolean }>("/api/me").then((j) => useApp.getState().set({ authed: j.authed })).catch(() => useApp.getState().set({ authed: false }));
  }, []);
  useEffect(() => {
    if (authed) link.open();
    return () => link.close();
  }, [authed]);
  useEffect(() => {
    if (!errors.length) return;
    const t = setTimeout(() => useApp.getState().set({ errors: [] }), 7000);
    return () => clearTimeout(t);
  }, [errors]);

  if (authed === null) return <div className="screen" />;
  if (!authed) return <Login />;
  return (
    <>
      {screen === "setup" && <Setup />}
      {screen === "live" && <Live />}
      {screen === "arrival" && <Arrival />}
      {screen === "settings" && <Settings />}
      {screen === "bakeoff" && <Bakeoff />}
      {errors.length > 0 && (
        <div role="alert" className="fixed left-1/2 top-3 z-50 max-w-[90vw] -translate-x-1/2 rounded-xl bg-rec-bg px-4 py-2 text-sm font-semibold text-rec-text shadow-lg">
          {errors.at(-1)}
        </div>
      )}
    </>
  );
}
