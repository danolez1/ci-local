import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ConfigError, loadGlobalConfig, loadRepoConfig, resolveProfile } from "./config.ts";
import { runImage, type RunFlags } from "./engine.ts";
import { guardBuildEnv } from "./envguard.ts";
import { exec, has } from "./exec.ts";
import { checkedOutRef, committedFile, parsePrePushRefs, repoRoot, resolveSha } from "./git.ts";
import { findEarlyExit, findHookTarget, installHook, isInstalled, isLastStep, isShellHook, uninstallHook, type HookKind } from "./hooks.ts";
import { latestRunId, listRuns, readLog, readRun, stateHome } from "./store.ts";
import type { RepoConfig, RunRecord } from "./types.ts";
import { startUi } from "./ui/server.ts";
import { watch } from "./watch.ts";

const HELP = `ci-local: build images on this machine and publish them to a registry before git pushes.

  ci-local run [flags]            build and publish the images of this repo for HEAD (or --sha)
  ci-local run --stdin            same, with the job given as YAML or JSON on stdin
  ci-local hook pre-push          what the git hook runs; reads the pushed refs on stdin
  ci-local status [-n 10] [--json]  recent runs
  ci-local logs [id] [-f]         a run's log (newest by default), -f follows it
  ci-local watch                  live terminal view
  ci-local ui [--port 7777]       local web view of the same runs
  ci-local init --image <path>    write a starter ci-local.yaml
  ci-local install-hook [--kind husky|githooks|git] [--remove]
  ci-local doctor                 check tools, config and the hook
  ci-local config                 print the resolved configuration

run flags: --image <name> --sha <rev> --profile <name> --platform <os/arch> --dry-run --no-push --retag --keep-local
env: CI_LOCAL_SKIP_IMAGE=1 skips the hook, CI_LOCAL_PROFILE picks a profile, CI_LOCAL_CONFIG_DIR and CI_LOCAL_STATE_DIR move the files.
`;

interface Args {
  cmd: string;
  sub?: string;
  flags: Map<string, string | true>;
}

const VALUE_FLAGS = new Set(["image", "sha", "profile", "platform", "n", "port", "kind"]);

function parseArgs(argv: string[]): Args {
  const [cmd = "help", ...tail] = argv;
  const flags = new Map<string, string | true>();
  const rest: string[] = [];
  for (let i = 0; i < tail.length; i++) {
    const a = tail[i] as string;
    const m = a.match(/^--?([\w-]+)(?:=(.*))?$/);
    if (!m) {
      rest.push(a);
      continue;
    }
    const key = m[1] as string;
    if (m[2] !== undefined) flags.set(key, m[2]);
    else if (VALUE_FLAGS.has(key) && tail[i + 1] !== undefined) flags.set(key, tail[++i] as string);
    else flags.set(key, true);
  }
  return { cmd, sub: rest[0], flags };
}

const flag = (a: Args, name: string): string | undefined => {
  const v = a.flags.get(name);
  return typeof v === "string" ? v : undefined;
};

async function readStdin(): Promise<string> {
  return await new Response(Bun.stdin.stream()).text();
}

async function repoContext(cwd: string, profileFlag?: string) {
  const root = await repoRoot(cwd);
  const config = await loadRepoConfig(root);
  if (!config) throw new ConfigError([`no ci-local.yaml in ${root} (run: ci-local init --image <registry path>)`]);
  const global = await loadGlobalConfig();
  const { name, profile } = resolveProfile(config, global, profileFlag);
  return { root, config, profileName: name, profile };
}

async function runAll(opts: { cwd: string; sha?: string; images?: string[]; profile?: string; flags: RunFlags }): Promise<RunRecord[]> {
  const ctx = await repoContext(opts.cwd, opts.profile);
  const sha = await resolveSha(ctx.root, opts.sha ?? "HEAD");
  const wanted = opts.images?.length ? ctx.config.images.filter((i) => opts.images?.includes(i.name)) : ctx.config.images;
  if (wanted.length === 0) throw new ConfigError([`no image matches ${opts.images?.join(", ")} (known: ${ctx.config.images.map((i) => i.name).join(", ")})`]);
  const results: RunRecord[] = [];
  for (const spec of wanted) {
    results.push(await runImage({ root: ctx.root, sha, spec, profileName: ctx.profileName, profile: ctx.profile, publicPrefixes: ctx.config.public_prefixes, flags: opts.flags }));
  }
  return results;
}

interface Job {
  repo?: string;
  sha?: string;
  images?: string[];
  profile?: string;
  platform?: string;
  push: boolean;
  retag: boolean;
  dry_run: boolean;
  keep_local: boolean;
}

const JOB_STRINGS = ["repo", "sha", "profile", "platform"] as const;
const JOB_FLAGS = ["push", "retag", "dry_run", "keep_local"] as const;

// A mistyped value must fail loudly: "dry_run: yes" silently becoming a real push is the worst outcome.
function parseJob(text: string): Job {
  const raw: unknown = Bun.YAML.parse(text);
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new ConfigError(["the job on stdin must be a YAML or JSON mapping"]);
  const obj = raw as Record<string, unknown>;
  const known = new Set<string>([...JOB_STRINGS, ...JOB_FLAGS, "images"]);
  const problems = Object.keys(obj).filter((k) => !known.has(k)).map((k) => `unknown key '${k}'`);
  for (const k of JOB_STRINGS) if (obj[k] !== undefined && typeof obj[k] !== "string") problems.push(`${k} must be a string`);
  for (const k of JOB_FLAGS) if (obj[k] !== undefined && typeof obj[k] !== "boolean") problems.push(`${k} must be true or false`);
  if (obj.images !== undefined && (!Array.isArray(obj.images) || obj.images.some((i) => typeof i !== "string"))) problems.push("images must be a list of names");
  if (problems.length) throw new ConfigError(problems);
  return {
    repo: obj.repo as string | undefined,
    sha: obj.sha as string | undefined,
    images: obj.images as string[] | undefined,
    profile: obj.profile as string | undefined,
    platform: obj.platform as string | undefined,
    push: obj.push !== false,
    retag: obj.retag === true,
    dry_run: obj.dry_run === true,
    keep_local: obj.keep_local === true,
  };
}

const expandHome = (p: string): string => p.replace(/^~(?=\/|$)/, homedir());

// :prod follows a hook run for the first configured branch, or an explicit --retag, never a casual manual run.
async function cmdRun(a: Args): Promise<number> {
  let results: RunRecord[];
  if (a.flags.has("stdin")) {
    const job = parseJob(await readStdin());
    results = await runAll({
      cwd: expandHome(job.repo ?? process.cwd()),
      sha: job.sha,
      images: job.images,
      profile: job.profile,
      flags: { push: job.push, retag: job.retag, dry: job.dry_run, keepLocal: job.keep_local, platform: job.platform, echo: true },
    });
  } else {
    const image = flag(a, "image");
    results = await runAll({
      cwd: process.cwd(),
      sha: flag(a, "sha"),
      images: image ? [image] : undefined,
      profile: flag(a, "profile"),
      flags: {
        push: !a.flags.has("no-push"),
        retag: a.flags.has("retag"),
        dry: a.flags.has("dry-run"),
        keepLocal: a.flags.has("keep-local"),
        platform: flag(a, "platform"),
        echo: true,
      },
    });
  }
  return results.some((r) => r.status === "failed") ? 1 : 0;
}

async function cmdHook(a: Args): Promise<number> {
  if (a.sub !== "pre-push") throw new ConfigError(["only the pre-push hook is supported: ci-local hook pre-push"]);
  if (process.env.CI_LOCAL_SKIP_IMAGE === "1") {
    process.stderr.write("ci-local: skipped (CI_LOCAL_SKIP_IMAGE=1)\n");
    return 0;
  }
  const root = await repoRoot(process.cwd());
  const config = await loadRepoConfig(root);
  if (!config) return 0;
  const input = process.stdin.isTTY ? "" : await readStdin();
  let pushed = parsePrePushRefs(input, config.branches);
  if (input.trim() === "") {
    const guess = await checkedOutRef(root, config.branches);
    if (!guess) return 0;
    process.stderr.write(`ci-local: pushed refs were not on stdin, using ${guess.ref}\n`);
    pushed = [guess];
  }
  const prodRef = `refs/heads/${config.branches[0]}`;
  const bySha = new Map<string, boolean>();
  for (const p of pushed) bySha.set(p.sha, (bySha.get(p.sha) ?? false) || p.ref === prodRef);
  let failed = false;
  for (const [sha, retag] of bySha) {
    const results = await runAll({ cwd: root, sha, flags: { push: true, retag, dry: false, keepLocal: false, echo: true } });
    if (results.some((r) => r.status === "failed")) failed = true;
  }
  if (failed) process.stderr.write("ci-local: image build failed, push stopped. Skip once with CI_LOCAL_SKIP_IMAGE=1 git push\n");
  return failed ? 1 : 0;
}

function cmdStatus(a: Args): number {
  const runs = listRuns(Number(flag(a, "n") ?? 10) || 10);
  if (a.flags.has("json")) {
    console.log(JSON.stringify(runs, null, 2));
    return 0;
  }
  if (runs.length === 0) console.log("no runs yet");
  for (const r of runs) {
    const took = r.ended ? `${Math.round((new Date(r.ended).getTime() - new Date(r.started).getTime()) / 1000)}s` : "running";
    console.log(`${r.status.padEnd(8)} ${r.image.padEnd(34)} ${r.sha.slice(0, 8)} ${(r.tag ?? "").padEnd(18)} ${took.padStart(7)}  ${r.id}`);
  }
  return 0;
}

async function cmdLogs(a: Args): Promise<number> {
  const id = a.sub ?? latestRunId();
  if (!id || !readRun(id)) throw new ConfigError([id ? `no run '${id}'` : "no runs yet"]);
  let offset = 0;
  for (;;) {
    const { text, next } = readLog(id, offset);
    if (text) process.stdout.write(text);
    offset = next;
    if (!a.flags.has("f") || readRun(id)?.status !== "running") break;
    await Bun.sleep(700);
  }
  return 0;
}

async function cmdInit(a: Args): Promise<number> {
  const root = await repoRoot(process.cwd());
  const file = join(root, "ci-local.yaml");
  if (existsSync(file)) throw new ConfigError([`${file} already exists`]);
  const image = flag(a, "image");
  if (!image) throw new ConfigError(["pass --image <registry path>, for example --image acme/web"]);
  const profile = flag(a, "profile");
  await Bun.write(
    file,
    `version: 1
${profile ? `profile: ${profile}\n` : ""}# Pushes to these branches build and publish. Each entry may end in * to match a prefix.
# :prod follows the first entry.
branches: [main]
images:
  - name: ${image.split("/").pop()}
    image: ${image}
    dockerfile: Dockerfile
    context: .
    # Files that cannot change the image, so edits there do not cause a rebuild.
    tag_exclude: [.github, docs, README.md]
    # Public values only (NEXT_PUBLIC_*, VITE_*); ci-local refuses secrets. Uncomment if the build needs them.
    # build_env: infra/build.env
`,
  );
  console.log(`wrote ${file}`);
  return 0;
}

async function cmdInstallHook(a: Args): Promise<number> {
  const root = await repoRoot(process.cwd());
  const kind = flag(a, "kind") as HookKind | undefined;
  if (kind && !["husky", "githooks", "git"].includes(kind)) throw new ConfigError(["--kind must be husky, githooks or git"]);
  const target = await findHookTarget(root, kind);
  if (a.flags.has("remove")) {
    console.log(uninstallHook(target) ? `removed ci-local from ${target.file}` : `nothing to remove in ${target.file}`);
    return 0;
  }
  const result = installHook(target);
  // Pointing core.hooksPath at a new directory would silence whatever hooks the old one held.
  if (target.kind === "githooks" && !target.configured) await exec(["git", "-C", root, "config", "core.hooksPath", ".githooks"]);
  console.log(`${result} ${target.kind} hook ${target.file} (ci-local runs as its last step)`);
  const early = findEarlyExit(readFileSync(target.file, "utf8"));
  if (early) console.log(`warn  line ${early} of the hook calls exit before ci-local, so the build never runs; move that exit or remove it`);
  return 0;
}

async function cmdDoctor(): Promise<number> {
  let bad = 0;
  const labels = { ok: "ok  ", warn: "warn", fail: "FAIL" };
  const line = (state: keyof typeof labels, msg: string) => {
    if (state === "fail") bad++;
    console.log(`${labels[state]}  ${msg}`);
  };
  line(has("docker") ? "ok" : "fail", "docker CLI");
  line((await exec(["docker", "info"])).code === 0 ? "ok" : "fail", "docker daemon reachable");
  line(has("crane") ? "ok" : "fail", "crane (brew install crane)");
  line(has("ssh") ? "ok" : "warn", "ssh");
  line("ok", `state dir ${stateHome()}`);
  let root: string;
  try {
    root = await repoRoot(process.cwd());
  } catch {
    line("warn", "not inside a git repo, skipping repo checks");
    return bad ? 1 : 0;
  }
  let config: RepoConfig | null = null;
  try {
    config = await loadRepoConfig(root);
    line(config ? "ok" : "fail", config ? `ci-local.yaml (${config.images.length} image(s), branches ${config.branches.join(", ")})` : "ci-local.yaml missing");
  } catch (e) {
    line("fail", `ci-local.yaml invalid:\n${(e as Error).message}`);
  }
  if (config) {
    try {
      const { name, profile } = resolveProfile(config, await loadGlobalConfig());
      line("ok", `profile ${name}: ${profile.transport} to ${profile.registry}${profile.ssh_host ? ` via ${profile.ssh_host}` : ""}`);
    } catch (e) {
      line("fail", (e as Error).message);
    }
    for (const img of config.images) {
      for (const file of [img.build_env, img.build_args_file]) {
        if (!file) continue;
        try {
          const problems = guardBuildEnv(await committedFile(root, "HEAD", file), config.public_prefixes, file);
          line(problems.length ? "fail" : "ok", problems.length ? problems.join("\n      ") : `${file} holds only public values`);
        } catch (e) {
          line("fail", `${file} (${img.name}): ${(e as Error).message}`);
        }
      }
    }
  }
  const target = await findHookTarget(root);
  if (!existsSync(target.file)) {
    line("fail", `no pre-push hook at ${target.file} (ci-local install-hook)`);
  } else {
    const text = readFileSync(target.file, "utf8");
    line(isInstalled(text) ? "ok" : "fail", `ci-local block in ${target.file}`);
    if (!isShellHook(text)) line("fail", "the hook is not a shell script, so the ci-local block cannot run in it");
    if (isInstalled(text)) {
      line(isLastStep(text) ? "ok" : "fail", "ci-local is the last step of the hook (re-run install-hook to fix)");
      const early = findEarlyExit(text);
      if (early) line("fail", `line ${early} of the hook calls exit before ci-local, so the build never runs`);
    }
  }
  return bad ? 1 : 0;
}

async function cmdConfig(): Promise<number> {
  const root = await repoRoot(process.cwd());
  const config = await loadRepoConfig(root);
  if (!config) throw new ConfigError(["no ci-local.yaml here"]);
  const global = await loadGlobalConfig();
  console.log(JSON.stringify({ repo: root, global_default_profile: global.default_profile, profiles: { ...global.profiles, ...config.profiles }, repo_config: config }, null, 2));
  return 0;
}

async function main(): Promise<number> {
  const a = parseArgs(process.argv.slice(2));
  switch (a.cmd) {
    case "run": return cmdRun(a);
    case "hook": return cmdHook(a);
    case "status": return cmdStatus(a);
    case "logs": return cmdLogs(a);
    case "watch": await watch(); return 0;
    case "ui": {
      const server = startUi(Number(flag(a, "port") ?? 7777));
      console.log(`ci-local ui on http://127.0.0.1:${server.port}  (ctrl-c to stop)`);
      return await new Promise<number>(() => {});
    }
    case "init": return cmdInit(a);
    case "install-hook": return cmdInstallHook(a);
    case "doctor": return cmdDoctor();
    case "config": return cmdConfig();
    case "help": case "--help": case "-h": console.log(HELP); return 0;
    default:
      console.error(`unknown command '${a.cmd}'\n\n${HELP}`);
      return 2;
  }
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(e instanceof ConfigError ? e.message : `ci-local: ${e instanceof Error ? e.message : e}`);
    process.exit(e instanceof ConfigError ? 2 : 1);
  },
);
