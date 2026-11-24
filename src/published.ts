import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stateHome } from "./store.ts";

const publishedDir = (): string => join(stateHome(), "published");
const KEEP_MS = 7 * 24 * 3_600_000;

/** One key for an image and tag, so two pushes of the same content find the same lock and the same marker. */
export const publishKey = (image: string, tag: string): string => createHash("sha256").update(`${image}\0${tag}`).digest("hex").slice(0, 16);

/** Records that some run has put this tag in the registry, so a later run does not start building it ahead of its checks. */
export function markPublished(key: string): void {
  mkdirSync(publishedDir(), { recursive: true });
  writeFileSync(join(publishedDir(), key), String(Date.now()));
  for (const name of readdirSync(publishedDir())) {
    try {
      if (Date.now() - statSync(join(publishedDir(), name)).mtimeMs > KEEP_MS) rmSync(join(publishedDir(), name), { force: true });
    } catch {
      // Removed by another run.
    }
  }
}

/** A marker only saves a build; the registry still decides whether the tag is there, so a pruned tag is built again. */
export function wasPublished(key: string): boolean {
  try {
    return Date.now() - Number(readFileSync(join(publishedDir(), key), "utf8")) < KEEP_MS;
  } catch {
    return false;
  }
}
