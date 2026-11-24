import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stateHome } from "./store.ts";

/** Images building at once on this machine, across every ci-local process: several pushes at once overloaded it. */
export const MACHINE_IMAGE_SLOTS = 3;

const POLL_MS = 500;
// A slot folder is made before its pid file is written; a younger one is still being claimed, not abandoned.
const CLAIM_GRACE_MS = 5_000;

const slotsDir = (): string => join(stateHome(), "slots");

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

function tryClaim(path: string): boolean {
  try {
    mkdirSync(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    return false;
  }
  writeFileSync(join(path, "pid"), String(process.pid));
  return true;
}

// A process killed with SIGKILL never releases, so a slot whose owner is gone is taken back.
function reclaimIfAbandoned(path: string): void {
  let owner = Number.NaN;
  try {
    owner = Number(readFileSync(join(path, "pid"), "utf8"));
  } catch {
    try {
      if (Date.now() - statSync(path).mtimeMs < CLAIM_GRACE_MS) return;
    } catch {
      return;
    }
  }
  if (!alive(owner)) rmSync(path, { recursive: true, force: true });
}

/** Waits for one of the machine's image slots and returns the function that gives it back. */
export async function acquireImageSlot(onWait?: () => void, slots = MACHINE_IMAGE_SLOTS): Promise<() => void> {
  mkdirSync(slotsDir(), { recursive: true });
  let announced = false;
  for (;;) {
    for (let i = 0; i < slots; i++) {
      const path = join(slotsDir(), `slot-${i}`);
      reclaimIfAbandoned(path);
      if (tryClaim(path)) return () => rmSync(path, { recursive: true, force: true });
    }
    if (!announced) {
      announced = true;
      onWait?.();
    }
    await Bun.sleep(POLL_MS);
  }
}
