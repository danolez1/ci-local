import { childEnv, exec, must } from "./exec.ts";

interface PushedRef {
  ref: string;
  sha: string;
}

export async function repoRoot(cwd: string): Promise<string> {
  return (await must(["git", "-C", cwd, "rev-parse", "--show-toplevel"])).trim();
}

export async function resolveSha(root: string, rev: string): Promise<string> {
  if (rev.startsWith("-")) throw new Error(`'${rev}' is not a commit`);
  return (await must(["git", "-C", root, "rev-parse", "--verify", `${rev}^{commit}`])).trim();
}

export const shortSha = (sha: string): string => sha.slice(0, 8);

const underPath = (file: string, entry: string): boolean => file === entry || file.startsWith(`${entry.replace(/\/$/, "")}/`);

// Reading the commit, not the working tree, makes the same commit always map to the same tag.
export async function treeHash(root: string, sha: string, opts: { include: string[]; exclude: string[]; salt: string }): Promise<string> {
  const listing = await must(["git", "-C", root, "ls-tree", "-r", "-z", sha]);
  const kept = listing
    .split("\0")
    .filter(Boolean)
    .filter((entry) => {
      const file = entry.slice(entry.indexOf("\t") + 1);
      if (opts.include.length > 0 && !opts.include.some((p) => underPath(file, p))) return false;
      return !opts.exclude.some((p) => underPath(file, p));
    });
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(`${opts.salt}\n`);
  hasher.update(kept.join("\n"));
  return hasher.digest("hex").slice(0, 12);
}

// A symlink is refused because the build would follow it past what the guard checked.
export async function committedFile(root: string, sha: string, path: string): Promise<string> {
  const entries = (await must(["git", "-C", root, "ls-tree", "-z", sha, "--", path])).split("\0").filter(Boolean);
  if (entries.length === 0) throw new Error(`${path} is not committed at ${shortSha(sha)}`);
  const entry = entries[0] as string;
  const name = entry.slice(entry.indexOf("\t") + 1);
  if (entries.length !== 1 || name !== path || !/^100(644|755) /.test(entry)) {
    throw new Error(`${path} must be a single regular file, not a directory, symlink or submodule`);
  }
  return await must(["git", "-C", root, "show", `${sha}:${path}`]);
}

// Extracting the archive, not copying the tree, keeps untracked and ignored files out of the build.
export async function archiveTo(root: string, sha: string, dest: string): Promise<void> {
  const archive = Bun.spawn(["git", "-C", root, "archive", sha], { stdout: "pipe", stderr: "pipe", env: childEnv() });
  const tar = Bun.spawn(["tar", "-x", "-C", dest], { stdin: archive.stdout, stderr: "pipe", env: childEnv() });
  const [aCode, tCode] = await Promise.all([archive.exited, tar.exited]);
  if (aCode !== 0 || tCode !== 0) throw new Error(`could not extract ${sha} (git archive ${aCode}, tar ${tCode})`);
}

const branchMatches = (ref: string, pattern: string): boolean => {
  const full = `refs/heads/${pattern}`;
  return pattern.endsWith("*") ? ref.startsWith(full.slice(0, -1)) : ref === full;
};

/** git feeds pre-push one line per ref: `<local ref> <local sha> <remote ref> <remote sha>`. */
export function parsePrePushRefs(input: string, branches: string[]): PushedRef[] {
  const found: PushedRef[] = [];
  for (const line of input.split("\n")) {
    const [, localSha, remoteRef] = line.trim().split(/\s+/);
    if (!localSha || !remoteRef || /^0+$/.test(localSha)) continue;
    if (branches.some((b) => branchMatches(remoteRef, b))) found.push({ ref: remoteRef, sha: localSha });
  }
  return found;
}

/** When an earlier hook step already drained stdin, the checked-out branch is the best guess for what is pushed. */
export async function checkedOutRef(root: string, branches: string[]): Promise<PushedRef | null> {
  const branch = (await exec(["git", "-C", root, "symbolic-ref", "--short", "-q", "HEAD"])).out.trim();
  if (!branch || !branches.some((b) => branchMatches(`refs/heads/${branch}`, b))) return null;
  return { ref: `refs/heads/${branch}`, sha: await resolveSha(root, "HEAD") };
}
