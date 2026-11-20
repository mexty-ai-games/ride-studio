import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomBytes } from "node:crypto";

const here = dirname(fileURLToPath(import.meta.url));

/** Walk up from this file until `rel` exists (works from src/ under tsx and from dist/). */
export function findUp(rel: string): string | null {
  let dir = here;
  for (let i = 0; i < 7; i++) {
    const p = join(dir, rel);
    if (existsSync(p)) return p;
    dir = dirname(dir);
  }
  return null;
}

const prod = process.env.NODE_ENV === "production";
const dataDir = resolve(process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || ".data");
mkdirSync(dataDir, { recursive: true });

function secret(name: string, devDefault: string): string {
  const v = process.env[name];
  if (v) return v;
  if (prod) {
    // Never run production with a guessable secret: derive an ephemeral one and say so.
    console.warn(`[config] ${name} is not set — using an ephemeral value (sessions/settings reset on restart).`);
    return randomBytes(32).toString("hex");
  }
  return devDefault;
}

export const config = {
  prod,
  port: Number(process.env.PORT || 8787),
  dataDir,
  /** Passcode for the owner login (phone). */
  accessCode: secret("ACCESS_CODE", "ride"),
  /** Signs session cookies. */
  sessionSecret: secret("SESSION_SECRET", "dev-session-secret"),
  /** 32-byte key (any string, hashed) that encrypts API keys at rest. */
  settingsKey: createHash("sha256").update(secret("SETTINGS_KEY", "dev-settings-key")).digest(),
  /** Shared secret with the Mexty backend: verifies webhooks and mints the preview service session. */
  rideSecret: process.env.RIDE_STUDIO_SECRET || "",
  publicUrl: (process.env.PUBLIC_URL || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : "")).replace(/\/$/, ""),
  phoneDist: findUp("phone/dist"),
  skillPath: findUp("skill/ride-studio-atomic-writes/SKILL.md"),
  /** Lets a routine add Radio Monkey tracks with `Authorization: Bearer <token>` (optional). */
  radioToken: process.env.RADIO_TOKEN || "",
  /** Set to 0 to skip launching Chromium (previews then fall back to nothing). */
  previews: process.env.PREVIEWS !== "0",
};
