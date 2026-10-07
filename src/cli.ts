import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { join } from "node:path";
import { ConfigError, loadGlobalConfig, loadRepoConfig, resolveProfile } from "./config.ts";
import { agentInstalled, DEFAULT_PORT, installAgent, readDaemon, registerDaemon, startDaemon, stopDaemon, uiLogFile, uninstallAgent } from "./daemon.ts";
import { daemonProxies, PROXY_HINT } from "./docker.ts";
import { runImage, type RunFlags } from "./engine.ts";
import { guardBuildEnv } from "./envguard.ts";
import { childEnv, exec, has } from "./exec.ts";
import { checkedOutRef, committedFile, parsePrePushRefs, repoRoot, resolveSha } from "./git.ts";
import { isSafeRelative, readExtractedFile } from "./paths.ts";
import { findEarlyExit, findHookTarget, installHook, isInstalled, isLastStep, isShellHook, uninstallHook, type HookKind } from "./hooks.ts";
import { latestRunId, listRuns, readLog, readRun, stateHome } from "./store.ts";
import type { RepoConfig, RunRecord } from "./types.ts";
import { startUi } from "./ui/server.ts";
import { watch } from "./watch.ts";

const HELP = `ci-local: build images on this machine and publish them to a registry before git pushes.

  ci-local run [flags]            build and publish the images of this repo for HEAD (or --sha)
  ci-local run --background       same, detached from this terminal; follow it with logs -f or the web view
  ci-local run --stdin            same, with the job given as YAML or JSON on stdin
  ci-local hook pre-push          what the git hook runs; reads the pushed refs on stdin
  ci-local status [-n 10] [--json]  recent runs
  ci-local logs [id] [-f]         a run's log (newest by default), -f follows it
  ci-local watch                  live terminal view
  ci-local ui [--port 7777]       start the local web view in the background and return; a second call prints the running one
  ci-local ui-stop                stop the background web view (same as ui stop)
  ci-local ui serve [--port 7777] the web view in this terminal (ctrl-c stops it)
  ci-local ui start|stop|restart|status|open|logs   manage the background web view
  ci-local ui install|uninstall   start it at login (macOS LaunchAgent)
  ci-local init --image <path> [--build-env build.env]  write a starter ci-local.yaml
  ci-local install-hook [--kind husky|githooks|git] [--remove]
  ci-local doctor                 check tools, config and the hook
  ci-local config                 print the resolved configuration

run flags: --image <name> --sha <rev> --profile <name> --platform <os/arch> --dry-run --no-push --retag --keep-local --no-checks
env: CI_LOCAL_SKIP_IMAGE=1 skips the hook, CI_LOCAL_PROFILE picks a profile, CI_LOCAL_CONFIG_DIR and CI_LOCAL_STATE_DIR move the files.
`;

interface Args {
  cmd: string;
  sub?: string;
  flags: Map<string, string | true>;
}

const VALUE_FLAGS = new Set(["image", "sha", "profile", "platform", "n", "port", "kind", "build-env"]);
const CLI = fileURLToPath(import.meta.url);

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
    results.push(await runImage({ root: ctx.root, sha, spec, profileName: ctx.profileName, profile: ctx.profile, publicPrefixes: ctx.config.public_prefixes, publicJwtKeys: ctx.config.public_jwt_keys, checks: ctx.config.checks, flags: opts.flags }));
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

// A detached child owns the run, so closing the terminal cannot stop a long build.
async function runInBackground(a: Args): Promise<number> {
  if (a.flags.has("stdin")) throw new ConfigError(["--background cannot be combined with --stdin"]);
  await repoRoot(process.cwd());
  const failureLog = join(stateHome(), `background-${process.pid}.log`);
  mkdirSync(stateHome(), { recursive: true });
  const out = openSync(failureLog, "w");
  const args = process.argv.slice(2).filter((x) => x !== "--background");
  const child = Bun.spawn([process.execPath, CLI, ...args], { cwd: process.cwd(), stdin: "ignore", stdout: out, stderr: out, env: childEnv(), detached: true });
  child.unref();
  closeSync(out);
  // The run record carries the child's pid, which identifies it even if another run starts at the same moment.
  for (let waited = 0; waited < 8000; waited += 250) {
    const run = listRuns(20).find((r) => r.pid === child.pid);
    if (run) {
      rmSync(failureLog, { force: true });
      console.log(`started ${run.id}\nfollow it with: ci-local logs -f ${run.id}${readDaemon() ? "" : "   (or ci-local ui)"}`);
      return 0;
    }
    if (child.exitCode !== null) break;
    await Bun.sleep(250);
  }
  const output = readFileSync(failureLog, "utf8").trim();
  rmSync(failureLog, { force: true });
  console.error(output || "the background run did not start");
  return 1;
}

// :prod follows a hook run for the first configured branch, or an explicit --retag, never a casual manual run.
async function cmdRun(a: Args): Promise<number> {
  if (a.flags.has("background")) return runInBackground(a);
  let results: RunRecord[];
  if (a.flags.has("stdin")) {
    const job = parseJob(await readStdin());
    results = await runAll({
      cwd: expandHome(job.repo ?? process.cwd()),
      sha: job.sha,
      images: job.images,
      profile: job.profile,
      flags: { push: job.push, retag: job.retag, dry: job.dry_run, keepLocal: job.keep_local, platform: job.platform, echo: true, trigger: "manual" },
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
        noChecks: a.flags.has("no-checks"),
        platform: flag(a, "platform"),
        echo: true,
        trigger: "manual",
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
  const bySha = new Map<string, { retag: boolean; ref: string }>();
  for (const p of pushed) {
    const seen = bySha.get(p.sha);
    bySha.set(p.sha, { retag: (seen?.retag ?? false) || p.ref === prodRef, ref: seen?.ref ?? p.ref.replace(/^refs\/heads\//, "") });
  }
  let failed = false;
  for (const [sha, { retag, ref }] of bySha) {
    const results = await runAll({ cwd: root, sha, flags: { push: true, retag, dry: false, keepLocal: false, echo: true, ref, trigger: "hook" } });
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
    const { text, next, size } = readLog(id, offset);
    if (text) process.stdout.write(text);
    offset = next;
    if (offset < size) continue;
    if (!a.flags.has("f") || readRun(id)?.status !== "running") break;
    await Bun.sleep(700);
  }
  return 0;
}

async function openUrl(url: string): Promise<void> {
  await exec([process.platform === "darwin" ? "open" : "xdg-open", url]);
}

async function cmdUiStop(): Promise<number> {
  console.log((await stopDaemon()) ? "stopped" : "not running");
  if (agentInstalled()) console.log("the login service is installed and will start it again; remove it with: ci-local ui uninstall");
  return 0;
}

async function cmdUi(a: Args): Promise<number> {
  const port = Number(flag(a, "port") ?? DEFAULT_PORT);
  const where = (p: number): string => `http://127.0.0.1:${p}`;
  switch (a.sub ?? "start") {
    case "serve": {
      const server = startUi(port);
      registerDaemon(server.port as number);
      console.log(`ci-local ui on ${where(server.port as number)}  (ctrl-c to stop)`);
      return await new Promise<number>(() => {});
    }
    case "start": {
      const info = await startDaemon(port);
      console.log(`web view running on ${where(info.port)} (pid ${info.pid}); stop it with: ci-local ui-stop`);
      if (a.flags.has("open")) await openUrl(where(info.port));
      return 0;
    }
    case "open": {
      const info = await startDaemon(port);
      await openUrl(where(info.port));
      console.log(where(info.port));
      return 0;
    }
    case "stop":
      return cmdUiStop();
    case "restart": {
      await stopDaemon();
      const info = await startDaemon(port);
      console.log(`web view running on ${where(info.port)} (pid ${info.pid})`);
      return 0;
    }
    case "status": {
      const info = readDaemon();
      console.log(info ? `running on ${where(info.port)} (pid ${info.pid}, since ${info.started})\nlog: ${uiLogFile()}` : "not running (start it with: ci-local ui)");
      return info ? 0 : 1;
    }
    case "logs": {
      if (!existsSync(uiLogFile())) throw new ConfigError(["no web view log yet"]);
      const tail = readFileSync(uiLogFile(), "utf8").split("\n").slice(-40).join("\n");
      console.log(tail);
      return 0;
    }
    case "install":
      console.log(`installed ${await installAgent(port)}; the web view now starts at login on ${where(port)}`);
      return 0;
    case "uninstall":
      console.log((await uninstallAgent()) ? "removed the login service" : "no login service installed");
      return 0;
    default:
      throw new ConfigError([`unknown ui command '${a.sub}'; use serve, start, stop, restart, status, open, logs, install or uninstall`]);
  }
}

async function cmdInit(a: Args): Promise<number> {
  const root = await repoRoot(process.cwd());
  const file = join(root, "ci-local.yaml");
  if (existsSync(file)) throw new ConfigError([`${file} already exists`]);
  const image = flag(a, "image");
  if (!image) throw new ConfigError(["pass --image <registry path>, for example --image acme/web"]);
  const profile = flag(a, "profile");
  const buildEnv = flag(a, "build-env");
  if (buildEnv && (!isSafeRelative(buildEnv) || !/^[\w./-]+$/.test(buildEnv))) throw new ConfigError(["--build-env must be a plain path inside the repository (letters, digits, . _ - and /)"]);
  const envLine = buildEnv
    ? `    # Public values only (NEXT_PUBLIC_*, VITE_*), read from this machine and gitignored; ci-local refuses secrets.\n    # Template: ${buildEnv}.example\n    build_env_local: ${buildEnv}\n`
    : "    # Public values only (NEXT_PUBLIC_*, VITE_*); ci-local refuses secrets. Use build_env_local for a gitignored file.\n    # build_env: build.env\n";
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
${envLine}`,
  );
  console.log(`wrote ${file}`);
  if (buildEnv) await scaffoldBuildEnv(root, buildEnv);
  return 0;
}

// The example is committed and the real file is not, so a fresh clone knows what to fill in.
async function scaffoldBuildEnv(root: string, rel: string): Promise<void> {
  const example = join(root, `${rel}.example`);
  if (!existsSync(example)) {
    await Bun.write(example, `# Copy to ${rel} and fill in. Public values only: ci-local refuses secrets and keys without a public prefix.\nNEXT_PUBLIC_EXAMPLE=\n`);
    console.log(`wrote ${example}`);
  }
  if ((await exec(["git", "-C", root, "check-ignore", "-q", "--", rel])).code !== 0) {
    const ignore = join(root, ".gitignore");
    const current = existsSync(ignore) ? readFileSync(ignore, "utf8") : "";
    await Bun.write(ignore, `${current}${current === "" || current.endsWith("\n") ? "" : "\n"}${rel}\n`);
    console.log(`added ${rel} to ${ignore}`);
  }
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
  const info = await exec(["docker", "info"]);
  line(info.code === 0 ? "ok" : "fail", "docker daemon reachable");
  const proxies = daemonProxies(info.out);
  if (proxies.length) line("warn", `docker daemon uses a proxy (${proxies.join(", ")}). ${PROXY_HINT}`);
  const clientConfig = join(homedir(), ".docker", "config.json");
  if (existsSync(clientConfig) && /"proxies"\s*:/.test(readFileSync(clientConfig, "utf8"))) {
    line("warn", `${clientConfig} sets proxies, which docker adds to every build as build args`);
  }
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
    if (config.checks.length) line("ok", `checks before the build: ${config.checks.map((c) => c.name).join(", ")}`);
    if (config.images.some((img) => img.compression === "zstd")) line(has("zstd") ? "ok" : "fail", "zstd (brew install zstd), needed by compression: zstd");
    for (const img of config.images) {
      for (const file of [img.build_env, img.build_args_file]) {
        if (!file) continue;
        try {
          const problems = guardBuildEnv(await committedFile(root, "HEAD", file), config.public_prefixes, file, config.public_jwt_keys);
          line(problems.length ? "fail" : "ok", problems.length ? problems.join("\n      ") : `${file} holds only public values`);
        } catch (e) {
          line("fail", `${file} (${img.name}): ${(e as Error).message}`);
        }
      }
    }
  }
  for (const img of config?.images ?? []) {
    const file = img.build_env_local;
    if (!file) continue;
    if (!existsSync(join(root, file))) {
      line("fail", `${file} (${img.name}, build_env_local) does not exist on this machine`);
      continue;
    }
    try {
      const problems = guardBuildEnv(readExtractedFile(root, file), config?.public_prefixes ?? [], file, config?.public_jwt_keys ?? []);
      line(problems.length ? "fail" : "ok", problems.length ? problems.join("\n      ") : `${file} holds only public values`);
    } catch (e) {
      line("fail", (e as Error).message);
      continue;
    }
    const tracked = (await exec(["git", "-C", root, "ls-files", "--error-unmatch", "--", file])).code === 0;
    const ignored = (await exec(["git", "-C", root, "check-ignore", "-q", "--", file])).code === 0;
    if (!existsSync(join(root, `${file}.example`))) line("warn", `no ${file}.example, so a fresh clone cannot tell what to fill in`);
    if (tracked) line("warn", `${file} is committed; use build_env instead of build_env_local`);
    else if (!ignored) line("warn", `${file} is not gitignored, so it will show up in git status`);
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
    case "ui": return cmdUi(a);
    case "ui-stop": return cmdUiStop();
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
