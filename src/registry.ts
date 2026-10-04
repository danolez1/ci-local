import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exec, has, must } from "./exec.ts";
import type { Profile } from "./types.ts";

export interface Registry {
  exists(repo: string, tag: string): Promise<boolean>;
  push(tarball: string, repo: string, tag: string): Promise<void>;
  tag(repo: string, from: string, to: string): Promise<void>;
  close(): Promise<void>;
}

const craneFlags = (profile: Profile): string[] => (profile.insecure ? ["--insecure"] : []);

function make(address: string, profile: Profile, close: () => Promise<void>): Registry {
  const flags = craneFlags(profile);
  return {
    async exists(repo, tag) {
      return (await exec(["crane", "manifest", ...flags, `${address}/${repo}:${tag}`])).code === 0;
    },
    async push(tarball, repo, tag) {
      await must(["crane", "push", ...flags, tarball, `${address}/${repo}:${tag}`]);
    },
    async tag(repo, from, to) {
      await must(["crane", "tag", ...flags, `${address}/${repo}:${from}`, to]);
    },
    close,
  };
}

// A registry bound to the remote loopback needs no credentials through a port-forward, and a CDN in
// front of a public hostname would cap each layer upload at its request-size limit.
async function openTunnel(profile: Profile): Promise<Registry> {
  const host = profile.ssh_host as string;
  const dir = mkdtempSync(join(tmpdir(), "ci-local-ssh-"));
  const sock = join(dir, "ctl");
  let ssh: ReturnType<typeof Bun.spawn> | undefined;
  const close = async () => {
    await exec(["ssh", "-S", sock, "-O", "exit", "--", host]);
    ssh?.kill();
    rmSync(dir, { recursive: true, force: true });
  };
  let lastError = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    const port = 5100 + Math.floor(Math.random() * 800);
    // Staying in the foreground (no -f) keeps the daemonised ssh from holding our output pipes open.
    ssh = Bun.spawn(
      [
        "ssh", "-N", "-M", "-S", sock,
        "-o", "ExitOnForwardFailure=yes",
        "-o", "ForwardAgent=no",
        "-o", "ConnectTimeout=20",
        "-o", "ServerAliveInterval=15",
        "-o", "ServerAliveCountMax=4",
        "-L", `127.0.0.1:${port}:${profile.registry}`,
        "--", host,
      ],
      { stdout: "ignore", stderr: "pipe" },
    );
    for (let waited = 0; waited < 30_000; waited += 300) {
      if (ssh.exitCode !== null) break;
      if ((await exec(["ssh", "-S", sock, "-O", "check", "--", host])).code === 0) {
        return make(`127.0.0.1:${port}`, { ...profile, insecure: true }, close);
      }
      await Bun.sleep(300);
    }
    if (ssh.exitCode !== null) lastError = (await new Response(ssh.stderr as ReadableStream).text()).trim();
    else ssh.kill();
  }
  rmSync(dir, { recursive: true, force: true });
  throw new Error(`could not open an ssh tunnel to ${host}: ${lastError || "ssh did not become ready"}`);
}

export async function openRegistry(profile: Profile): Promise<Registry> {
  if (!has("crane")) throw new Error("crane is not installed (brew install crane)");
  if (profile.transport === "ssh") return openTunnel(profile);
  return make(profile.registry, profile, async () => {});
}
