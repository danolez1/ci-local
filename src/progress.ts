import { exec } from "./exec.ts";
import type { PushProgress } from "./types.ts";

export interface PushHooks {
  /** Receives a short line per finished layer and a periodic status line. */
  onLine?: (line: string) => void;
  onProgress?: (progress: PushProgress) => void;
}

export interface PushTracker {
  /** Feed every output line of `crane push -v`. */
  line(text: string): void;
  stop(): void;
  /** The last error crane printed, since the verbose dump would otherwise bury it. */
  error(): string;
}

const HEAD = /--> HEAD \S+\/blobs\/sha256:([0-9a-f]{64})/;
const EXISTS = /<-- 200 \S+\/blobs\/sha256:([0-9a-f]{64})/;
const UPLOADED = /<-- 201 \S+\?digest=sha256%3A([0-9a-f]{64})/;
const WINDOW_SECONDS = 5;
const STATUS_EVERY_SECONDS = 15;

export function formatBytes(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`;
  return `${Math.round(n / 1e3)} KB`;
}

// crane looks blobs up a few at a time, so the total it has seen keeps growing; the tarball knows it upfront.
export async function blobCount(tarball: string): Promise<number | undefined> {
  const r = await exec(["tar", "-xOqf", tarball, "manifest.json"]);
  if (r.code !== 0) return undefined;
  try {
    const images = JSON.parse(r.out) as Array<{ Layers?: string[] }>;
    return images.reduce((n, image) => n + (image.Layers?.length ?? 0) + 1, 0);
  } catch {
    return undefined;
  }
}

export function trackPush(hooks: PushHooks, sent?: () => number, expected = 0): PushTracker {
  const total = new Set<string>();
  const done = new Set<string>();
  const samples: Array<{ at: number; sent: number }> = [];
  let lastError = "";
  let sinceStatus = 0;

  const snapshot = (): PushProgress => {
    const now = Date.now();
    const bytes = sent?.();
    let rate: number | undefined;
    if (bytes !== undefined) {
      samples.push({ at: now, sent: bytes });
      while (samples.length > WINDOW_SECONDS) samples.shift();
      const first = samples[0] as { at: number; sent: number };
      rate = now > first.at ? ((bytes - first.sent) * 1000) / (now - first.at) : 0;
    }
    return { sent: bytes, rate, blobs_done: done.size, blobs_total: Math.max(expected, total.size) };
  };

  const timer = setInterval(() => {
    const p = snapshot();
    hooks.onProgress?.(p);
    sinceStatus++;
    if (sinceStatus >= STATUS_EVERY_SECONDS && p.sent !== undefined) {
      sinceStatus = 0;
      hooks.onLine?.(`push: ${formatBytes(p.sent)} sent, ${formatBytes(p.rate ?? 0)}/s, ${p.blobs_done}/${p.blobs_total} layers done`);
    }
  }, 1000);

  const finishBlob = (digest: string, how: string) => {
    if (done.has(digest)) return;
    done.add(digest);
    hooks.onLine?.(`push: layer ${digest.slice(0, 12)} ${how} (${done.size}/${Math.max(expected, total.size)})`);
    hooks.onProgress?.(snapshot());
  };

  return {
    line(text) {
      const head = HEAD.exec(text);
      if (head) total.add(head[1] as string);
      const exists = EXISTS.exec(text);
      if (exists) finishBlob(exists[1] as string, "already in the registry");
      const uploaded = UPLOADED.exec(text);
      if (uploaded) finishBlob(uploaded[1] as string, "uploaded");
      const failure = text.match(/^Error: .*/);
      if (failure) lastError = failure[0];
    },
    stop() {
      clearInterval(timer);
      hooks.onProgress?.(snapshot());
    },
    error: () => lastError,
  };
}
