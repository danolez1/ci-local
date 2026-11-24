import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stateHome } from "./store.ts";

/** One request for part of a pool, waiting or holding. `weight` is in the pool's own unit (docker CPUs for builds). */
export interface Claim {
  pid: number;
  seq: number;
  label: string;
  weight: number;
  /** When the image's run began, so a push that started earlier is served earlier whichever stage it reaches first. */
  queuedAt: number;
}

export interface Standing {
  position: number;
  used: number;
  capacity: number;
  holders: string[];
  ahead: string[];
}

export interface PoolRequest {
  pool: string;
  label: string;
  weight: number;
  capacity: number;
  queuedAt: number;
  signal?: AbortSignal;
  /** Called when the place in line or the load ahead changes, not on every poll. */
  onWait?: (standing: Standing) => void;
}

/** Images in flight at once on the machine, across every push; more than this loads it past what the builds can use. */
export const IMAGES_AT_ONCE = 3;

const POLL_MS = 400;
const LOCK_STALE_MS = 10_000;

const poolDir = (pool: string): string => join(stateHome(), "queue", pool);
const waitingDir = (pool: string): string => join(poolDir(pool), "waiting");
const holdingDir = (pool: string): string => join(poolDir(pool), "holding");
const fileName = (seq: number): string => `${String(seq).padStart(12, "0")}.json`;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

// A process killed with SIGKILL never gives anything back, so claims of dead processes are dropped wherever they are read.
function readClaims(dir: string): Claim[] {
  const claims: Claim[] = [];
  for (const name of readdirSync(dir)) {
    try {
      const claim = JSON.parse(readFileSync(join(dir, name), "utf8")) as Claim;
      if (alive(claim.pid)) claims.push(claim);
      else rmSync(join(dir, name), { force: true });
    } catch {
      // Another process removed it between the listing and the read.
    }
  }
  return claims;
}

function breakStaleLock(lock: string): void {
  try {
    const owner = Number(readFileSync(join(lock, "pid"), "utf8"));
    if (!alive(owner)) rmSync(lock, { recursive: true, force: true });
  } catch {
    try {
      if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) rmSync(lock, { recursive: true, force: true });
    } catch {
      // Released meanwhile.
    }
  }
}

// Every change to a pool happens under this lock, which is held for a few file operations, so order and load are exact.
async function locked<T>(pool: string, fn: () => T): Promise<T> {
  mkdirSync(waitingDir(pool), { recursive: true });
  mkdirSync(holdingDir(pool), { recursive: true });
  const lock = join(poolDir(pool), "lock");
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      breakStaleLock(lock);
      await Bun.sleep(5);
    }
  }
  try {
    writeFileSync(join(lock, "pid"), String(process.pid));
    return fn();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

const serve = (a: Claim, b: Claim): number => a.queuedAt - b.queuedAt || a.seq - b.seq;

function takeNumber(pool: string): number {
  const file = join(poolDir(pool), "seq");
  let last = 0;
  try {
    last = Number(readFileSync(file, "utf8")) || 0;
  } catch {
    // First claim on this pool.
  }
  writeFileSync(file, String(last + 1));
  return last + 1;
}

/**
 * Waits for `weight` of the pool's `capacity` and returns the function that gives it back. Claims are served in order of
 * `queuedAt` and then arrival, and only the first in line may start, even when a lighter one behind it would fit: a build
 * that needs the whole machine is never starved by a stream of small ones, and the order the pushes began in is kept.
 */
export async function acquirePool(req: PoolRequest): Promise<() => void> {
  const weight = Math.min(Math.max(1, Math.floor(req.weight)), Math.max(1, Math.floor(req.capacity)));
  const mine = await locked(req.pool, (): Claim => {
    const claim = { pid: process.pid, seq: takeNumber(req.pool), label: req.label, weight, queuedAt: req.queuedAt };
    writeFileSync(join(waitingDir(req.pool), fileName(claim.seq)), JSON.stringify(claim));
    return claim;
  });
  const give = (): void => rmSync(join(holdingDir(req.pool), fileName(mine.seq)), { force: true });
  let announced = "";
  try {
    for (;;) {
      if (req.signal?.aborted) throw new Error(`gave up waiting for ${req.pool}`);
      const standing = await locked(req.pool, (): Standing | null => {
        const holders = readClaims(holdingDir(req.pool));
        const waiting = readClaims(waitingDir(req.pool)).sort(serve);
        const used = holders.reduce((sum, c) => sum + c.weight, 0);
        const position = waiting.findIndex((c) => c.seq === mine.seq) + 1;
        if (position === 0) throw new Error(`the ${req.pool} queue lost the claim of ${req.label}`);
        if (position === 1 && used + weight <= req.capacity) {
          renameSync(join(waitingDir(req.pool), fileName(mine.seq)), join(holdingDir(req.pool), fileName(mine.seq)));
          return null;
        }
        return { position, used, capacity: req.capacity, holders: holders.map((c) => c.label), ahead: waiting.slice(0, position - 1).map((c) => c.label) };
      });
      if (!standing) return give;
      const key = `${standing.position}/${standing.holders.join(",")}`;
      if (key !== announced) {
        announced = key;
        req.onWait?.(standing);
      }
      await Bun.sleep(POLL_MS);
    }
  } catch (e) {
    rmSync(join(waitingDir(req.pool), fileName(mine.seq)), { force: true });
    throw e;
  }
}

/** Holds a share of the pool while fn runs. */
export async function withPool<T>(req: PoolRequest, fn: () => Promise<T>): Promise<T> {
  const release = await acquirePool(req);
  try {
    return await fn();
  } finally {
    release();
  }
}

/** Every pool's holders and waiting claims in the order they will be served, for `ci-local queue`. */
export function queueSnapshot(): Array<{ pool: string; holders: Claim[]; waiting: Claim[] }> {
  const root = join(stateHome(), "queue");
  let pools: string[] = [];
  try {
    pools = readdirSync(root);
  } catch {
    return [];
  }
  return pools.map((pool) => ({ pool, holders: readClaims(holdingDir(pool)), waiting: readClaims(waitingDir(pool)).sort(serve) }));
}
