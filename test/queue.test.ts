import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquirePool, queueSnapshot } from "../src/queue.ts";

let state: string;
beforeEach(() => {
  state = mkdtempSync(join(tmpdir(), "ci-local-queue-"));
  process.env.CI_LOCAL_STATE_DIR = state;
});
afterEach(() => {
  delete process.env.CI_LOCAL_STATE_DIR;
  rmSync(state, { recursive: true, force: true });
});

const ask = (label: string, weight: number, queuedAt: number, extra: Partial<Parameters<typeof acquirePool>[0]> = {}) => acquirePool({ pool: "build", label, weight, capacity: 3, queuedAt, ...extra });

// Resolves with the label when the claim is granted, so the order of grants can be read off.
function track(order: string[], label: string, promise: Promise<() => void>): Promise<() => void> {
  return promise.then((release) => {
    order.push(label);
    return release;
  });
}

test("builds that fit side by side start together", async () => {
  const releases = await Promise.all([ask("a", 1, 1), ask("b", 1, 2), ask("c", 1, 3)]);
  expect(queueSnapshot()[0]?.holders.map((c) => c.label).sort()).toEqual(["a", "b", "c"]);
  for (const release of releases) release();
});

test("a build that needs the whole machine is not starved by lighter ones behind it", async () => {
  const order: string[] = [];
  const first = await ask("first", 1, 1);
  const heavy = track(order, "heavy", ask("heavy", 3, 2));
  const light = track(order, "light", ask("light", 1, 3));
  await Bun.sleep(900);
  // Two CPUs sit idle, and the light one would fit, but it is behind the heavy one.
  expect(order).toEqual([]);
  first();
  const releaseHeavy = await heavy;
  await Bun.sleep(900);
  expect(order).toEqual(["heavy"]);
  releaseHeavy();
  (await light)();
  expect(order).toEqual(["heavy", "light"]);
});

test("a push that began earlier is served first even when its claim arrives later", async () => {
  const order: string[] = [];
  const holder = await ask("holder", 3, 1);
  const late = track(order, "began-later", ask("began-later", 3, 50));
  await Bun.sleep(100);
  const early = track(order, "began-first", ask("began-first", 3, 10));
  await Bun.sleep(500);
  holder();
  const releaseEarly = await early;
  releaseEarly();
  (await late)();
  expect(order).toEqual(["began-first", "began-later"]);
});

test("a claim that is given up leaves the line", async () => {
  const holder = await ask("holder", 3, 1);
  const abort = new AbortController();
  const gone = ask("gone", 1, 2, { signal: abort.signal });
  const next = ask("next", 1, 3);
  await Bun.sleep(500);
  abort.abort();
  await expect(gone).rejects.toThrow(/gave up waiting for build/);
  holder();
  (await next)();
  expect(queueSnapshot()[0]?.waiting).toEqual([]);
});

test("claims of a process that no longer exists are dropped", async () => {
  const dead = 2 ** 22 - 3;
  const dir = join(state, "queue", "build", "holding");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${String(1).padStart(12, "0")}.json`), JSON.stringify({ pid: dead, seq: 1, label: "ghost", weight: 3, queuedAt: 1 }));
  (await ask("alive", 3, 2))();
});

test("the waiter is told its place and who holds the machine", async () => {
  const holder = await ask("holder", 3, 1);
  const seen: string[] = [];
  const waiter = ask("waiter", 1, 2, { onWait: (s) => seen.push(`${s.position} ${s.used}/${s.capacity} ${s.holders.join()}`) });
  await Bun.sleep(600);
  holder();
  (await waiter)();
  expect(seen).toEqual(["1 3/3 holder"]);
});

test("a weight above the capacity is cut to the capacity instead of waiting forever", async () => {
  (await ask("huge", 99, 1))();
});

test("separate processes never hold more than the capacity together", async () => {
  const log = join(state, "held.log");
  const script = `
    import { appendFileSync } from "node:fs";
    import { acquirePool } from ${JSON.stringify(join(import.meta.dir, "../src/queue.ts"))};
    const [label, weight, queuedAt] = process.argv.slice(1);
    const release = await acquirePool({ pool: "build", label, weight: Number(weight), capacity: 3, queuedAt: Number(queuedAt) });
    appendFileSync(${JSON.stringify(log)}, \`+ \${label} \${weight}\\n\`);
    await Bun.sleep(300);
    appendFileSync(${JSON.stringify(log)}, \`- \${label} \${weight}\\n\`);
    release();
  `;
  const jobs = [["a", 3], ["b", 1], ["c", 1], ["d", 3], ["e", 1], ["f", 2], ["g", 3]] as const;
  const gate = await ask("gate", 3, 0);
  const procs = jobs.map(([label, weight], i) => Bun.spawn(["bun", "-e", script, label, String(weight), String(i)], { env: { ...process.env, CI_LOCAL_STATE_DIR: state }, stdout: "ignore", stderr: "inherit" }));
  while ((queueSnapshot()[0]?.waiting.length ?? 0) < jobs.length) await Bun.sleep(50);
  gate();
  await Promise.all(procs.map((p) => p.exited));
  const lines = (await Bun.file(log).text()).trim().split("\n");
  expect(lines).toHaveLength(jobs.length * 2);
  let used = 0;
  const started: string[] = [];
  for (const line of lines) {
    const [sign, label, weight] = line.split(" ") as [string, string, string];
    used += sign === "+" ? Number(weight) : -Number(weight);
    expect(used).toBeLessThanOrEqual(3);
    if (sign === "+") started.push(label);
  }
  // With all of them waiting, they are served in the order their pushes began: a light job never jumps a heavy one before it.
  expect(started).toEqual(["a", "b", "c", "d", "e", "f", "g"]);
}, 30_000);
