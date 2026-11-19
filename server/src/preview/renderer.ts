import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Browser, BrowserContext, CDPSession, Page } from "playwright";
import { config } from "../config.js";

const MOCK_HTML = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "mock-viewer.html"), "utf8");

const SIZES = [
  { w: 960, h: 600, q: 70 },
  { w: 640, h: 400, q: 55 },
];
const MIN_INTERVAL_MS = 100; // 10 fps cap per tile

interface Tile {
  slot: number;
  context: BrowserContext;
  page: Page;
  cdp: CDPSession;
  mode: "mexty" | "mock";
  last: Buffer | null; // newest frame not yet sent
  lastSent: Buffer | null;
  timer: NodeJS.Timeout;
  sentAt: number;
  level: number;
  skipped: number;
  cleanSince: number;
}

export interface OpenOpts {
  url?: string;
  cookies?: { name: string; value: string; domain: string; path: string; secure: boolean; httpOnly: boolean }[];
}

/**
 * One headless Chromium page per active target. CDP screencast only produces a frame when the page
 * changes; frames are JPEG-encoded at tile size and pushed to the phone, which draws them into the
 * recorded canvas.
 */
export class PreviewRenderer {
  private browser: Promise<Browser> | null = null;
  private tiles = new Map<number, Tile>();

  constructor(private send: (slot: number, jpeg: Buffer) => void, private backlogBytes: () => number) {}

  private launch(): Promise<Browser> {
    this.browser ??= import("playwright").then(({ chromium }) =>
      chromium.launch({
        args: ["--no-sandbox", "--disable-dev-shm-usage", "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--autoplay-policy=no-user-gesture-required"],
      }),
    );
    this.browser.catch(() => (this.browser = null));
    return this.browser;
  }

  /** Open (or replace) the page behind a tile. Without a url the built-in mock viewer is used. */
  async open(slot: number, opts: OpenOpts): Promise<"mexty" | "mock"> {
    if (!config.previews) return "mock";
    await this.close(slot);
    const browser = await this.launch();
    const context = await browser.newContext({ viewport: { width: SIZES[0].w, height: SIZES[0].h }, deviceScaleFactor: 1, locale: "fr-FR", colorScheme: "light" });
    // The page is being filmed: Mexty's first-visit tour and first-run card must not sit over the content.
    await context.addInitScript(() => {
      const get = Storage.prototype.getItem;
      Storage.prototype.getItem = function (key: string) {
        return key === "edv-editor-tour-v1" || key.startsWith("edv-editor-firstrun-closed:") ? "1" : get.call(this, key);
      };
    });
    const page = await context.newPage();
    let mode: "mexty" | "mock" = "mock";
    if (opts.url) {
      try {
        if (opts.cookies?.length) await context.addCookies(opts.cookies);
        const res = await page.goto(opts.url, { waitUntil: "domcontentloaded", timeout: 15_000 });
        // A redirect to the login page means the service session was not accepted.
        if (res && res.ok() && !/\/(login|auth|signin)/i.test(new URL(page.url()).pathname)) mode = "mexty";
      } catch (e) {
        console.warn(`[preview] ${opts.url} failed: ${(e as Error).message}`);
      }
    }
    if (mode === "mock") await page.setContent(MOCK_HTML, { waitUntil: "load" });
    const cdp = await context.newCDPSession(page);
    const tile: Tile = { slot, context, page, cdp, mode, last: null, lastSent: null, sentAt: 0, level: 0, skipped: 0, cleanSince: Date.now(), timer: setInterval(() => this.tick(tile), MIN_INTERVAL_MS / 2) };
    cdp.on("Page.screencastFrame", (f) => {
      void cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {});
      tile.last = Buffer.from(f.data, "base64");
    });
    await this.startCast(tile);
    this.tiles.set(slot, tile);
    return mode;
  }

  private async startCast(t: Tile) {
    const s = SIZES[t.level];
    await t.cdp.send("Page.stopScreencast").catch(() => {});
    await t.cdp.send("Page.startScreencast", { format: "jpeg", quality: s.q, maxWidth: s.w, maxHeight: s.h, everyNthFrame: 1 });
  }

  /** Send the newest frame at most 10×/s; under back-pressure skip, then step quality down, and recover when the link is clean. */
  private tick(t: Tile) {
    if (!t.last) return;
    const now = Date.now();
    if (now - t.sentAt < MIN_INTERVAL_MS) return;
    if (this.backlogBytes() > 400_000) {
      t.cleanSince = now;
      if (++t.skipped > 25 && t.level < SIZES.length - 1) {
        t.level++;
        t.skipped = 0;
        void this.startCast(t).catch(() => {});
      }
      return; // keep t.last: the latest change is never lost, only delayed
    }
    t.skipped = Math.max(0, t.skipped - 1);
    if (t.level > 0 && now - t.cleanSince > 20_000) {
      t.level--;
      t.cleanSince = now;
      void this.startCast(t).catch(() => {});
    }
    t.sentAt = now;
    t.lastSent = t.last;
    t.last = null;
    this.send(t.slot, t.lastSent);
  }

  /** Latest frame of every tile, for a phone that just (re)connected. */
  snapshot(): [number, Buffer][] {
    return [...this.tiles.values()].filter((t) => t.lastSent || t.last).map((t) => [t.slot, (t.last ?? t.lastSent)!]);
  }

  /** Push the tool-call-derived document into a mock tile. No-op for real Mexty pages. */
  async mock(slot: number, payload: unknown) {
    const t = this.tiles.get(slot);
    if (t?.mode !== "mock") return;
    await t.page.evaluate((p) => (window as unknown as { __rs: { apply(p: unknown): void } }).__rs.apply(p), payload).catch(() => {});
  }

  modeOf(slot: number) {
    return this.tiles.get(slot)?.mode ?? null;
  }

  async close(slot: number) {
    const t = this.tiles.get(slot);
    if (!t) return;
    this.tiles.delete(slot);
    clearInterval(t.timer);
    await t.context.close().catch(() => {});
  }
  async closeAll() {
    await Promise.all([...this.tiles.keys()].map((s) => this.close(s)));
  }
  async shutdown() {
    await this.closeAll();
    await (await this.browser?.catch(() => null))?.close().catch(() => {});
    this.browser = null;
  }
}
