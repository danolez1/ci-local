import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { PhaseRecord, RunRecord, RunStatus } from "./types.ts";

export function stateHome(): string {
  return process.env.CI_LOCAL_STATE_DIR ?? join(homedir(), ".local", "state", "ci-local");
}

const runsDir = (): string => join(stateHome(), "runs");

// The suffix keeps two runs of the same image started in one second from sharing a directory.
const stamp = (d: Date): string => `${d.toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-")}-${Math.random().toString(16).slice(2, 6)}`;

export class RunHandle {
  readonly dir: string;
  constructor(public record: RunRecord, private echo: boolean) {
    this.dir = join(runsDir(), record.id);
    mkdirSync(this.dir, { recursive: true });
    this.save();
  }

  static create(init: { repo_path: string; image: string; sha: string; profile: string; echo: boolean }): RunHandle {
    const repo = basename(init.repo_path);
    const now = new Date();
    const record: RunRecord = {
      id: `${stamp(now)}-${repo}-${init.image.split("/").pop()}`,
      repo,
      repo_path: init.repo_path,
      image: init.image,
      sha: init.sha,
      profile: init.profile,
      status: "running",
      started: now.toISOString(),
      phases: [],
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
    if (this.echo) process.stderr.write(`${line}\n`);
  }

  say(line: string): void {
    this.log(`ci-local: ${line}`);
  }

  async phase<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const phase: PhaseRecord = { name, status: "running", started: new Date().toISOString() };
    this.record.phases.push(phase);
    this.save();
    try {
      const result = await fn();
      phase.status = "done";
      return result;
    } catch (e) {
      phase.status = "failed";
      throw e;
    } finally {
      phase.ended = new Date().toISOString();
      this.save();
    }
  }

  set(patch: Partial<Pick<RunRecord, "tag" | "pull_ref">>): void {
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

export function listRuns(limit = 20): RunRecord[] {
  if (!existsSync(runsDir())) return [];
  const ids = readdirSync(runsDir()).sort().reverse().slice(0, limit);
  const out: RunRecord[] = [];
  for (const id of ids) {
    const rec = readRun(id);
    if (rec) out.push(rec);
  }
  return out;
}

export function readRun(id: string): RunRecord | null {
  if (!/^[\w.-]+$/.test(id)) return null;
  try {
    return JSON.parse(readFileSync(join(runsDir(), id, "run.json"), "utf8")) as RunRecord;
  } catch {
    return null;
  }
}

export function readLog(id: string, offset = 0): { text: string; next: number } {
  if (!/^[\w.-]+$/.test(id)) return { text: "", next: 0 };
  try {
    const buf = readFileSync(join(runsDir(), id, "log.txt"));
    return { text: buf.subarray(offset).toString("utf8"), next: buf.length };
  } catch {
    return { text: "", next: 0 };
  }
}

export function latestRunId(): string | null {
  return listRuns(1)[0]?.id ?? null;
}
