import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve, sep } from "node:path";

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
  } catch {
    throw new Error(`${rel} is not in the commit`);
  }
  if (real !== root && !real.startsWith(`${root}${sep}`)) throw new Error(`${rel} resolves outside the repository`);
  return real;
}

// On a case-insensitive disk, tar can overwrite one committed name with another, so the file that
// reaches the build may differ from the blob that was checked.
export function readExtractedFile(base: string, rel: string): string {
  const real = within(base, rel);
  if (lstatSync(join(base, rel)).isSymbolicLink() || !lstatSync(real).isFile()) throw new Error(`${rel} must be a regular file after extraction`);
  return readFileSync(real, "utf8");
}
