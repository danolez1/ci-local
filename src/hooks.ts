import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { exec } from "./exec.ts";

export type HookKind = "husky" | "githooks" | "git";

const OPEN = "# >>> ci-local (keep as the last step of this hook) >>>";
const CLOSE = "# <<< ci-local <<<";
// Hooks written before the refs block was dropped still carry it; removing it keeps reinstalls clean.
const LEGACY_OPEN = "# >>> ci-local refs >>>";
const LEGACY_CLOSE = "# <<< ci-local refs <<<";

// A hook that already read git's stdin leaves it empty, so a `refs` variable (the husky convention) is
// replayed when present and ci-local falls back to the checked-out branch otherwise.
const BLOCK = `${OPEN}
if command -v ci-local >/dev/null 2>&1; then
  if [ -n "\${refs:-}" ]; then
    printf '%s\\n' "$refs" | ci-local hook pre-push "$@" || exit 1
  else
    ci-local hook pre-push "$@" || exit 1
  fi
else
  echo "ci-local: not installed, image not built" >&2
fi
${CLOSE}`;

const SHELL_SHEBANG = /^#!\s*(\/usr\/bin\/env\s+)?(\S*\/)?(sh|bash|zsh|dash|ash)(\s|$)/;

interface HookTarget {
  kind: HookKind;
  file: string;
  /** True when core.hooksPath already points at the directory, so git config must not be rewritten. */
  configured: boolean;
}

/** Where the pre-push hook lives for this clone, following core.hooksPath the way git does. */
export async function findHookTarget(root: string, kind?: HookKind): Promise<HookTarget> {
  const configured = (await exec(["git", "-C", root, "config", "--get", "core.hooksPath"])).out.trim();
  if (kind === "husky" || (!kind && /(^|\/)\.husky(\/_)?$/.test(configured))) {
    return { kind: "husky", file: join(root, ".husky", "pre-push"), configured: configured !== "" };
  }
  if (kind === "githooks") return { kind: "githooks", file: join(root, ".githooks", "pre-push"), configured: configured === ".githooks" };
  if (!kind && configured) {
    return { kind: "githooks", file: join(isAbsolute(configured) ? configured : join(root, configured), "pre-push"), configured: true };
  }
  const hooksDir = (await exec(["git", "-C", root, "rev-parse", "--git-path", "hooks"])).out.trim();
  return { kind: "git", file: join(isAbsolute(hooksDir) ? hooksDir : join(root, hooksDir), "pre-push"), configured: false };
}

function strip(text: string, open: string, close: string): string {
  const start = text.indexOf(open);
  const end = text.indexOf(close);
  if (start === -1 || end === -1 || end < start) return text;
  return `${text.slice(0, start)}${text.slice(end + close.length).replace(/^\n/, "")}`;
}

export function removeBlocks(text: string): string {
  return strip(strip(text, LEGACY_OPEN, LEGACY_CLOSE), OPEN, CLOSE).replace(/\n{2,}$/, "\n");
}

/** Only shell hooks can take the block; a node or python hook would fail to parse it. */
export function isShellHook(text: string): boolean {
  const first = text.split("\n", 1)[0] ?? "";
  return !first.startsWith("#!") || SHELL_SHEBANG.test(first);
}

export function applyBlock(existing: string): string {
  let body = removeBlocks(existing);
  if (body.trim() === "") body = "#!/bin/sh\n";
  return `${body.replace(/\n+$/, "")}\n\n${BLOCK}\n`;
}

/** True when nothing but blank lines follows the block, so no later step can run after the image build. */
export function isLastStep(text: string): boolean {
  const end = text.indexOf(CLOSE);
  return end !== -1 && text.slice(end + CLOSE.length).trim() === "";
}

/** First top-level `exit` before the block; it would end the hook before ci-local runs. */
export function findEarlyExit(text: string): number | null {
  const start = text.indexOf(OPEN);
  const before = start === -1 ? text : text.slice(0, start);
  const lines = before.split("\n");
  for (let i = 0; i < lines.length; i++) if (/^exit(\s|$)/.test(lines[i] as string)) return i + 1;
  return null;
}

export function isInstalled(text: string): boolean {
  return text.includes(OPEN);
}

export function installHook(target: HookTarget): "installed" | "updated" {
  const had = existsSync(target.file);
  const current = had ? readFileSync(target.file, "utf8") : "";
  if (had && !isShellHook(current)) throw new Error(`${target.file} is not a shell script; add the ci-local step to it by hand`);
  mkdirSync(dirname(target.file), { recursive: true });
  writeFileSync(target.file, applyBlock(current));
  chmodSync(target.file, 0o755);
  return had && isInstalled(current) ? "updated" : "installed";
}

export function uninstallHook(target: HookTarget): boolean {
  if (!existsSync(target.file)) return false;
  const current = readFileSync(target.file, "utf8");
  if (!isInstalled(current)) return false;
  writeFileSync(target.file, removeBlocks(current));
  return true;
}
