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
  build_args_file?: string;
  /** Checked but never passed: the Dockerfile reads this file itself. */
  build_env?: string;
  build_env_local?: string;
  tag_include: string[];
  tag_exclude: string[];
}

export interface RepoConfig {
  version: 1;
  profile?: string;
  profiles: Record<string, Profile>;
  branches: string[];
  public_prefixes: string[];
  images: ImageSpec[];
}

export type RunStatus = "running" | "success" | "skipped" | "failed" | "dry-run" | "interrupted";

export interface PhaseRecord {
  name: string;
  status: "running" | "done" | "failed";
  started: string;
  ended?: string;
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
  pid?: number;
  ref?: string;
  trigger?: "hook" | "manual";
}
