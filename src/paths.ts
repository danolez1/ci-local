import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";

/** Config paths come from the repo being built, so they must stay inside it. */
export function isSafeRelative(path: string): boolean {
  if (path === "" || path.startsWith("/") || path.includes("\\") || path.includes("\0")) return false;
  const segments = path.split("/");
  return !segments.includes("..") && !segments.includes("");
}

// realpath follows symlinks committed into the archive, which a lexical check alone would miss.
export function within(base: string, rel: string): string {
  const root = realpathSync(base);
  let real: string;
  try {
    real = realpathSync(resolve(root, rel));
  } catch (e) {
    throw new Error((e as NodeJS.ErrnoException).code === "ENOENT" ? `${rel} does not exist` : `${rel} cannot be read (${(e as NodeJS.ErrnoException).code})`);
  }
  if (real !== root && !real.startsWith(`${root}${sep}`)) throw new Error(`${rel} resolves outside the repository`);
  return real;
}

// On a case-insensitive disk, tar can overwrite one committed name with another, so the file that
// reaches the build may differ from the blob that was checked.
export function readExtractedFile(base: string, rel: string): string {
  const real = within(base, rel);
  if (lstatSync(join(base, rel)).isSymbolicLink() || !lstatSync(real).isFile()) throw new Error(`${rel} must be a regular file`);
  return readFileSync(real, "utf8");
}

// Every directory on the way is checked because a committed symlink such as config -> /elsewhere would
// otherwise redirect the write, and the target is removed first so a symlinked file is replaced, not followed.
export function placeFile(base: string, rel: string, text: string): void {
  let dir = realpathSync(base);
  for (const part of dirname(rel).split("/").filter((p) => p !== ".")) {
    dir = join(dir, part);
    if (existsSync(dir) || lstatExists(dir)) {
      if (!lstatSync(dir).isDirectory()) throw new Error(`${rel} passes through ${part}, which is not a plain directory`);
    } else {
      mkdirSync(dir);
    }
  }
  const target = join(dir, basename(rel));
  if (lstatExists(target) && lstatSync(target).isDirectory()) throw new Error(`${rel} is a directory in the build context`);
  rmSync(target, { force: true });
  writeFileSync(target, text);
}

function lstatExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}
