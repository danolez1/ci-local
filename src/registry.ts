import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { childEnv, exec, has, must } from "./exec.ts";
import { type CountingProxy, countingProxy } from "./proxy.ts";
import { blobCount, type PushHooks, trackPush } from "./progress.ts";
import type { Profile } from "./types.ts";

export interface Registry {
  exists(repo: string, tag: string): Promise<boolean>;
  push(tarball: string, repo: string, tag: string, hooks?: PushHooks): Promise<void>;
  tag(repo: string, from: string, to: string): Promise<void>;
  close(): Promise<void>;
}

const craneFlags = (profile: Profile): string[] => (profile.insecure ? ["--insecure"] : []);

// Layers already in the registry are skipped on a retry, so a dropped upload resumes where it stopped.
const PUSH_ATTEMPTS = 3;

interface Link {
  address(): string;
  /** Bytes uploaded through this link, when it can count them. */
  sent?(): number;
  /** Brings a dead transport back before the next attempt. */
  recover(): Promise<void>;
  /** What is known about why the transport failed, for the final error. */
  explain(): Promise<string>;
  close(): Promise<void>;
}

function make(profile: Profile, link: Link): Registry {
  const flags = craneFlags(profile);
  return {
    async exists(repo, tag) {
      return (await exec(["crane", "manifest", ...flags, `${link.address()}/${repo}:${tag}`])).code === 0;
    },
    async push(tarball, repo, tag, hooks = {}) {
      const expected = await blobCount(tarball);
      for (let attempt = 1; ; attempt++) {
        const tracker = trackPush(hooks, link.sent, expected);
        // -v is the only way crane reports which layer it is on; its output is parsed, not logged.
        const r = await exec(["crane", "push", "-v", ...flags, tarball, `${link.address()}/${repo}:${tag}`], { onLine: tracker.line }).finally(tracker.stop);
        if (r.code === 0) return;
        const reason = tracker.error() || `crane push exited ${r.code}`;
        if (attempt >= PUSH_ATTEMPTS) throw new Error(`${reason}${await link.explain()} (after ${attempt} attempts)`);
        hooks.onLine?.(`push: attempt ${attempt} failed (${reason}), retrying`);
        await link.recover();
      }
    },
    async tag(repo, from, to) {
      await must(["crane", "tag", ...flags, `${link.address()}/${repo}:${from}`, to]);
    },
    close: link.close,
  };
}

interface Tunnel {
  proc: ReturnType<typeof Bun.spawn>;
  port: number;
  /** Drained as it arrives, so a chatty ssh can never block on a full pipe. */
  stderr: Promise<string>;
}

// A registry bound to the remote loopback needs no credentials through a port-forward, and a CDN in
// front of a public hostname would cap each layer upload at its request-size limit.
async function openTunnel(profile: Profile): Promise<Registry> {
  const host = profile.ssh_host as string;
  const dir = mkdtempSync(join(tmpdir(), "ci-local-ssh-"));
  const sock = join(dir, "ctl");
  let current: Tunnel;

  const stop = async () => {
    await exec(["ssh", "-S", sock, "-O", "exit", "--", host]);
    current.proc.kill();
  };

  const connect = async (): Promise<Tunnel> => {
    let lastError = "";
    // A master that died uncleanly leaves its socket behind, and ssh would then refuse to become the master.
    rmSync(sock, { force: true });
    for (let attempt = 0; attempt < 3; attempt++) {
      const port = 5100 + Math.floor(Math.random() * 800);
      // Staying in the foreground (no -f) keeps the daemonised ssh from holding our output pipes open.
      // A host stalled by CPU steal can miss many probes, so the link gets minutes before it is declared dead.
      const proc = Bun.spawn(
        [
          "ssh", "-N", "-M", "-S", sock,
          "-o", "ExitOnForwardFailure=yes",
          "-o", "ForwardAgent=no",
          "-o", "ConnectTimeout=20",
          "-o", "ServerAliveInterval=20",
          "-o", "ServerAliveCountMax=9",
          "-L", `127.0.0.1:${port}:${profile.registry}`,
          "--", host,
        ],
        { stdout: "ignore", stderr: "pipe", env: childEnv() },
      );
      const tunnel: Tunnel = { proc, port, stderr: new Response(proc.stderr as ReadableStream).text() };
      for (let waited = 0; waited < 30_000; waited += 300) {
        if (proc.exitCode !== null) break;
        if ((await exec(["ssh", "-S", sock, "-O", "check", "--", host])).code === 0) return tunnel;
        await Bun.sleep(300);
      }
      if (proc.exitCode !== null) lastError = (await tunnel.stderr).trim();
      else proc.kill();
    }
    throw new Error(`could not open an ssh tunnel to ${host}: ${lastError || "ssh did not become ready"}`);
  };

  try {
    current = await connect();
  } catch (e) {
    rmSync(dir, { recursive: true, force: true });
    throw e;
  }
  let proxy: CountingProxy;
  try {
    proxy = await countingProxy(() => current.port);
  } catch (e) {
    await stop();
    rmSync(dir, { recursive: true, force: true });
    throw e;
  }

  return make({ ...profile, insecure: true }, {
    address: () => `127.0.0.1:${proxy.port}`,
    sent: () => proxy.sent(),
    async recover() {
      if (current.proc.exitCode === null && (await exec(["ssh", "-S", sock, "-O", "check", "--", host])).code === 0) return;
      await stop();
      current = await connect();
    },
    async explain() {
      if (current.proc.exitCode === null) return "";
      return `; the ssh tunnel to ${host} had exited with code ${current.proc.exitCode}: ${(await current.stderr).trim() || "no output"}`;
    },
    async close() {
      await proxy.close();
      await stop();
      rmSync(dir, { recursive: true, force: true });
    },
  });
}

export async function openRegistry(profile: Profile): Promise<Registry> {
  if (!has("crane")) throw new Error("crane is not installed (brew install crane)");
  if (profile.transport === "ssh") return openTunnel(profile);
  return make(profile, { address: () => profile.registry, recover: async () => {}, explain: async () => "", close: async () => {} });
}
