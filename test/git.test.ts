import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { must } from "../src/exec.ts";
import { parsePrePushRefs, resolveSha, treeHash } from "../src/git.ts";

let root = "";
const git = (...args: string[]) => must(["git", "-C", root, "-c", "user.email=t@t", "-c", "user.name=t", ...args]);

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "ci-local-git-"));
  await must(["git", "-C", root, "init", "-q", "-b", "main"]);
  mkdirSync(join(root, "docs"));
  writeFileSync(join(root, "app.ts"), "one");
  writeFileSync(join(root, "docs", "a.md"), "doc");
  await git("add", "-A");
  await git("commit", "-qm", "first");
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("treeHash", () => {
  const opts = { include: [], exclude: ["docs"], salt: "amd64" };

  test("ignores excluded paths", async () => {
    const before = await treeHash(root, await resolveSha(root, "HEAD"), opts);
    writeFileSync(join(root, "docs", "a.md"), "changed");
    await git("commit", "-qam", "docs only");
    expect(await treeHash(root, await resolveSha(root, "HEAD"), opts)).toBe(before);
  });

  test("changes when an included file changes", async () => {
    const before = await treeHash(root, await resolveSha(root, "HEAD"), opts);
    writeFileSync(join(root, "app.ts"), "two");
    await git("commit", "-qam", "code");
    expect(await treeHash(root, await resolveSha(root, "HEAD"), opts)).not.toBe(before);
  });

  test("the salt separates platforms", async () => {
    const sha = await resolveSha(root, "HEAD");
    expect(await treeHash(root, sha, { ...opts, salt: "amd64" })).not.toBe(await treeHash(root, sha, { ...opts, salt: "arm64" }));
  });

  test("include narrows what counts", async () => {
    const sha = await resolveSha(root, "HEAD");
    const only = await treeHash(root, sha, { include: ["app.ts"], exclude: [], salt: "x" });
    writeFileSync(join(root, "docs", "a.md"), "again");
    await git("commit", "-qam", "docs again");
    expect(await treeHash(root, await resolveSha(root, "HEAD"), { include: ["app.ts"], exclude: [], salt: "x" })).toBe(only);
  });
});

describe("parsePrePushRefs", () => {
  const sha = "a".repeat(40);
  const zero = "0".repeat(40);

  test("keeps only pushes to configured branches", () => {
    const input = `refs/heads/main ${sha} refs/heads/main ${zero}\nrefs/heads/x ${sha} refs/heads/feature ${zero}\n`;
    expect(parsePrePushRefs(input, ["main"])).toEqual([{ ref: "refs/heads/main", sha }]);
  });

  test("ignores branch deletions", () => {
    expect(parsePrePushRefs(`(delete) ${zero} refs/heads/main ${sha}\n`, ["main"])).toEqual([]);
  });

  test("supports a trailing wildcard", () => {
    expect(parsePrePushRefs(`refs/heads/r ${sha} refs/heads/release/1.2 ${zero}\n`, ["release/*"])).toHaveLength(1);
  });
});
