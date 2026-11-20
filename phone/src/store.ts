import { create } from "zustand";
import type { ChangeEvent, StudioState } from "../../shared/protocol";

export type Screen = "setup" | "live" | "arrival" | "settings" | "bakeoff" | "library" | "radio";
export interface SttLine {
  vendor: string;
  kind: string;
  text: string;
  ts: number;
  ms?: number;
}

interface AppState {
  authed: boolean | null;
  connected: boolean;
  screen: Screen;
  theme: "dark" | "light";
  studio: StudioState | null;
  claudeLine: string;
  userLine: string;
  partial: string;
  errors: string[];
  changes: { event: ChangeEvent; slot: number | null; at: number }[];
  bake: Record<string, { partial: string; finals: SttLine[] }>;
  bakeSaved: { url: string; seconds: number } | null;
  recording: boolean;
  recStartedAt: number;
  uploads: Record<string, { sent: number; total: number; done: boolean; error?: string }>;
  set: (p: Partial<AppState>) => void;
  error: (m: string) => void;
}

const savedTheme = (() => {
  try {
    return localStorage.getItem("rs-theme") === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
})() as "dark" | "light";

export const useApp = create<AppState>((set) => ({
  authed: null,
  connected: false,
  screen: "setup",
  theme: savedTheme,
  studio: null,
  claudeLine: "",
  userLine: "",
  partial: "",
  errors: [],
  changes: [],
  bake: {},
  bakeSaved: null,
  recording: false,
  recStartedAt: 0,
  uploads: {},
  set,
  error: (m) => set((s) => ({ errors: [...s.errors.slice(-3), m] })),
}));

export function setTheme(theme: "dark" | "light") {
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem("rs-theme", theme);
  } catch {
    /* private mode */
  }
  useApp.getState().set({ theme });
}
document.documentElement.dataset.theme = savedTheme;

export async function api<T = unknown>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const r = await fetch(path, {
    ...init,
    credentials: "same-origin",
    headers: init?.json !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: init?.json !== undefined ? JSON.stringify(init.json) : init?.body,
  });
  if (r.status === 401 && path !== "/api/login") useApp.getState().set({ authed: false });
  const j = (await r.json().catch(() => ({}))) as T & { error?: string };
  if (!r.ok) throw new Error(j.error || `Erreur ${r.status}`);
  return j;
}

export const fmtClock = (sec: number) => `${String(Math.floor(Math.max(0, sec) / 60)).padStart(2, "0")}:${String(Math.floor(Math.max(0, sec) % 60)).padStart(2, "0")}`;
export const fmtUsd = (n: number) => `${n.toFixed(2).replace(".", ",")} $`;
