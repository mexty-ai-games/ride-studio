import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { NextFunction, Request, Response } from "express";
import { config } from "./config.js";

const COOKIE = "rs_session";
const TTL_MS = 30 * 24 * 3600 * 1000;

const sign = (payload: string) => createHmac("sha256", config.sessionSecret).update(payload).digest("base64url");

export function safeEqual(a: string, b: string): boolean {
  const x = createHmac("sha256", "cmp").update(a).digest();
  const y = createHmac("sha256", "cmp").update(b).digest();
  return timingSafeEqual(x, y);
}

export function issueSession(res: Response) {
  const exp = String(Date.now() + TTL_MS);
  res.cookie(COOKIE, `${exp}.${sign(exp)}`, { httpOnly: true, secure: config.prod, sameSite: "lax", maxAge: TTL_MS, path: "/" });
}
export function clearSession(res: Response) {
  res.clearCookie(COOKIE, { path: "/" });
}

export function isAuthed(req: IncomingMessage): boolean {
  const raw = (req.headers.cookie || "").split(";").map((s) => s.trim()).find((s) => s.startsWith(COOKIE + "="));
  if (!raw) return false;
  const [exp, sig] = decodeURIComponent(raw.slice(COOKIE.length + 1)).split(".");
  if (!exp || !sig || !safeEqual(sig, sign(exp))) return false;
  return Number(exp) > Date.now();
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (isAuthed(req)) return next();
  res.status(401).json({ error: "unauthorized" });
}

// Small in-memory limiter for the login and pairing endpoints.
const hits = new Map<string, { n: number; reset: number }>();
export function limited(key: string, max: number, windowMs: number): boolean {
  const now = Date.now();
  const h = hits.get(key);
  if (!h || h.reset < now) {
    hits.set(key, { n: 1, reset: now + windowMs });
    return false;
  }
  h.n++;
  return h.n > max;
}
