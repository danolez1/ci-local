import { homedir } from "node:os";
import { join } from "node:path";
import { isSafeRelative } from "./paths.ts";
import { DEFAULT_ZSTD_LEVEL } from "./recompress.ts";
import type { Check, GlobalConfig, ImageSpec, Profile, RepoConfig, Transport } from "./types.ts";

export class ConfigError extends Error {
  constructor(public problems: string[]) {
    super(problems.join("\n"));
  }
}

const TRANSPORTS: Transport[] = ["ssh", "https", "direct"];
const DEFAULT_PREFIXES = ["NEXT_PUBLIC_", "VITE_", "PUBLIC_", "NUXT_PUBLIC_", "EXPO_PUBLIC_"];

function configHome(): string {
  return process.env.CI_LOCAL_CONFIG_DIR ?? join(homedir(), ".config", "ci-local");
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function str(v: unknown, where: string, problems: string[], required = false): string | undefined {
  if (v === undefined || v === null) {
    if (required) problems.push(`${where} is required`);
    return undefined;
  }
  if (typeof v !== "string" || v.trim() === "") {
    problems.push(`${where} must be a non-empty string`);
    return undefined;
  }
  return v;
}

function relPath(v: unknown, where: string, problems: string[]): string | undefined {
  const value = str(v, where, problems);
  if (value !== undefined && !isSafeRelative(value)) {
    problems.push(`${where} must be a path inside the repository (no leading /, no ..)`);
    return undefined;
  }
  return value;
}

// The name is passed to docker as an argument, so only what a Dockerfile stage name can hold is accepted.
function stageName(v: unknown, where: string, problems: string[]): string | undefined {
  const value = str(v, where, problems);
  if (value !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) {
    problems.push(`${where} must be a Dockerfile stage name (letters, digits, dot, dash, underscore)`);
    return undefined;
  }
  return value;
}

function oneOf<T extends string>(v: unknown, allowed: readonly T[], where: string, problems: string[]): T | undefined {
  const value = str(v, where, problems);
  if (value !== undefined && !allowed.includes(value as T)) {
    problems.push(`${where} must be one of ${allowed.join(", ")}`);
    return undefined;
  }
  return value as T | undefined;
}

function zstdLevel(v: unknown, where: string, problems: string[]): number | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > 22) {
    problems.push(`${where} must be a whole number from 1 to 22`);
    return undefined;
  }
  return v;
}

function parseChecks(raw: unknown, problems: string[]): Check[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    problems.push("checks must be a list");
    return [];
  }
  const seen = new Set<string>();
  const checks: Check[] = [];
  raw.forEach((item, i) => {
    const where = `checks[${i}]`;
    if (!isObj(item)) {
      problems.push(`${where} must be a mapping`);
      return;
    }
    const name = str(item.name, `${where}.name`, problems, true);
    const run = str(item.run, `${where}.run`, problems, true);
    const ttl = item.ttl_hours;
    if (ttl !== undefined && (typeof ttl !== "number" || !Number.isInteger(ttl) || ttl < 1)) problems.push(`${where}.ttl_hours must be a whole number of hours, 1 or more`);
    if (!name || !run) return;
    // The name becomes a file name for the stamp, so it stays plain.
    if (!/^[\w.-]+$/.test(name)) problems.push(`${where}.name may only use letters, digits, '.', '_' and '-'`);
    if (seen.has(name)) problems.push(`${where}.name '${name}' is used twice`);
    seen.add(name);
    checks.push({ name, run, ttl_hours: typeof ttl === "number" ? ttl : 0 });
  });
  return checks;
}

function strList(v: unknown, where: string, problems: string[]): string[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) {
    problems.push(`${where} must be a list of strings`);
    return [];
  }
  return v as string[];
}

function parseProfile(raw: unknown, where: string, problems: string[]): Profile | undefined {
  if (!isObj(raw)) {
    problems.push(`${where} must be a mapping`);
    return undefined;
  }
  const transport = str(raw.transport, `${where}.transport`, problems, true) as Transport | undefined;
  if (transport && !TRANSPORTS.includes(transport)) {
    problems.push(`${where}.transport must be one of ${TRANSPORTS.join(", ")}`);
  }
  const registry = str(raw.registry, `${where}.registry`, problems, true);
  const ssh_host = str(raw.ssh_host, `${where}.ssh_host`, problems);
  if (transport === "ssh" && !ssh_host) problems.push(`${where}.ssh_host is required for the ssh transport`);
  if (raw.proxy !== undefined && raw.proxy !== "none" && raw.proxy !== "inherit") problems.push(`${where}.proxy must be none or inherit`);
  if (ssh_host?.startsWith("-")) problems.push(`${where}.ssh_host must not start with a dash`);
  if (!transport || !registry) return undefined;
  return {
    transport,
    registry,
    ssh_host,
    insecure: raw.insecure === true,
    pull_registry: str(raw.pull_registry, `${where}.pull_registry`, problems),
    platform: str(raw.platform, `${where}.platform`, problems),
    proxy: raw.proxy === "inherit" ? "inherit" : "none",
  };
}

function parseProfiles(raw: unknown, where: string, problems: string[]): Record<string, Profile> {
  const out: Record<string, Profile> = {};
  if (raw === undefined || raw === null) return out;
  if (!isObj(raw)) {
    problems.push(`${where} must be a mapping of profile name to profile`);
    return out;
  }
  for (const [name, p] of Object.entries(raw)) {
    const parsed = parseProfile(p, `${where}.${name}`, problems);
    if (parsed) out[name] = parsed;
  }
  return out;
}

export function parseGlobalConfig(text: string): GlobalConfig {
  const problems: string[] = [];
  const raw: unknown = text.trim() === "" ? {} : Bun.YAML.parse(text);
  if (!isObj(raw)) throw new ConfigError(["config must be a mapping"]);
  const profiles = parseProfiles(raw.profiles, "profiles", problems);
  const default_profile = str(raw.default_profile, "default_profile", problems);
  if (default_profile && !profiles[default_profile]) problems.push(`default_profile '${default_profile}' is not defined in profiles`);
  if (problems.length) throw new ConfigError(problems);
  return { default_profile, profiles };
}

export function parseRepoConfig(text: string): RepoConfig {
  const problems: string[] = [];
  const raw: unknown = Bun.YAML.parse(text);
  if (!isObj(raw)) throw new ConfigError(["ci-local.yaml must be a mapping"]);
  if (raw.version !== 1) problems.push("version must be 1");

  const defaults = {
    dockerfile: relPath(raw.dockerfile, "dockerfile", problems) ?? "Dockerfile",
    context: relPath(raw.context, "context", problems) ?? ".",
    tag_exclude: strList(raw.tag_exclude, "tag_exclude", problems),
    tag_include: strList(raw.tag_include, "tag_include", problems),
  };

  const images: ImageSpec[] = [];
  if (!Array.isArray(raw.images) || raw.images.length === 0) {
    problems.push("images must be a non-empty list");
  } else {
    const seen = new Set<string>();
    raw.images.forEach((item, i) => {
      const where = `images[${i}]`;
      if (!isObj(item)) {
        problems.push(`${where} must be a mapping`);
        return;
      }
      const image = str(item.image, `${where}.image`, problems, true);
      const name = str(item.name, `${where}.name`, problems) ?? image?.split("/").pop();
      if (!image || !name) return;
      if (seen.has(name)) problems.push(`${where}.name '${name}' is used twice`);
      seen.add(name);
      if (item.build_env_local !== undefined && (item.build_env_local === item.build_env || item.build_env_local === item.build_args_file)) {
        problems.push(`${where}.build_env_local must be a different file from build_env and build_args_file`);
      }
      images.push({
        name,
        image,
        dockerfile: relPath(item.dockerfile, `${where}.dockerfile`, problems) ?? defaults.dockerfile,
        context: relPath(item.context, `${where}.context`, problems) ?? defaults.context,
        platform: str(item.platform, `${where}.platform`, problems),
        target: stageName(item.target, `${where}.target`, problems),
        build_args_file: relPath(item.build_args_file, `${where}.build_args_file`, problems),
        build_env: relPath(item.build_env, `${where}.build_env`, problems),
        build_env_local: relPath(item.build_env_local, `${where}.build_env_local`, problems),
        compression: oneOf(item.compression, ["gzip", "zstd"], `${where}.compression`, problems) ?? "gzip",
        zstd_level: zstdLevel(item.zstd_level, `${where}.zstd_level`, problems) ?? DEFAULT_ZSTD_LEVEL,
        tag_include: item.tag_include === undefined ? defaults.tag_include : strList(item.tag_include, `${where}.tag_include`, problems),
        tag_exclude: item.tag_exclude === undefined ? defaults.tag_exclude : strList(item.tag_exclude, `${where}.tag_exclude`, problems),
      });
    });
  }

  const branches = strList(raw.branches, "branches", problems);
  const prefixes = strList(raw.public_prefixes, "public_prefixes", problems);
  const jwtKeys = strList(raw.public_jwt_keys, "public_jwt_keys", problems);
  const checks = parseChecks(raw.checks, problems);
  if (problems.length) throw new ConfigError(problems);
  return {
    version: 1,
    profile: str(raw.profile, "profile", problems),
    profiles: parseProfiles(raw.profiles, "profiles", problems),
    branches: branches.length ? branches : ["main"],
    public_prefixes: prefixes.length ? prefixes : DEFAULT_PREFIXES,
    public_jwt_keys: jwtKeys,
    images,
    checks,
  };
}

export async function loadGlobalConfig(): Promise<GlobalConfig> {
  const file = Bun.file(join(configHome(), "config.yaml"));
  if (!(await file.exists())) return { profiles: {} };
  return parseGlobalConfig(await file.text());
}

export async function loadRepoConfig(root: string): Promise<RepoConfig | null> {
  const file = Bun.file(join(root, "ci-local.yaml"));
  if (!(await file.exists())) return null;
  return parseRepoConfig(await file.text());
}

export function resolveProfile(repo: RepoConfig, global: GlobalConfig, flag?: string): { name: string; profile: Profile } {
  const profiles = { ...global.profiles, ...repo.profiles };
  const name = flag ?? process.env.CI_LOCAL_PROFILE ?? repo.profile ?? global.default_profile;
  if (!name) throw new ConfigError(["no profile chosen: set `profile` in ci-local.yaml, default_profile in the global config, or pass --profile"]);
  const profile = profiles[name];
  if (!profile) throw new ConfigError([`profile '${name}' is not defined (known: ${Object.keys(profiles).join(", ") || "none"})`]);
  return { name, profile };
}
