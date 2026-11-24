import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checksFor, runChecks } from "./checks.ts";
import { guardBuildEnv, parseEnvLines } from "./envguard.ts";
import { parseDockerCpus, SHARED_JOB_GONE, withProxyHint } from "./docker.ts";
import { exec, has, inChildGroup, killChildren, must, setProxyMode } from "./exec.ts";
import { archiveTo, committedFile, isCommitted, shortSha, treeHash } from "./git.ts";
import { placeFile, readExtractedFile, within } from "./paths.ts";
import { openRegistry, type Registry } from "./registry.ts";
import { recompressLayers } from "./recompress.ts";
import { markPublished, publishKey, wasPublished } from "./published.ts";
import { acquirePool, IMAGES_AT_ONCE, pruneIdleTagPools } from "./queue.ts";
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
  /** Put before every echoed line when several images run at once. */
  echoPrefix?: string;
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
  publicJwtKeys: string[];
  checks: Check[];
  flags: RunFlags;
}

// Each image gets its own child group, so cancelling one image's build never stops another image running beside it.
export function runImage(input: RunInput): Promise<RunRecord> {
  return inChildGroup(() => runImageInGroup(input));
}

async function runImageInGroup(input: RunInput): Promise<RunRecord> {
  const { root, sha, spec, profile, flags } = input;
  const run = RunHandle.create({ repo_path: root, image: spec.image, sha, profile: input.profileName, echo: flags.echo, prefix: flags.echoPrefix, ref: flags.ref, trigger: flags.trigger });
  setProxyMode(profile.proxy === "inherit");
  const platform = flags.platform ?? spec.platform ?? profile.platform ?? "linux/amd64";
  let registry: Registry | undefined;
  let workDir: string | undefined;
  let localTag: string | undefined;
  let cleaned = false;
  // Ends a wait for a share of the docker CPUs when the image fails before its build gets one.
  const queueAbort = new AbortController();
  const queuedAt = Date.parse(run.record.started);
  const gives: Array<() => void> = [];
  const giveAll = (): void => {
    for (const give of gives.splice(0).reverse()) give();
  };
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
    queueAbort.abort();
    giveAll();
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
      const problems = guardBuildEnv(localEnv, input.publicPrefixes, spec.build_env_local, input.publicJwtKeys);
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
        problems.push(...guardBuildEnv(await committedFile(root, sha, file), input.publicPrefixes, file, input.publicJwtKeys));
      }
      if (problems.length) throw new Error(`refusing to build:\n${problems.join("\n")}`);
    });

    const key = publishKey(spec.image, tag);
    if (!flags.dry) {
      pruneIdleTagPools();
      // Two pushes of the same image content would build and upload it twice. The second waits for the first and then finds the tag in the registry.
      gives.push(
        await run.phase("queue tag", () =>
          acquirePool({
            pool: `tag-${key}`,
            label: `${spec.image}:${tag}`,
            weight: 1,
            capacity: 1,
            queuedAt,
            signal: queueAbort.signal,
            onWait: (s) => run.say(`${spec.image} with this content is already being built by another run (${s.holders.join(", ")}), waiting for it instead of building it again`),
          }),
        ),
      );
      // However many pushes are running, only this many images are in flight on the machine; the rest wait here, in the order they began.
      gives.push(
        await run.phase("queue image", () =>
          acquirePool({
            pool: "images",
            label: spec.image,
            weight: 1,
            capacity: IMAGES_AT_ONCE,
            queuedAt,
            signal: queueAbort.signal,
            onWait: (s) => run.say(`image queue: place ${s.position}, ${s.used} of ${s.capacity} image slots in use by ${s.holders.join(", ") || "nobody"}`),
          }),
        ),
      );
    }

    if (flags.dry) {
      const guards = checksFor(input.checks, spec.name);
      if (guards.length && !flags.noChecks) run.say(`dry run: would run checks ${guards.map((c) => c.name).join(", ")}`);
      run.say(`dry run: would publish ${spec.image}:${tag}`);
      run.finish("dry-run");
      return run.record;
    }

    const zstd = flags.push && spec.compression === "zstd";
    const ociDir = () => join(workDir as string, "image-oci");
    if (!zstd) localTag = `ci-local/${spec.image}:${tag}`;

    const checkDocker = () =>
      run.phase("docker", async () => {
        if ((await exec(["docker", "info"])).code !== 0) throw new Error("docker is not running (start OrbStack or Docker Desktop)");
        if (spec.compression === "zstd" && flags.push && !has("zstd")) throw new Error("zstd is not installed (brew install zstd)");
      });

    // Extracts, builds and, when pushing, turns the image into the artifact the registry takes; nothing here needs the registry.
    const packageImage = async (): Promise<string> => {
      workDir = mkdtempSync(join(tmpdir(), "ci-local-"));
      const ctx = join(workDir, "ctx");
      mkdirSync(ctx);
      await run.phase("extract", async () => {
        await archiveTo(root, sha, ctx);
        if (spec.build_env_local && localEnv !== undefined) placeFile(ctx, spec.build_env_local, localEnv);
      });

      // The image is exported as an OCI layout and recompressed, so it is never loaded into the local daemon.
      // The docker VM has a few CPUs for every image of every push; builds that share them finish far later than one after another.
      const cpus = parseDockerCpus((await exec(["docker", "info", "--format", "{{.NCPU}}"])).out);
      const give = await run.phase("queue build", () =>
        acquirePool({
          pool: "build",
          label: spec.image,
          weight: spec.weight,
          capacity: cpus,
          queuedAt,
          signal: queueAbort.signal,
          onWait: (s) => run.say(`build queue: place ${s.position}, ${s.used} of ${s.capacity} docker CPUs in use by ${s.holders.join(", ") || "nobody"}${s.ahead.length ? `, ahead: ${s.ahead.join(", ")}` : ""}`),
        }),
      );
      try {
        await run.phase("build", async () => {
          // Re-checking the extracted files closes any gap between the committed blobs the guard read and what the build sees.
          for (const file of [spec.build_env, spec.build_env_local, spec.build_args_file]) {
            if (!file) continue;
            const problems = guardBuildEnv(readExtractedFile(ctx, file), input.publicPrefixes, file, input.publicJwtKeys);
            if (problems.length) throw new Error(`refusing to build:\n${problems.join("\n")}`);
          }
          const buildArgs: string[] = [];
          if (spec.build_args_file) {
            for (const { key, value } of parseEnvLines(readExtractedFile(ctx, spec.build_args_file))) buildArgs.push("--build-arg", `${key}=${value}`);
          }
          const buildCommand = [
            "docker", "buildx", "build",
            "--platform", platform,
            "--provenance=false", "--sbom=false", "--progress=plain",
            "-f", within(ctx, spec.dockerfile),
            ...(spec.target ? ["--target", spec.target] : []),
            ...buildArgs,
            ...(zstd ? ["--output", `type=oci,tar=false,dest=${ociDir()},compression=uncompressed,force-compression=true`] : ["-t", localTag as string, "--load"]),
            within(ctx, spec.context),
          ];
          let r = await exec(buildCommand, { onLine });
          // buildkit shares a step between builds that run together, so one cancelled by a failed check can take the step down with it.
          if (r.code !== 0 && SHARED_JOB_GONE.test(r.out + r.err)) {
            run.say("buildkit lost a step shared with a cancelled build, building again");
            await Bun.sleep(3000);
            r = await exec(buildCommand, { onLine });
          }
          if (r.code !== 0) throw new Error(withProxyHint(`docker build exited ${r.code}`, r.out + r.err));
        });
      } finally {
        give();
      }

      if (!flags.push) return "";
      if (zstd) {
        await run.phase("compress", async () => {
          const stats = await recompressLayers(ociDir(), spec.zstd_level, zstdCacheDir(), onLine);
          run.say(`compressed to zstd-${spec.zstd_level}: ${stats.compressed} layers compressed, ${stats.cached} reused, ${Math.round(stats.before / 1e6)} MB -> ${Math.round(stats.after / 1e6)} MB`);
        });
        return ociDir();
      }
      const tarball = join(workDir, "image.tar");
      await run.phase("save", async () => {
        await must(["docker", "save", "-o", tarball, localTag as string]);
      });
      return tarball;
    };

    // Opt-in: the build uses this machine's docker, not the checks' resources, so it can run while they do.
    // Pushing still waits for every check, and a failed check stops the build.
    const guards = flags.noChecks ? [] : checksFor(input.checks, spec.name);
    let building: Promise<string> | undefined;
    // A tag another run has already published only needs the registry to confirm it, so the build is not started ahead of the checks.
    if (spec.build_during_checks && guards.length > 0 && !wasPublished(key)) {
      building = (async () => {
        await checkDocker();
        return packageImage();
      })();
      building.catch(() => {});
    }
    const stopBuilding = async () => {
      if (!building) return;
      queueAbort.abort();
      killChildren();
      await building.catch(() => {});
    };

    // Without the overlap this runs before docker and the tunnel are opened, so a long test run never holds a connection idle.
    if (!flags.noChecks) {
      try {
        await runChecks(run, root, sha, input.checks, spec.name);
      } catch (e) {
        await stopBuilding();
        throw e;
      }
    }

    if (!building) await checkDocker();

    if (flags.push) registry = await run.phase("registry", () => openRegistry(profile));

    if (registry && (await registry.exists(spec.image, tag))) {
      await stopBuilding();
      run.say(`${tag} is already in the registry, build skipped`);
      run.set({ pushed: true });
      markPublished(key);
      if (flags.retag) await run.phase("retag", () => registry!.tag(spec.image, tag, "prod"));
      run.finish("skipped");
      run.say(`deploy image: ${pullRef}`);
      return run.record;
    }

    const artifact = await (building ?? packageImage());

    if (registry) {
      await run.phase("push", async () => {
        await registry!.push(artifact, spec.image, tag, { onLine, onProgress: (push) => run.set({ push }) });
      });
      run.set({ pushed: true });
      markPublished(key);
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
    queueAbort.abort();
    giveAll();
    await cleanup();
  }
}
