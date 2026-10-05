import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exec, has, must } from "../src/exec.ts";
import { makeOciLayout } from "./oci-fixture.ts";

const cli = join(import.meta.dir, "..", "bin", "ci-local.mjs");
let base = "";
let repo = "";
let remote = "";
let calls = "";
let env: Record<string, string> = {};

const gitc = (...args: string[]) => must(["git", "-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", ...args]);

function stub(dir: string, name: string, body: string): void {
  const file = join(dir, name);
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o755);
}

beforeAll(async () => {
  base = mkdtempSync(join(tmpdir(), "ci-local-push-"));
  const bin = join(base, "bin");
  mkdirSync(bin);
  calls = join(base, "calls.log");
  // Stand-ins record what ci-local asks of docker and crane, so a real git push can run without either installed.
  stub(bin, "docker", `echo "docker $*" >> "${calls}"
case "$1" in
  info) exit 0 ;;
  buildx)
    [ -f "${base}/fail-build" ] && exit 1
    case "$*" in *type=oci*) cp -R "${base}/fixture-oci" "$(printf '%s' "$*" | sed -n 's/.*dest=\\([^, ]*\\).*/\\1/p')" ;; esac
    exit 0 ;;
  save) while [ $# -gt 0 ]; do [ "$1" = "-o" ] && : > "$2"; shift; done; exit 0 ;;
  *) exit 0 ;;
esac`);
  stub(bin, "crane", `echo "crane $*" >> "${calls}"
case "$1" in
  manifest) [ -f "${base}/exists" ] && exit 0; exit 1 ;;
  push)
    [ -f "${base}/fail-push-always" ] && { echo "Error: connection reset" >&2; exit 1; }
    [ -f "${base}/fail-push-once" ] && { rm "${base}/fail-push-once"; echo "Error: use of closed network connection" >&2; exit 1; }
    exit 0 ;;
  *) exit 0 ;;
esac`);
  makeOciLayout(join(base, "fixture-oci"), ["layer one ".repeat(2000), "layer two ".repeat(2000)]);
  const cfg = join(base, "cfg");
  mkdirSync(cfg);
  writeFileSync(join(cfg, "config.yaml"), "default_profile: t\nprofiles:\n  t: { transport: direct, registry: 'reg.test:5000', pull_registry: '127.0.0.1:5000' }\n");
  env = {
    CI_LOCAL_CONFIG_DIR: cfg,
    CI_LOCAL_STATE_DIR: join(base, "state"),
    PATH: `${bin}:${join(base, "launch")}:${process.env.PATH ?? ""}`,
  };
  mkdirSync(join(base, "launch"));
  await must(["ln", "-s", cli, join(base, "launch", "ci-local")]);

  remote = join(base, "remote.git");
  repo = join(base, "app");
  await must(["git", "init", "-q", "--bare", "-b", "main", remote]);
  mkdirSync(repo);
  await must(["git", "-C", repo, "init", "-q", "-b", "main"]);
  writeFileSync(join(repo, "Dockerfile"), "FROM scratch\n");
  writeFileSync(join(repo, "ci-local.yaml"), "version: 1\nbranches: [main]\nimages:\n  - image: acme/web\n");
  await gitc("add", "-A");
  await gitc("commit", "-qm", "init");
  await gitc("remote", "add", "origin", remote);
  await must(["git", "-C", repo, "config", "core.hooksPath", ".githooks"]);
  await exec(["ci-local", "install-hook"], { cwd: repo, env });
});

afterAll(() => rmSync(base, { recursive: true, force: true }));

const push = (...extra: string[]) => exec(["git", "-C", repo, "push", "origin", "main", ...extra], { env });
const log = () => readFileSync(calls, "utf8");

test("a push builds, publishes the immutable tag and moves :prod before it reaches the remote", async () => {
  const r = await push();
  expect(r.code).toBe(0);
  expect(log()).toMatch(/docker buildx build .*--platform linux\/amd64/);
  expect(log()).toMatch(/crane push reg\.test:5000\/acme\/web:sha-[0-9a-f]{12}|crane push .*image\.tar reg\.test:5000\/acme\/web:sha-[0-9a-f]{12}/);
  expect(log()).toMatch(/crane tag reg\.test:5000\/acme\/web:sha-[0-9a-f]{12} prod/);
  expect((await must(["git", "-C", remote, "rev-parse", "main"])).trim()).toBe((await must(["git", "-C", repo, "rev-parse", "HEAD"])).trim());
});

test("an unchanged image already in the registry skips the build", async () => {
  writeFileSync(join(repo, "README.md"), "docs only\n");
  await gitc("add", "-A");
  await gitc("commit", "-qm", "readme");
  writeFileSync(join(base, "exists"), "");
  writeFileSync(calls, "");
  const r = await push();
  expect(r.code).toBe(0);
  expect(log()).not.toContain("buildx build");
  rmSync(join(base, "exists"));
});

test("a failed build stops the push", async () => {
  writeFileSync(join(repo, "app.txt"), "change\n");
  await gitc("add", "-A");
  await gitc("commit", "-qm", "code");
  writeFileSync(join(base, "fail-build"), "");
  const before = (await must(["git", "-C", remote, "rev-parse", "main"])).trim();
  const r = await push();
  expect(r.code).not.toBe(0);
  expect((await must(["git", "-C", remote, "rev-parse", "main"])).trim()).toBe(before);
  rmSync(join(base, "fail-build"));
});

test("CI_LOCAL_SKIP_IMAGE=1 lets one push through without building", async () => {
  writeFileSync(calls, "");
  const r = await exec(["git", "-C", repo, "push", "origin", "main"], { env: { ...env, CI_LOCAL_SKIP_IMAGE: "1" } });
  expect(r.code).toBe(0);
  expect(log()).not.toContain("buildx build");
});

test("pushing another branch does not build", async () => {
  await gitc("branch", "side");
  writeFileSync(calls, "");
  const r = await exec(["git", "-C", repo, "push", "origin", "side"], { env });
  expect(r.code).toBe(0);
  expect(log()).toBe("");
});

test("a dropped upload is retried and the push still goes through", async () => {
  writeFileSync(join(repo, "retry.txt"), "change\n");
  await gitc("add", "-A");
  await gitc("commit", "-qm", "retry");
  writeFileSync(join(base, "fail-push-once"), "");
  writeFileSync(calls, "");
  const r = await push();
  expect(r.code).toBe(0);
  expect(log().match(/^crane push /gm)?.length).toBe(2);
});

test("an upload that keeps failing stops the push after three attempts and says so", async () => {
  writeFileSync(join(repo, "stuck.txt"), "change\n");
  await gitc("add", "-A");
  await gitc("commit", "-qm", "stuck");
  writeFileSync(join(base, "fail-push-always"), "");
  writeFileSync(calls, "");
  const before = (await must(["git", "-C", remote, "rev-parse", "main"])).trim();
  const r = await push();
  rmSync(join(base, "fail-push-always"));
  expect(r.code).not.toBe(0);
  expect(r.err).toContain("Error: connection reset");
  expect(r.err).toContain("after 3 attempts");
  expect(log().match(/^crane push /gm)?.length).toBe(3);
  expect((await must(["git", "-C", remote, "rev-parse", "main"])).trim()).toBe(before);
});

const zstdTest = has("zstd") ? test : test.skip;

zstdTest("an image set to zstd is exported as an OCI layout, recompressed, and pushed as a directory", async () => {
  writeFileSync(join(repo, "ci-local.yaml"), "version: 1\nbranches: [main]\nimages:\n  - image: acme/web\n    compression: zstd\n    zstd_level: 3\n");
  writeFileSync(join(repo, "zstd.txt"), "change\n");
  await gitc("add", "-A");
  await gitc("commit", "-qm", "zstd");
  writeFileSync(calls, "");
  const r = await push();
  expect(r.code).toBe(0);
  expect(log()).toMatch(/docker buildx build .*--output type=oci,tar=false,dest=\S+image-oci,compression=uncompressed/);
  expect(log()).not.toContain("docker save");
  expect(log()).toMatch(/crane push -v .*image-oci reg\.test:5000\/acme\/web:sha-[0-9a-f]{12}/);
});

const checkYaml = (name: string, run: string) => `version: 1\nbranches: [main]\nimages:\n  - image: acme/web\nchecks:\n  - name: ${name}\n    run: ${run}\n`;
const checkRuns = (): number => {
  try {
    return readFileSync(join(base, "checks.log"), "utf8").trim().split("\n").filter(Boolean).length;
  } catch {
    return 0;
  }
};

test("a check runs before the build, and the same tree is not checked twice", async () => {
  env.CHECK_LOG = join(base, "checks.log");
  writeFileSync(join(repo, "ci-local.yaml"), checkYaml("gate", "echo ran >> \"$CHECK_LOG\""));
  writeFileSync(join(repo, "gate.txt"), "one\n");
  await gitc("add", "-A");
  await gitc("commit", "-qm", "gate");
  writeFileSync(calls, "");
  expect((await push()).code).toBe(0);
  expect(checkRuns()).toBe(1);
  // The same content under a new commit keeps its tree, so the pass is reused.
  await gitc("commit", "--allow-empty", "-qm", "same tree");
  expect((await push()).code).toBe(0);
  expect(checkRuns()).toBe(1);
  writeFileSync(join(repo, "gate.txt"), "two\n");
  await gitc("commit", "-qam", "changed tree");
  expect((await push()).code).toBe(0);
  expect(checkRuns()).toBe(2);
});

test("a failing check stops the build and the push", async () => {
  writeFileSync(join(repo, "ci-local.yaml"), checkYaml("broken", "echo nope; exit 3"));
  await gitc("commit", "-qam", "broken check");
  writeFileSync(calls, "");
  const before = (await must(["git", "-C", remote, "rev-parse", "main"])).trim();
  const r = await push();
  expect(r.code).not.toBe(0);
  expect(log()).not.toContain("buildx build");
  expect((await must(["git", "-C", remote, "rev-parse", "main"])).trim()).toBe(before);
});

test("a pass from a working tree that differs from the commit is not remembered", async () => {
  writeFileSync(join(repo, "ci-local.yaml"), checkYaml("dirtycheck", "echo ran >> \"$CHECK_LOG\""));
  await gitc("commit", "-qam", "dirty check");
  const base1 = checkRuns();
  writeFileSync(join(repo, "gate.txt"), "uncommitted edit\n");
  expect((await push()).code).toBe(0);
  expect((await push()).code).toBe(0);
  expect(checkRuns()).toBe(base1 + 2);
  await gitc("checkout", "--", "gate.txt");
});

test("--no-checks skips them for a manual run", async () => {
  writeFileSync(join(repo, "ci-local.yaml"), checkYaml("skipme", "echo ran >> \"$CHECK_LOG\""));
  await gitc("commit", "-qam", "skip check");
  const before = checkRuns();
  const r = await exec(["ci-local", "run", "--no-push", "--no-checks"], { cwd: repo, env });
  expect(r.code, r.err).toBe(0);
  expect(checkRuns()).toBe(before);
});

test("two images from one Dockerfile build their own stage and get different tags", async () => {
  writeFileSync(
    join(repo, "ci-local.yaml"),
    "version: 1\nbranches: [main]\nimages:\n  - name: api\n    image: acme/api\n    target: production\n  - name: backup\n    image: acme/backup\n    target: backup\n",
  );
  await gitc("add", "-A");
  await gitc("commit", "-qm", "two stages");
  writeFileSync(calls, "");
  const r = await push();
  expect(r.code).toBe(0);
  const builds = log().split("\n").filter((l) => l.startsWith("docker buildx build"));
  expect(builds.length).toBe(2);
  expect(builds.find((l) => l.includes("--target production"))).toBeDefined();
  expect(builds.find((l) => l.includes("--target backup"))).toBeDefined();
  const tags = [...log().matchAll(/crane tag reg\.test:5000\/acme\/(api|backup):(sha-[0-9a-f]{12}) prod/g)].map((m) => m[2]);
  expect(tags.length).toBe(2);
  expect(tags[0]).not.toBe(tags[1]);
});
