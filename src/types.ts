export type Transport = "ssh" | "https" | "direct";

export interface Profile {
  transport: Transport;
  /** For ssh this is the address as seen from the ssh host, not from this machine. */
  registry: string;
  ssh_host?: string;
  insecure?: boolean;
  pull_registry?: string;
  platform?: string;
  proxy?: "none" | "inherit";
}

export interface GlobalConfig {
  default_profile?: string;
  profiles: Record<string, Profile>;
}

export interface ImageSpec {
  name: string;
  image: string;
  dockerfile: string;
  context: string;
  platform?: string;
  /** A Dockerfile stage to build, for several images from one Dockerfile; without it the last stage is built. */
  target?: string;
  build_args_file?: string;
  /** Checked but never passed: the Dockerfile reads this file itself. */
  build_env?: string;
  build_env_local?: string;
  /** zstd layers are about a third smaller than gzip ones; the registry's pull side needs Docker 23 or newer. */
  compression: "gzip" | "zstd";
  zstd_level: number;
  /** Build while the checks run instead of after them; the push still waits for every check. */
  build_during_checks: boolean;
  /** Docker CPUs the build needs to itself; the builds running side by side never add up to more than the daemon has. */
  weight: number;
  tag_include: string[];
  tag_exclude: string[];
}

export interface Check {
  name: string;
  /** A shell command run in the repository root, on this machine, before anything is built. */
  run: string;
  /** Hours a pass stays valid for the same tree; 0 means until the tree changes. */
  ttl_hours: number;
  /** Image names this check belongs to. Without it the check guards every image. */
  images?: string[];
}

export interface RepoConfig {
  version: 1;
  profile?: string;
  profiles: Record<string, Profile>;
  branches: string[];
  /** Caps the images of one push that are in flight; without it 3, the number the machine allows across all pushes. */
  concurrency?: number;
  public_prefixes: string[];
  public_jwt_keys: string[];
  images: ImageSpec[];
  checks: Check[];
}

export type RunStatus = "running" | "success" | "skipped" | "failed" | "dry-run" | "interrupted";

export interface PhaseRecord {
  name: string;
  status: "running" | "done" | "failed";
  started: string;
  ended?: string;
}

export interface PushProgress {
  /** Bytes uploaded so far; absent when the transport cannot be counted. */
  sent?: number;
  /** Bytes per second over the last few seconds. */
  rate?: number;
  blobs_done: number;
  blobs_total: number;
}

export interface RunRecord {
  id: string;
  repo: string;
  repo_path: string;
  image: string;
  sha: string;
  tag?: string;
  profile: string;
  status: RunStatus;
  started: string;
  ended?: string;
  phases: PhaseRecord[];
  error?: string;
  pull_ref?: string;
  /** True once the image is in the registry, so a local --no-push run never shows a deploy image. */
  pushed?: boolean;
  push?: PushProgress;
  pid?: number;
  ref?: string;
  trigger?: "hook" | "manual";
}
