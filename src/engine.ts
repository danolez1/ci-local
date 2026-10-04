import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { guardBuildEnv, parseEnvLines } from "./envguard.ts";
import { withProxyHint } from "./docker.ts";
import { exec, must, setProxyMode } from "./exec.ts";
import { archiveTo, committedFile, shortSha, treeHash } from "./git.ts";
import { readExtractedFile, within } from "./paths.ts";
import { openRegistry, type Registry } from "./registry.ts";
import { RunHandle } from "./store.ts";
import type { ImageSpec, Profile, RunRecord } from "./types.ts";

export interface RunFlags {
  push: boolean;
  /** Move :prod to this build. Only runs that follow the first configured branch should set it. */
  retag: boolean;
  dry: boolean;
  keepLocal: boolean;
  platform?: string;
  echo: boolean;
}

interface RunInput {
  root: string;
  sha: string;
  spec: ImageSpec;
  profileName: string;
  profile: Profile;
  publicPrefixes: string[];
  flags: RunFlags;
}

export async function runImage(input: RunInput): Promise<RunRecord> {
  const { root, sha, spec, profile, flags } = input;
  const run = RunHandle.create({ repo_path: root, image: spec.image, sha, profile: input.profileName, echo: flags.echo });
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
    void cleanup().finally(() => process.exit(130));
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  try {
    run.say(`${spec.image} at ${shortSha(sha)} for ${platform}, profile ${input.profileName} (${profile.transport})`);

    const tag = await run.phase("hash", async () => {
      const hash = await treeHash(root, sha, {
        include: spec.tag_include,
        exclude: spec.tag_exclude,
        salt: `${platform}|${spec.dockerfile}|${spec.context}`,
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
      run.say(`dry run: would publish ${spec.image}:${tag}`);
      run.finish("dry-run");
      return run.record;
    }

    await run.phase("docker", async () => {
      if ((await exec(["docker", "info"])).code !== 0) throw new Error("docker is not running (start OrbStack or Docker Desktop)");
    });

    if (flags.push) registry = await run.phase("registry", () => openRegistry(profile));

    if (registry && (await registry.exists(spec.image, tag))) {
      run.say(`${tag} is already in the registry, build skipped`);
      if (flags.retag) await run.phase("retag", () => registry!.tag(spec.image, tag, "prod"));
      run.finish("skipped");
      run.say(`deploy image: ${pullRef}`);
      return run.record;
    }

    workDir = mkdtempSync(join(tmpdir(), "ci-local-"));
    const ctx = join(workDir, "ctx");
    mkdirSync(ctx);
    await run.phase("extract", () => archiveTo(root, sha, ctx));

    localTag = `ci-local/${spec.image}:${tag}`;
    await run.phase("build", async () => {
      // Re-checking the extracted files closes any gap between the committed blobs the guard read and what the build sees.
      for (const file of [spec.build_env, spec.build_args_file]) {
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
          ...buildArgs,
          "-t", localTag as string,
          "--load",
          within(ctx, spec.context),
        ],
        { onLine },
      );
      if (r.code !== 0) throw new Error(withProxyHint(`docker build exited ${r.code}`, r.out + r.err));
    });

    if (registry) {
      const tarball = join(workDir, "image.tar");
      await run.phase("save", async () => {
        await must(["docker", "save", "-o", tarball, localTag as string]);
      });
      await run.phase("push", async () => {
        await registry!.push(tarball, spec.image, tag);
      });
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
