/** MediaRecorder → IndexedDB every few seconds, so a crash or a dead battery loses seconds, not the ride. */
const DB = "ride-studio";
const STORE = "chunks";

function db(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => {
      const s = r.result.createObjectStore(STORE, { autoIncrement: true });
      s.createIndex("rec", "rec");
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function put(row: { rec: string; seq: number; blob: Blob; mime: string; at: number }) {
  const d = await db();
  await new Promise<void>((res, rej) => {
    const tx = d.transaction(STORE, "readwrite");
    tx.objectStore(STORE).add(row);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
  d.close();
}

export type Variant = "tall" | "wide";
export const recId = (episodeId: string, v: Variant) => `${episodeId}:${v}`;

export function pickMime(): string {
  // MP4 goes straight to the gallery and to social apps; WebM is the fallback.
  const options = ["video/mp4;codecs=avc1.42E01E,mp4a.40.2", "video/mp4", "video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"];
  return options.find((m) => typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(m)) ?? "";
}

/** Recordings still being written: the uploader leaves them alone. */
export const openRecordings = new Set<string>();

export class Recording {
  private rec: MediaRecorder;
  private seq = 0;
  private pending: Promise<void>[] = [];
  readonly mime: string;

  constructor(readonly id: string, canvas: HTMLCanvasElement, audioStream: MediaStream | null, bitsPerSecond: number) {
    const stream = new MediaStream([...canvas.captureStream(30).getVideoTracks(), ...(audioStream?.getAudioTracks().map((t) => t.clone()) ?? [])]);
    this.mime = pickMime();
    this.rec = new MediaRecorder(stream, { mimeType: this.mime || undefined, videoBitsPerSecond: bitsPerSecond, audioBitsPerSecond: 128_000 });
    this.rec.ondataavailable = (e) => {
      if (e.data.size) this.pending.push(put({ rec: id, seq: this.seq++, blob: e.data, mime: this.rec.mimeType, at: Date.now() }).catch(() => {}));
    };
  }
  start() {
    openRecordings.add(this.id);
    this.rec.start(3000);
  }
  async stop() {
    if (this.rec.state !== "inactive") {
      await new Promise<void>((res) => {
        this.rec.onstop = () => res();
        this.rec.stop();
      });
    }
    await Promise.all(this.pending);
    this.rec.stream.getTracks().forEach((t) => t.stop());
    openRecordings.delete(this.id);
  }
}

export async function exportRecording(id: string): Promise<{ blob: Blob; ext: string } | null> {
  const d = await db();
  const rows = await new Promise<{ seq: number; blob: Blob; mime: string }[]>((res, rej) => {
    const q = d.transaction(STORE).objectStore(STORE).index("rec").getAll(id);
    q.onsuccess = () => res(q.result);
    q.onerror = () => rej(q.error);
  });
  d.close();
  if (!rows.length) return null;
  rows.sort((a, b) => a.seq - b.seq);
  const mime = rows[0].mime || "video/webm";
  return { blob: new Blob(rows.map((r) => r.blob), { type: mime.split(";")[0] }), ext: mime.includes("mp4") ? "mp4" : "webm" };
}

/** Keep the two most recent episodes; older chunks are deleted to free the phone's storage. */
export async function pruneRecordings(keepEpisodeIds: string[]) {
  const d = await db();
  await new Promise<void>((res) => {
    const tx = d.transaction(STORE, "readwrite");
    const cur = tx.objectStore(STORE).openCursor();
    cur.onsuccess = () => {
      const c = cur.result;
      if (!c) return;
      if (!keepEpisodeIds.some((id) => String((c.value as { rec: string }).rec).startsWith(id))) c.delete();
      c.continue();
    };
    tx.oncomplete = () => res();
    tx.onerror = () => res();
  });
  d.close();
}

/** All recorded files of an episode for one format (a reload mid-ride produces several parts). */
export async function listRecordings(episodeId: string, v: Variant): Promise<string[]> {
  const d = await db();
  const keys = await new Promise<string[]>((res) => {
    const out = new Set<string>();
    const cur = d.transaction(STORE).objectStore(STORE).index("rec").openKeyCursor(null, "nextunique");
    cur.onsuccess = () => {
      const c = cur.result;
      if (!c) return res([...out]);
      out.add(String(c.key));
      c.continue();
    };
    cur.onerror = () => res([]);
  });
  d.close();
  return keys.filter((k) => k.startsWith(recId(episodeId, v))).sort();
}

/** Every recording id still held on this phone. */
export async function allRecordingIds(): Promise<string[]> {
  const d = await db();
  const keys = await new Promise<string[]>((res) => {
    const out: string[] = [];
    const cur = d.transaction(STORE).objectStore(STORE).index("rec").openKeyCursor(null, "nextunique");
    cur.onsuccess = () => {
      const c = cur.result;
      if (!c) return res(out);
      out.push(String(c.key));
      c.continue();
    };
    cur.onerror = () => res(out);
  });
  d.close();
  return keys;
}

/** The chunks of one recording, in order (blobs stay on disk until read). */
export async function chunksOf(id: string): Promise<{ seq: number; blob: Blob; mime: string }[]> {
  const d = await db();
  const rows = await new Promise<{ seq: number; blob: Blob; mime: string }[]>((res, rej) => {
    const q = d.transaction(STORE).objectStore(STORE).index("rec").getAll(id);
    q.onsuccess = () => res(q.result);
    q.onerror = () => rej(q.error);
  });
  d.close();
  return rows.sort((a, b) => a.seq - b.seq);
}
