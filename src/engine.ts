import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runChecks } from "./checks.ts";
import { guardBuildEnv, parseEnvLines } from "./envguard.ts";
import { withProxyHint } from "./docker.ts";
import { exec, has, killChildren, must, setProxyMode } from "./exec.ts";
import { archiveTo, committedFile, isCommitted, shortSha, treeHash } from "./git.ts";
import { placeFile, readExtractedFile, within } from "./paths.ts";
import { openRegistry, type Registry } from "./registry.ts";
import { recompressLayers } from "./recompress.ts";
import { RunHandle, zstdCacheDir } from "./store.ts";
import type { Check, ImageSpec, Profile, RunRecord } from "./types.ts";

// The target joins the salt only when set, so images without one keep the tags they already have in the registry.
export function tagSalt(platform: string, spec: ImageSpec, localHash: string): string {
  return `${platform}|${spec.dockerfile}|${spec.context}${spec.target ? `|${spec.target}` : ""}|${localHash}`;
}

export interface RunFlags {
  push: boolean;
  /** Move :prod to this build. Only runs that follow the first configured branch should set it. */
  retag: boolean;
  dry: boolean;
  keepLocal: boolean;
  noChecks?: boolean;
  platform?: string;
  echo: boolean;
  ref?: string;
  trigger?: "hook" | "manual";
}

interface RunInput {
  root: string;
  sha: string;
  spec: ImageSpec;
  profileName: string;
  profile: Profile;
  publicPrefixes: string[];
  checks: Check[];
  flags: RunFlags;
}

export async function runImage(input: RunInput): Promise<RunRecord> {
  const { root, sha, spec, profile, flags } = input;
  const run = RunHandle.create({ repo_path: root, image: spec.image, sha, profile: input.profileName, echo: flags.echo, ref: flags.ref, trigger: flags.trigger });
  setProxyMode(profile.proxy === "inherit");
  const platform = flags.platform ?? spec.platform ?? profile.platform ?? "linux/amd64";
  let registry: Registry | undefined;
  let workDir: string | undefined;
  let localTag: string | undefined;
  let cleaned = false;
  const onLine = (line: string) => run.log(line);

  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    if (registry) await registry.close();
    if (localTag && flags.push && !flags.keepLocal) await exec(["docker", "rmi", localTag]);
    if (workDir) rmSync(workDir, { recursive: true, force: true });
  };
  // Ctrl-C would skip the finally block, leaving the ssh tunnel, the temp dir and a run stuck as "running".
  const onSignal = (signal: string) => {
    run.say(`interrupted by ${signal}`);
    run.finish("failed", "interrupted");
    killChildren();
    void cleanup().finally(() => process.exit(130));
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  try {
    run.say(`${spec.image} at ${shortSha(sha)} for ${platform}, profile ${input.profileName} (${profile.transport})`);

    // Not in the commit, so its content has to reach the tag or a changed value would reuse an old image.
    let localEnv: string | undefined;
    if (spec.build_env_local) {
      if (await isCommitted(root, sha, spec.build_env_local)) throw new Error(`${spec.build_env_local} is committed at ${shortSha(sha)}; a working-tree copy must not override it, use build_env instead`);
      if (!existsSync(join(root, spec.build_env_local))) throw new Error(`${spec.build_env_local} (build_env_local) does not exist in ${root}`);
      localEnv = readExtractedFile(root, spec.build_env_local);
      const problems = guardBuildEnv(localEnv, input.publicPrefixes, spec.build_env_local);
      if (problems.length) throw new Error(`refusing to build:\n${problems.join("\n")}`);
    }
    const localHash = localEnv === undefined ? "" : new Bun.CryptoHasher("sha256").update(localEnv).digest("hex").slice(0, 12);

    const tag = await run.phase("hash", async () => {
      const hash = await treeHash(root, sha, {
        include: spec.tag_include,
        exclude: spec.tag_exclude,
        salt: tagSalt(platform, spec, localHash),
      });
      return `sha-${hash}`;
    });
    const pullRef = `${profile.pull_registry ?? profile.registry}/${spec.image}:${tag}`;
    run.set({ tag, pull_ref: pullRef });

    await run.phase("guard", async () => {
      const problems: string[] = [];
      for (const file of [spec.build_env, spec.build_args_file]) {
        if (!file) continue;
        problems.push(...guardBuildEnv(await committedFile(root, sha, file), input.publicPrefixes, file));
      }
      if (problems.length) throw new Error(`refusing to build:\n${problems.join("\n")}`);
    });

    if (flags.dry) {
      if (input.checks.length && !flags.noChecks) run.say(`dry run: would run checks ${input.checks.map((c) => c.name).join(", ")}`);
      run.say(`dry run: would publish ${spec.image}:${tag}`);
      run.finish("dry-run");
      return run.record;
    }

    // Before docker and the tunnel are opened, so a long test run never holds a connection idle.
    if (!flags.noChecks) await runChecks(run, root, sha, input.checks);

    await run.phase("docker", async () => {
      if ((await exec(["docker", "info"])).code !== 0) throw new Error("docker is not running (start OrbStack or Docker Desktop)");
      if (spec.compression === "zstd" && flags.push && !has("zstd")) throw new Error("zstd is not installed (brew install zstd)");
    });

    if (flags.push) registry = await run.phase("registry", () => openRegistry(profile));

    if (registry && (await registry.exists(spec.image, tag))) {
      run.say(`${tag} is already in the registry, build skipped`);
      run.set({ pushed: true });
      if (flags.retag) await run.phase("retag", () => registry!.tag(spec.image, tag, "prod"));
      run.finish("skipped");
      run.say(`deploy image: ${pullRef}`);
      return run.record;
    }

    workDir = mkdtempSync(join(tmpdir(), "ci-local-"));
    const ctx = join(workDir, "ctx");
    mkdirSync(ctx);
    await run.phase("extract", async () => {
      await archiveTo(root, sha, ctx);
      if (spec.build_env_local && localEnv !== undefined) placeFile(ctx, spec.build_env_local, localEnv);
    });

    // The image is exported as an OCI layout and recompressed, so it is never loaded into the local daemon.
    const zstd = registry !== undefined && spec.compression === "zstd";
    const ociDir = join(workDir, "image-oci");
    if (!zstd) localTag = `ci-local/${spec.image}:${tag}`;
    await run.phase("build", async () => {
      // Re-checking the extracted files closes any gap between the committed blobs the guard read and what the build sees.
      for (const file of [spec.build_env, spec.build_env_local, spec.build_args_file]) {
        if (!file) continue;
        const problems = guardBuildEnv(readExtractedFile(ctx, file), input.publicPrefixes, file);
        if (problems.length) throw new Error(`refusing to build:\n${problems.join("\n")}`);
      }
      const buildArgs: string[] = [];
      if (spec.build_args_file) {
        for (const { key, value } of parseEnvLines(readExtractedFile(ctx, spec.build_args_file))) buildArgs.push("--build-arg", `${key}=${value}`);
      }
      const r = await exec(
        [
          "docker", "buildx", "build",
          "--platform", platform,
          "--provenance=false", "--sbom=false", "--progress=plain",
          "-f", within(ctx, spec.dockerfile),
          ...(spec.target ? ["--target", spec.target] : []),
          ...buildArgs,
          ...(zstd ? ["--output", `type=oci,tar=false,dest=${ociDir},compression=uncompressed,force-compression=true`] : ["-t", localTag as string, "--load"]),
          within(ctx, spec.context),
        ],
        { onLine },
      );
      if (r.code !== 0) throw new Error(withProxyHint(`docker build exited ${r.code}`, r.out + r.err));
    });

    if (registry) {
      let artifact = join(workDir, "image.tar");
      if (zstd) {
        artifact = ociDir;
        await run.phase("compress", async () => {
          const stats = await recompressLayers(ociDir, spec.zstd_level, zstdCacheDir(), onLine);
          run.say(`compressed to zstd-${spec.zstd_level}: ${stats.compressed} layers compressed, ${stats.cached} reused, ${Math.round(stats.before / 1e6)} MB -> ${Math.round(stats.after / 1e6)} MB`);
        });
      } else {
        await run.phase("save", async () => {
          await must(["docker", "save", "-o", artifact, localTag as string]);
        });
      }
      await run.phase("push", async () => {
        await registry!.push(artifact, spec.image, tag, { onLine, onProgress: (push) => run.set({ push }) });
      });
      run.set({ pushed: true });
      if (flags.retag) await run.phase("retag", () => registry!.tag(spec.image, tag, "prod"));
      run.say(`deploy image: ${pullRef}`);
    }

    run.finish("success");
    return run.record;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    run.say(`failed: ${message}`);
    run.finish("failed", message);
    return run.record;
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    await cleanup();
  }
}
