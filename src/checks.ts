import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { exec } from "./exec.ts";
import { shortSha } from "./git.ts";
import { stateHome } from "./store.ts";
import type { RunHandle } from "./store.ts";
import type { Check } from "./types.ts";

interface Stamp {
  tree: string;
  command: string;
  at: number;
}

const digest = (text: string): string => createHash("sha256").update(text).digest("hex");

// One folder per repository, so two repos that name a check `test` never share a stamp.
const stampFile = (root: string, check: Check): string => join(stateHome(), "stamps", digest(root).slice(0, 16), `${check.name}.json`);

function readStamp(file: string): Stamp | null {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as Stamp;
  } catch {
    return null;
  }
}

async function git(root: string, ...args: string[]): Promise<string> {
  return (await exec(["git", "-C", root, ...args])).out.trim();
}

/**
 * Runs the repository's own checks (tests, scans) before anything is built, and stops the run when one fails.
 * A pass is remembered per tree, so pushing the same content again does not repeat it.
 */
export async function runChecks(run: RunHandle, root: string, sha: string, checks: Check[]): Promise<void> {
  if (checks.length === 0) return;
  const tree = await git(root, "rev-parse", `${sha}^{tree}`);
  // The commands read the working tree, so their result only vouches for the commit when it is what is checked out.
  const head = await git(root, "rev-parse", "HEAD");
  const clean = head === sha && (await git(root, "status", "--porcelain", "--untracked-files=no")) === "";

  for (const check of checks) {
    const file = stampFile(root, check);
    const command = digest(check.run);
    const stamp = readStamp(file);
    const fresh = stamp !== null && stamp.tree === tree && stamp.command === command && (check.ttl_hours === 0 || Date.now() - stamp.at < check.ttl_hours * 3_600_000);
    if (fresh) {
      run.say(`check ${check.name} already passed on this tree ${Math.round((Date.now() - (stamp as Stamp).at) / 60_000)} min ago, skipped`);
      continue;
    }
    await run.phase(`check ${check.name}`, async () => {
      const r = await exec(["bash", "-c", check.run], { cwd: root, onLine: (line) => run.log(line) });
      if (r.code !== 0) {
        rmSync(file, { force: true });
        throw new Error(`check ${check.name} failed (exit ${r.code}): ${check.run}`);
      }
    });
    if (clean) {
      mkdirSync(join(file, ".."), { recursive: true });
      writeFileSync(file, JSON.stringify({ tree, command, at: Date.now() } satisfies Stamp));
    } else {
      rmSync(file, { force: true });
      run.say(`check ${check.name} passed, but the working tree is not exactly ${shortSha(sha)}, so no stamp was recorded`);
    }
  }
}
