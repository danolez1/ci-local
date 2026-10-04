import { appendFileSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { PhaseRecord, RunRecord, RunStatus } from "./types.ts";

export function stateHome(): string {
  return process.env.CI_LOCAL_STATE_DIR ?? join(homedir(), ".local", "state", "ci-local");
}

const runsDir = (): string => join(stateHome(), "runs");
const SAFE_ID = /^[\w.-]+$/;

// A repo or image name with a space or quote would produce an id the page and CLI refuse to open.
const slug = (v: string): string => v.replace(/[^\w.-]/g, "_");

// The suffix keeps two runs of the same image started in one second from sharing a directory.
const stamp = (d: Date): string => `${d.toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-")}-${Math.random().toString(16).slice(2, 6)}`;

interface RunInit {
  repo_path: string;
  image: string;
  sha: string;
  profile: string;
  echo: boolean;
  ref?: string;
  trigger?: "hook" | "manual";
}

export class RunHandle {
  readonly dir: string;
  constructor(public record: RunRecord, private echo: boolean) {
    this.dir = join(runsDir(), record.id);
    mkdirSync(this.dir, { recursive: true });
    this.save();
  }

  static create(init: RunInit): RunHandle {
    const repo = basename(init.repo_path);
    const now = new Date();
    const record: RunRecord = {
      id: `${stamp(now)}-${slug(repo)}-${slug(init.image.split("/").pop() ?? init.image)}`,
      repo,
      repo_path: init.repo_path,
      image: init.image,
      sha: init.sha,
      profile: init.profile,
      status: "running",
      started: now.toISOString(),
      phases: [],
      pid: process.pid,
      ref: init.ref,
      trigger: init.trigger,
    };
    return new RunHandle(record, init.echo);
  }

  private save(): void {
    const file = join(this.dir, "run.json");
    // Rename keeps a reader from seeing a half-written record.
    writeFileSync(`${file}.tmp`, JSON.stringify(this.record, null, 2));
    renameSync(`${file}.tmp`, file);
  }

  log(line: string): void {
    appendFileSync(join(this.dir, "log.txt"), `${line}\n`);
    if (!this.echo) return;
    if (line.startsWith("##[group]")) process.stderr.write(`==> ${line.slice(9)}\n`);
    else if (!line.startsWith("##[endgroup]")) process.stderr.write(`${line}\n`);
  }

  say(line: string): void {
    this.log(`ci-local: ${line}`);
  }

  async phase<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const phase: PhaseRecord = { name, status: "running", started: new Date().toISOString() };
    this.record.phases.push(phase);
    this.save();
    this.log(`##[group]${name}`);
    try {
      const result = await fn();
      phase.status = "done";
      return result;
    } catch (e) {
      phase.status = "failed";
      throw e;
    } finally {
      phase.ended = new Date().toISOString();
      this.log("##[endgroup]");
      this.save();
    }
  }

  set(patch: Partial<Pick<RunRecord, "tag" | "pull_ref" | "pushed" | "push">>): void {
    Object.assign(this.record, patch);
    this.save();
  }

  finish(status: RunStatus, error?: string): void {
    this.record.status = status;
    this.record.ended = new Date().toISOString();
    if (error) this.record.error = error;
    this.save();
  }
}

// EPERM means the pid now belongs to another user's process, so this run's process is gone.
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// A run whose process was killed never wrote a final status, so "running" would be shown forever.
function withLiveness(rec: RunRecord): RunRecord {
  if (rec.status === "running" && rec.pid !== undefined && !pidAlive(rec.pid)) return { ...rec, status: "interrupted" };
  return rec;
}

export function readRun(id: string): RunRecord | null {
  if (!SAFE_ID.test(id)) return null;
  try {
    return withLiveness(JSON.parse(readFileSync(join(runsDir(), id, "run.json"), "utf8")) as RunRecord);
  } catch {
    return null;
  }
}

// Finished runs never change, so they are parsed once; only running ones are re-read on each query.
const finished = new Map<string, RunRecord>();

function allRuns(): RunRecord[] {
  if (!existsSync(runsDir())) return [];
  const out: RunRecord[] = [];
  for (const id of readdirSync(runsDir()).sort().reverse()) {
    const cached = finished.get(id);
    if (cached) {
      out.push(cached);
      continue;
    }
    const rec = readRun(id);
    if (!rec) continue;
    if (rec.status !== "running") finished.set(id, rec);
    out.push(rec);
  }
  return out;
}

export function listRuns(limit = 20): RunRecord[] {
  return allRuns().slice(0, limit);
}

export function latestRunId(): string | null {
  return listRuns(1)[0]?.id ?? null;
}

export interface RunQuery {
  page?: number;
  perPage?: number;
  status?: string;
  repo?: string;
  image?: string;
  q?: string;
}

export interface RunPage {
  items: RunRecord[];
  total: number;
  page: number;
  pages: number;
  perPage: number;
  counts: Record<string, number>;
  repos: Array<{ name: string; count: number; images: Array<{ name: string; count: number }> }>;
}

export function queryRuns(query: RunQuery): RunPage {
  const perPage = Math.min(Math.max(query.perPage ?? 25, 1), 100);
  const needle = query.q?.trim().toLowerCase();
  const all = allRuns();
  const byRepo = all.filter((r) => (!query.repo || r.repo === query.repo) && (!query.image || r.image === query.image));
  const matched = needle ? byRepo.filter((r) => `${r.image} ${r.repo} ${r.sha} ${r.tag ?? ""} ${r.ref ?? ""}`.toLowerCase().includes(needle)) : byRepo;

  // Counts ignore the status filter so the filter menu can show how many runs each status would give.
  const counts: Record<string, number> = {};
  for (const r of matched) counts[r.status] = (counts[r.status] ?? 0) + 1;
  const filtered = query.status ? matched.filter((r) => r.status === query.status) : matched;

  const repoCounts = new Map<string, Map<string, number>>();
  for (const r of all) {
    const images = repoCounts.get(r.repo) ?? new Map<string, number>();
    images.set(r.image, (images.get(r.image) ?? 0) + 1);
    repoCounts.set(r.repo, images);
  }

  const pages = Math.max(1, Math.ceil(filtered.length / perPage));
  const page = Math.min(Math.max(query.page ?? 1, 1), pages);
  return {
    items: filtered.slice((page - 1) * perPage, page * perPage),
    total: filtered.length,
    page,
    pages,
    perPage,
    counts,
    repos: [...repoCounts]
      .map(([name, images]) => ({
        name,
        count: [...images.values()].reduce((n, c) => n + c, 0),
        images: [...images].map(([image, count]) => ({ name: image, count })).sort((a, b) => a.name.localeCompare(b.name)),
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}

export interface RunStats {
  total: number;
  success: number;
  failed: number;
  successRate: number | null;
  medianSeconds: number | null;
  perRepo: Array<{ repo: string; image: string; last: RunRecord; total: number; failed: number }>;
}

const seconds = (r: RunRecord): number | null => (r.ended ? (new Date(r.ended).getTime() - new Date(r.started).getTime()) / 1000 : null);

export function runStats(): RunStats {
  const all = allRuns().filter((r) => r.status !== "dry-run");
  const done = all.filter((r) => r.status === "success" || r.status === "failed");
  const durations = all.filter((r) => r.status === "success").map(seconds).filter((s): s is number => s !== null).sort((a, b) => a - b);
  const byImage = new Map<string, RunRecord[]>();
  for (const r of all) byImage.set(r.image, [...(byImage.get(r.image) ?? []), r]);
  return {
    total: all.length,
    success: all.filter((r) => r.status === "success").length,
    failed: all.filter((r) => r.status === "failed").length,
    successRate: done.length ? done.filter((r) => r.status === "success").length / done.length : null,
    medianSeconds: durations.length ? (durations[Math.floor(durations.length / 2)] as number) : null,
    perRepo: [...byImage].map(([image, runs]) => ({
      repo: (runs[0] as RunRecord).repo,
      image,
      last: runs[0] as RunRecord,
      total: runs.length,
      failed: runs.filter((r) => r.status === "failed").length,
    })),
  };
}

/** Reads one slice of a log so a poll of a large log does not re-read the whole file. */
export function logPath(id: string): string | null {
  return SAFE_ID.test(id) ? join(runsDir(), id, "log.txt") : null;
}

const MAX_CHUNK = 1_048_576;

export function readLog(id: string, offset = 0, limit = 262_144): { text: string; next: number; size: number } {
  if (!SAFE_ID.test(id)) return { text: "", next: 0, size: 0 };
  limit = Math.min(Math.max(limit, 0), MAX_CHUNK);
  let fd: number | undefined;
  try {
    fd = openSync(join(runsDir(), id, "log.txt"), "r");
    const size = fstatSync(fd).size;
    const start = Math.min(Math.max(offset, 0), size);
    const length = Math.min(limit, size - start);
    const buf = Buffer.alloc(length);
    readSync(fd, buf, 0, length, start);
    // Cut at the last newline so a multi-byte character or a line is never split across two reads.
    const cut = start + length < size ? buf.lastIndexOf(10) + 1 || length : length;
    return { text: buf.subarray(0, cut).toString("utf8"), next: start + cut, size };
  } catch {
    return { text: "", next: 0, size: 0 };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
