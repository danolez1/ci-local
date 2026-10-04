import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exec, must } from "../src/exec.ts";

const cli = join(import.meta.dir, "..", "bin", "ci-local.mjs");
let base = "";
let repo = "";
let env: Record<string, string> = {};

beforeAll(async () => {
  base = mkdtempSync(join(tmpdir(), "ci-local-e2e-"));
  repo = join(base, "app");
  mkdirSync(repo);
  env = { CI_LOCAL_CONFIG_DIR: join(base, "cfg"), CI_LOCAL_STATE_DIR: join(base, "state") };
  mkdirSync(env.CI_LOCAL_CONFIG_DIR as string);
  writeFileSync(join(env.CI_LOCAL_CONFIG_DIR as string, "config.yaml"), "default_profile: t\nprofiles:\n  t: { transport: direct, registry: 'localhost:5000' }\n");
  await must(["git", "-C", repo, "init", "-q", "-b", "main"]);
  writeFileSync(join(repo, "Dockerfile"), "FROM scratch\n");
  writeFileSync(join(repo, "ci-local.yaml"), "version: 1\nimages:\n  - image: acme/app\n    build_env: public.env\n");
  writeFileSync(join(repo, "public.env"), "NEXT_PUBLIC_A=1\n");
  await must(["git", "-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", "add", "-A"]);
  await must(["git", "-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"]);
});

afterAll(() => rmSync(base, { recursive: true, force: true }));

const run = (args: string[], stdin?: string) => exec([cli, ...args], { cwd: repo, env, stdin });

test("a dry run prints the tag and records the run", async () => {
  const r = await run(["run", "--dry-run"]);
  expect(r.code).toBe(0);
  expect(r.err).toContain("dry run: would publish acme/app:sha-");
  const status = await run(["status"]);
  expect(status.out).toContain("dry-run");
});

test("the job can arrive as YAML on stdin", async () => {
  const r = await run(["run", "--stdin"], `repo: ${repo}\ndry_run: true\nimages: [app]\n`);
  expect(r.code).toBe(0);
});

test("a secret in the build env stops the run", async () => {
  writeFileSync(join(repo, "public.env"), `NEXT_PUBLIC_A=${["sk", "live", "x"].join("_")}\n`);
  await must(["git", "-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qam", "leak"]);
  const r = await run(["run", "--dry-run"]);
  expect(r.code).toBe(1);
  expect(r.err).toContain("looks like a secret");
});

test("the hook ignores pushes to other branches", async () => {
  const sha = (await must(["git", "-C", repo, "rev-parse", "HEAD"])).trim();
  const r = await run(["hook", "pre-push"], `refs/heads/x ${sha} refs/heads/feature ${"0".repeat(40)}\n`);
  expect(r.code).toBe(0);
  expect(r.err).not.toContain("ci-local:");
});

test("install-hook then doctor agree the step is last", async () => {
  await run(["install-hook"]);
  const doc = await run(["doctor"]);
  expect(doc.out).toContain("last step of the hook");
  expect(doc.out).not.toContain("FAIL  ci-local is the last");
}, 30000);

test("--platform changes the tag, so an arm64 test build never collides with the amd64 one", async () => {
  const tagOf = async (extra: string[]) => (await run(["run", "--dry-run", "--sha", "HEAD~1", ...extra])).err.match(/sha-[0-9a-f]{12}/)?.[0];
  const amd = await tagOf([]);
  const arm = await tagOf(["--platform", "linux/arm64"]);
  expect(amd).toBeDefined();
  expect(arm).toBeDefined();
  expect(arm).not.toBe(amd);
}, 60000);

test("a mistyped stdin job fails instead of running for real", async () => {
  const wrongType = await run(["run", "--stdin"], `repo: ${repo}\ndry_run: "yes"\n`);
  expect(wrongType.code).toBe(2);
  expect(wrongType.err).toContain("dry_run must be true or false");
  const unknown = await run(["run", "--stdin"], `repo: ${repo}\nbogus: 1\n`);
  expect(unknown.code).toBe(2);
  expect(unknown.err).toContain("unknown key 'bogus'");
});

test("a secret in build_args_file is refused like one in build_env", async () => {
  writeFileSync(join(repo, "ci-local.yaml"), "version: 1\nimages:\n  - image: acme/app\n    build_args_file: args.env\n");
  writeFileSync(join(repo, "args.env"), `NEXT_PUBLIC_T=${["ghp", "abcdefghijklmnop"].join("_")}\n`);
  await must(["git", "-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", "add", "-A"]);
  await must(["git", "-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "args"]);
  const r = await run(["run", "--dry-run"]);
  expect(r.code).toBe(1);
  expect(r.err).toContain("args.env");
});

test("install-hook keeps a custom core.hooksPath and writes there", async () => {
  await must(["git", "-C", repo, "config", "core.hooksPath", "my-hooks"]);
  const r = await run(["install-hook"]);
  expect(r.out).toContain("my-hooks/pre-push");
  expect((await must(["git", "-C", repo, "config", "core.hooksPath"])).trim()).toBe("my-hooks");
});

test("install-hook refuses a hook that is not a shell script", async () => {
  mkdirSync(join(repo, "node-hooks"), { recursive: true });
  writeFileSync(join(repo, "node-hooks", "pre-push"), "#!/usr/bin/env node\nconsole.log(1)\n");
  await must(["git", "-C", repo, "config", "core.hooksPath", "node-hooks"]);
  const r = await run(["install-hook"]);
  expect(r.code).toBe(1);
  expect(r.err).toContain("not a shell script");
});

test("build_env_local comes from the working tree and its content changes the tag", async () => {
  mkdirSync(join(repo, "infra"), { recursive: true });
  writeFileSync(join(repo, ".gitignore"), "infra/local.env\n");
  writeFileSync(join(repo, "ci-local.yaml"), "version: 1\nimages:\n  - image: acme/app\n    build_env_local: infra/local.env\n");
  await must(["git", "-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", "add", "-A"]);
  await must(["git", "-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "local env"]);
  const tagOf = async () => (await run(["run", "--dry-run"])).err.match(/sha-[0-9a-f]{12}/)?.[0];

  const missing = await run(["run", "--dry-run"]);
  expect(missing.code).toBe(1);
  expect(missing.err).toContain("does not exist");

  writeFileSync(join(repo, "infra", "local.env"), "NEXT_PUBLIC_A=one\n");
  const first = await tagOf();
  writeFileSync(join(repo, "infra", "local.env"), "NEXT_PUBLIC_A=two\n");
  const second = await tagOf();
  expect(first).toBeDefined();
  expect(second).toBeDefined();
  expect(second).not.toBe(first);

  writeFileSync(join(repo, "infra", "local.env"), `NEXT_PUBLIC_A=${["sk", "live", "z"].join("_")}\n`);
  const secret = await run(["run", "--dry-run"]);
  expect(secret.code).toBe(1);
  expect(secret.err).toContain("looks like a secret");
}, 60000);

test("init --build-env writes the example, ignores the real file and points the config at it", async () => {
  const fresh = mkdtempSync(join(base, "init-"));
  await must(["git", "-C", fresh, "init", "-q", "-b", "main"]);
  const r = await exec([cli, "init", "--image", "acme/web", "--build-env", "infra/build.env"], { cwd: fresh, env });
  expect(r.code).toBe(0);
  expect(readFileSync(join(fresh, "ci-local.yaml"), "utf8")).toContain("build_env_local: infra/build.env");
  expect(readFileSync(join(fresh, "infra", "build.env.example"), "utf8")).toContain("NEXT_PUBLIC_EXAMPLE=");
  expect(readFileSync(join(fresh, ".gitignore"), "utf8")).toContain("infra/build.env");
  expect((await exec(["git", "-C", fresh, "check-ignore", "-q", "infra/build.env"])).code).toBe(0);
}, 60000);

test("build_env_local refuses a file that is committed or listed twice", async () => {
  writeFileSync(join(repo, "ci-local.yaml"), "version: 1\nimages:\n  - image: acme/app\n    build_env: infra/local.env\n    build_env_local: infra/local.env\n");
  const twice = await run(["run", "--dry-run"]);
  expect(twice.code).toBe(2);
  expect(twice.err).toContain("different file");

  writeFileSync(join(repo, "ci-local.yaml"), "version: 1\nimages:\n  - image: acme/app\n    build_env_local: Dockerfile\n");
  await must(["git", "-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qam", "points at a tracked file"]);
  const tracked = await run(["run", "--dry-run"]);
  expect(tracked.code).toBe(1);
  expect(tracked.err).toContain("is committed");
}, 60000);
