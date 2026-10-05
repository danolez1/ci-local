import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchAgentPlist } from "../src/daemon.ts";
import { exec, must } from "../src/exec.ts";
import { queryRuns, readLog, readRun, RunHandle, runStats } from "../src/store.ts";
import { startUi } from "../src/ui/server.ts";

const cli = join(import.meta.dir, "..", "bin", "ci-local.mjs");
let base = "";
let server: ReturnType<typeof startUi>;
let host = "";
let firstId = "";

function seed(repo: string, status: "success" | "failed" | "skipped", n: number): void {
  for (let i = 0; i < n; i++) {
    const run = RunHandle.create({ repo_path: `/work/${repo}`, image: `${repo}/web`, sha: "a".repeat(40), profile: "p", echo: false, ref: "main", trigger: "hook" });
    run.finish(status, status === "failed" ? "boom" : undefined);
    if (!firstId) firstId = run.record.id;
  }
}

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), "ci-local-ui-"));
  process.env.CI_LOCAL_STATE_DIR = join(base, "state");
  seed("alpha", "success", 5);
  seed("alpha", "failed", 2);
  seed("beta", "success", 4);
  seed("beta", "skipped", 1);
  server = startUi(0);
  host = `127.0.0.1:${server.port}`;
});

afterAll(() => {
  server.stop(true);
  delete process.env.CI_LOCAL_STATE_DIR;
  rmSync(base, { recursive: true, force: true });
});

const get = (path: string, headers: Record<string, string> = {}) => fetch(`http://${host}${path}`, { headers: { host, ...headers } });

test("runs are paged, newest first, with status counts and a repo list", () => {
  const page = queryRuns({ page: 2, perPage: 5 });
  expect(page.total).toBe(12);
  expect(page.pages).toBe(3);
  expect(page.items).toHaveLength(5);
  expect(page.counts).toEqual({ success: 9, failed: 2, skipped: 1 });
  expect(page.repos).toEqual([
    { name: "alpha", count: 7, images: [{ name: "alpha/web", count: 7 }] },
    { name: "beta", count: 5, images: [{ name: "beta/web", count: 5 }] },
  ]);
  expect(queryRuns({ page: 99, perPage: 5 }).page).toBe(3);
});

test("filters by status, repo and search text", () => {
  expect(queryRuns({ status: "failed" }).total).toBe(2);
  expect(queryRuns({ repo: "beta" }).total).toBe(5);
  expect(queryRuns({ repo: "beta", status: "success" }).total).toBe(4);
  expect(queryRuns({ q: "alpha/web" }).total).toBe(7);
  expect(queryRuns({ image: "beta/web" }).total).toBe(5);
  expect(queryRuns({ repo: "alpha", image: "beta/web" }).total).toBe(0);
  expect(queryRuns({ q: "nothing-matches" }).total).toBe(0);
  expect(queryRuns({ repo: "beta" }).counts.failed).toBeUndefined();
});

test("stats count outcomes and rate only finished runs", () => {
  const s = runStats();
  expect(s.total).toBe(12);
  expect(s.failed).toBe(2);
  expect(s.successRate).toBeCloseTo(9 / 11);
  expect(s.perRepo.map((r) => r.image).sort()).toEqual(["alpha/web", "beta/web"]);
});

test("a run whose process died is shown as interrupted, not running forever", () => {
  const run = RunHandle.create({ repo_path: "/work/ghost", image: "ghost/web", sha: "b".repeat(40), profile: "p", echo: false });
  const file = join(process.env.CI_LOCAL_STATE_DIR as string, "runs", run.record.id, "run.json");
  writeFileSync(file, JSON.stringify({ ...run.record, pid: 2_147_483_000 }));
  expect(readRun(run.record.id)?.status).toBe("interrupted");
  expect(queryRuns({ repo: "ghost" }).counts).toEqual({ interrupted: 1 });
});

test("phases are written to the log as groups the page can fold", async () => {
  const run = RunHandle.create({ repo_path: "/work/groups", image: "groups/web", sha: "c".repeat(40), profile: "p", echo: false });
  await run.phase("hash", async () => run.say("hello"));
  const text = readLog(run.record.id).text;
  expect(text).toContain("##[group]hash");
  expect(text).toContain("ci-local: hello");
  expect(text).toContain("##[endgroup]");
});

test("log reads are chunked on line boundaries", () => {
  const run = RunHandle.create({ repo_path: "/work/chunk", image: "chunk/web", sha: "d".repeat(40), profile: "p", echo: false });
  for (let i = 0; i < 50; i++) run.log(`line ${i} ${"x".repeat(40)}`);
  let offset = 0;
  const seen: string[] = [];
  for (let i = 0; i < 100; i++) {
    const r = readLog(run.record.id, offset, 200);
    if (!r.text) break;
    expect(r.text.endsWith("\n")).toBe(true);
    seen.push(...r.text.split("\n").filter(Boolean));
    offset = r.next;
  }
  expect(seen).toHaveLength(50);
});

test("the api pages, answers 304 for an unchanged list and refuses other hosts", async () => {
  const res = await get("/api/runs?per_page=3&page=2");
  const body = (await res.json()) as { items: unknown[]; page: number };
  expect(body.items).toHaveLength(3);
  expect(body.page).toBe(2);
  const tag = res.headers.get("etag") as string;
  expect((await get("/api/runs?per_page=3&page=2", { "if-none-match": tag })).status).toBe(304);
  expect((await fetch(`http://${host}/api/runs`, { headers: { host: "evil.test" } })).status).toBe(403);
  expect((await get("/api/runs/..%2F..%2Fetc")).status).toBe(404);
  expect((await get(`/api/runs/${firstId}`)).status).toBe(200);
  expect((await get("/")).headers.get("content-type")).toContain("text/html");
});

test("the login agent plist runs the web view and keeps it alive", () => {
  const xml = launchAgentPlist({ bun: "/opt/bun", cli: "/x/cli.ts", port: 7777, log: "/tmp/ui.log" });
  expect(xml).toContain("<string>dev.ci-local.ui</string>");
  expect(xml).toContain("<string>serve</string>");
  expect(xml).toContain("<key>KeepAlive</key>");
  expect(xml).toContain("<string>/tmp/ui.log</string>");
});

test("ui start runs detached, reports status, and stop ends it", async () => {
  const env = { CI_LOCAL_STATE_DIR: join(base, "daemon-state") };
  mkdirSync(env.CI_LOCAL_STATE_DIR, { recursive: true });
  const run = (...args: string[]) => exec([cli, "ui", ...args], { env });
  try {
    const started = await run("start", "--port", "0");
    expect(started.code).toBe(0);
    expect(started.out).toContain("web view running on http://127.0.0.1:");
    const status = await run("status");
    expect(status.code).toBe(0);
    const port = status.out.match(/127\.0\.0\.1:(\d+)/)?.[1];
    expect((await fetch(`http://127.0.0.1:${port}/api/info`)).ok).toBe(true);
    expect((await run("start", "--port", "0")).out).toContain(`127.0.0.1:${port}`);
  } finally {
    expect((await run("stop")).out).toContain("stopped");
  }
  expect((await run("status")).code).toBe(1);
}, 60000);

test("a repo name with a space or quote still produces an id the store can open", () => {
  const run = RunHandle.create({ repo_path: '/work/my "repo"', image: "my repo/web app", sha: "e".repeat(40), profile: "p", echo: false });
  expect(run.record.id).toMatch(/^[\w.-]+$/);
  expect(readRun(run.record.id)?.repo).toBe('my "repo"');
});

test("a long log is read in chunks that add up to the whole file, and limits are bounded", () => {
  const run = RunHandle.create({ repo_path: "/work/big", image: "big/web", sha: "f".repeat(40), profile: "p", echo: false });
  for (let i = 0; i < 40; i++) run.log(`row ${i} ${"y".repeat(100)}`);
  let offset = 0;
  let text = "";
  for (let i = 0; i < 200; i++) {
    const r = readLog(run.record.id, offset, 700);
    text += r.text;
    offset = r.next;
    if (offset >= r.size) break;
  }
  expect(text.split("\n").filter(Boolean)).toHaveLength(40);
  expect(readLog(run.record.id, 0, -5).text).toBe("");
  expect(readLog(run.record.id, 0, 10 ** 12).text.length).toBeGreaterThan(0);
});

test("the server sends security headers, serves the raw log as text and survives a malformed host", async () => {
  const res = await get("/api/runs?per_page=1");
  expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  const raw = await get(`/api/runs/${firstId}/raw`);
  expect(raw.status === 200 || raw.status === 404).toBe(true);
  const withLog = RunHandle.create({ repo_path: "/work/rawlog", image: "rawlog/web", sha: "1".repeat(40), profile: "p", echo: false });
  withLog.log("plain text line");
  const text = await get(`/api/runs/${withLog.record.id}/raw`);
  expect(text.headers.get("content-type")).toContain("text/plain");
  expect(await text.text()).toContain("plain text line");
  const bad = await fetch(`http://${host}/`, { headers: { host: "127.0.0.1:99999999" } });
  expect([400, 403]).toContain(bad.status);
});

test("the login agent plist escapes ampersands in every path", () => {
  const xml = launchAgentPlist({ bun: "/opt/bun", cli: "/a & b/cli.ts", port: 7777, log: "/Users/Tom & Jerry/ui.log", stateDir: "/s & t" });
  expect(xml).not.toMatch(/&(?!amp;|lt;|gt;)/);
  expect(xml).toContain("/Users/Tom &amp; Jerry/ui.log");
  expect(xml).toContain("<key>CI_LOCAL_STATE_DIR</key>");
});

test("run --background reports why the child failed instead of claiming it started", async () => {
  const dir = mkdtempSync(join(base, "bg-"));
  await must(["git", "-C", dir, "init", "-q", "-b", "main"]);
  const r = await exec([cli, "run", "--background"], { cwd: dir, env: { CI_LOCAL_STATE_DIR: join(base, "bg-state"), CI_LOCAL_CONFIG_DIR: join(base, "bg-cfg") } });
  expect(r.code).toBe(1);
  expect(r.err).toContain("no ci-local.yaml");
}, 60000);

test("the page serves its bundled font from its own origin", async () => {
  const font = await get("/fonts/Urbanist.ttf");
  expect(font.status).toBe(200);
  expect(font.headers.get("content-type")).toBe("font/ttf");
  expect((await font.arrayBuffer()).byteLength).toBeGreaterThan(50_000);
  expect((await fetch(`http://${host}/fonts/Urbanist.ttf`, { headers: { host: "evil.test" } })).status).toBe(403);
});

const change = (method: string, path: string, headers: Record<string, string> = {}) => fetch(`http://${host}${path}`, { method, headers: { host, "x-ci-local": "1", ...headers } });

test("changes need the same origin and the marker header", async () => {
  const run = RunHandle.create({ repo_path: "/work/gamma", image: "gamma/web", sha: "c".repeat(40), profile: "p", echo: false });
  run.finish("failed", "boom");
  const bare = await fetch(`http://${host}/api/runs/${run.record.id}`, { method: "DELETE", headers: { host } });
  expect(bare.status).toBe(403);
  expect((await change("DELETE", `/api/runs/${run.record.id}`, { origin: "http://evil.test" })).status).toBe(403);
  expect(readRun(run.record.id)).not.toBeNull();
});

test("a finished run can be deleted from the page, and the list forgets it", async () => {
  const run = RunHandle.create({ repo_path: "/work/gamma", image: "gamma/web", sha: "c".repeat(40), profile: "p", echo: false });
  run.finish("success");
  const before = queryRuns({ repo: "gamma" }).total;
  const res = await change("DELETE", `/api/runs/${run.record.id}`, { origin: `http://${host}` });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ result: "done" });
  expect(readRun(run.record.id)).toBeNull();
  expect(queryRuns({ repo: "gamma" }).total).toBe(before - 1);
  expect((await change("DELETE", `/api/runs/${run.record.id}`)).status).toBe(404);
});

test("a run that is still going cannot be deleted, and a finished one cannot be stopped", async () => {
  const running = RunHandle.create({ repo_path: "/work/delta", image: "delta/web", sha: "d".repeat(40), profile: "p", echo: false });
  expect((await change("DELETE", `/api/runs/${running.record.id}`)).status).toBe(409);
  expect(readRun(running.record.id)).not.toBeNull();
  running.finish("failed");
  expect((await change("POST", `/api/runs/${running.record.id}/stop`)).status).toBe(409);
  expect((await get(`/api/runs/${running.record.id}/stop`)).status).toBe(405);
});

test("stopping signals only a process that is plainly ci-local", async () => {
  const foreign = Bun.spawn(["sleep", "30"]);
  const ours = Bun.spawn(["sh", "-c", "sleep 5; true", "cli.ts"]);
  try {
    for (const [child, expected] of [[foreign, 409], [ours, 200]] as const) {
      const run = RunHandle.create({ repo_path: "/work/eps", image: "eps/web", sha: "e".repeat(40), profile: "p", echo: false });
      run.record.pid = child.pid;
      run.set({});
      expect((await change("POST", `/api/runs/${run.record.id}/stop`)).status).toBe(expected);
    }
    expect(await ours.exited).not.toBe(0);
    expect(foreign.killed).toBe(false);
  } finally {
    foreign.kill();
    ours.kill();
  }
});
