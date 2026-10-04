import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { must } from "../src/exec.ts";
import { countingProxy } from "../src/proxy.ts";
import { blobCount, trackPush } from "../src/progress.ts";

const A = "a".repeat(64);
const B = "b".repeat(64);
const C = "c".repeat(64);
const base = "http://127.0.0.1:5156/v2/acme/web/blobs";
const stamp = "2026/10/05 06:21:38 ";

test("layers are counted from crane's verbose lines: skipped ones and uploaded ones", () => {
  const lines: string[] = [];
  const progress: Array<{ blobs_done: number; blobs_total: number }> = [];
  const tracker = trackPush({ onLine: (l) => lines.push(l), onProgress: (p) => progress.push(p) }, undefined, 3);
  for (const d of [A, B, C]) tracker.line(`${stamp}--> HEAD ${base}/sha256:${d}`);
  tracker.line(`${stamp}<-- 200 ${base}/sha256:${A} (2ms)`);
  tracker.line(`${stamp}<-- 404 ${base}/sha256:${B} (2ms)`);
  tracker.line(`${stamp}<-- 201 ${base}/uploads/123?digest=sha256%3A${B} (9ms)`);
  tracker.line(`${stamp}<-- 201 ${base}/uploads/123?digest=sha256%3A${B} (9ms)`);
  tracker.stop();
  expect(progress.at(-1)).toMatchObject({ blobs_done: 2, blobs_total: 3 });
  expect(lines).toEqual([`push: layer ${A.slice(0, 12)} already in the registry (1/3)`, `push: layer ${B.slice(0, 12)} uploaded (2/3)`]);
});

test("the last error line survives the verbose dump", () => {
  const tracker = trackPush({});
  tracker.line(`${stamp}retrying Head "x": boom`);
  tracker.line("Error: Patch \"http://127.0.0.1:5156\": use of closed network connection");
  tracker.line("Host: 127.0.0.1:5156");
  tracker.stop();
  expect(tracker.error()).toBe('Error: Patch "http://127.0.0.1:5156": use of closed network connection');
});

test("the counting proxy relays traffic and counts what the client uploads", async () => {
  const upstream = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) { return new Response(`got ${(await req.arrayBuffer()).byteLength}`); } });
  const proxy = await countingProxy(() => upstream.port as number);
  try {
    const body = "x".repeat(100_000);
    const res = await fetch(`http://127.0.0.1:${proxy.port}/`, { method: "POST", body });
    expect(await res.text()).toBe("got 100000");
    expect(proxy.sent()).toBeGreaterThanOrEqual(100_000);
    expect(proxy.sent()).toBeLessThan(101_000);
  } finally {
    await proxy.close();
    upstream.stop(true);
  }
});

test("the proxy follows the upstream port when the tunnel is reopened", async () => {
  const one = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("one") });
  const two = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("two") });
  let target = one.port as number;
  const proxy = await countingProxy(() => target);
  try {
    const get = async () => (await fetch(`http://127.0.0.1:${proxy.port}/`, { headers: { connection: "close" } })).text();
    expect(await get()).toBe("one");
    target = two.port as number;
    expect(await get()).toBe("two");
  } finally {
    await proxy.close();
    one.stop(true);
    two.stop(true);
  }
});

test("the expected blob count is every layer plus the config, read from the tarball", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ci-local-blobs-"));
  try {
    writeFileSync(join(dir, "manifest.json"), JSON.stringify([{ Config: "c.json", Layers: ["l1", "l2", "l3"] }]));
    await must(["tar", "-cf", join(dir, "image.tar"), "-C", dir, "manifest.json"]);
    expect(await blobCount(join(dir, "image.tar"))).toBe(4);
    expect(await blobCount(join(dir, "missing.tar"))).toBeUndefined();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
