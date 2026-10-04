import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseRepoConfig } from "../src/config.ts";
import { must } from "../src/exec.ts";
import { committedFile } from "../src/git.ts";
import { isSafeRelative, placeFile, readExtractedFile, within } from "../src/paths.ts";

let base = "";
let repo = "";
let sha = "";

beforeAll(async () => {
  base = mkdtempSync(join(tmpdir(), "ci-local-paths-"));
  repo = join(base, "repo");
  mkdirSync(repo);
  writeFileSync(join(base, "outside.env"), "SECRET=1\n");
  writeFileSync(join(repo, "public.env"), "NEXT_PUBLIC_A=1\n");
  symlinkSync(join(base, "outside.env"), join(repo, "linked.env"));
  symlinkSync(base, join(repo, "up"));
  await must(["git", "-C", repo, "init", "-q", "-b", "main"]);
  await must(["git", "-C", repo, "add", "-A"]);
  await must(["git", "-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "x"]);
  sha = (await must(["git", "-C", repo, "rev-parse", "HEAD"])).trim();
});

afterAll(() => rmSync(base, { recursive: true, force: true }));

test("config paths must stay inside the repo", () => {
  expect(isSafeRelative("infra/build.env")).toBe(true);
  expect(isSafeRelative("../x")).toBe(false);
  expect(isSafeRelative("a/../../x")).toBe(false);
  expect(isSafeRelative("/etc/passwd")).toBe(false);
  expect(isSafeRelative("")).toBe(false);
  expect(isSafeRelative("infra/")).toBe(false);
  expect(isSafeRelative("infra//a.env")).toBe(false);
  expect(isSafeRelative(".")).toBe(true);
  expect(() => parseRepoConfig("version: 1\nimages:\n  - image: a/x\n    context: ../..\n")).toThrow(/inside the repository/);
  expect(() => parseRepoConfig("version: 1\nimages:\n  - image: a/x\n    dockerfile: /tmp/Dockerfile\n")).toThrow(/inside the repository/);
  expect(() => parseRepoConfig("version: 1\nimages:\n  - image: a/x\n    build_args_file: ../victim.env\n")).toThrow(/inside the repository/);
});

test("a symlink out of the extracted tree is refused", () => {
  expect(within(repo, "public.env")).toContain("public.env");
  expect(() => within(repo, "linked.env")).toThrow(/outside the repository/);
  expect(() => within(repo, "up")).toThrow(/outside the repository/);
  expect(() => within(repo, "missing.env")).toThrow(/does not exist/);
});

test("a committed symlink cannot stand in for an env file", async () => {
  expect(await committedFile(repo, sha, "public.env")).toContain("NEXT_PUBLIC_A");
  await expect(committedFile(repo, sha, "linked.env")).rejects.toThrow(/regular file/);
  await expect(committedFile(repo, sha, "nope.env")).rejects.toThrow(/not committed/);
});

test("a directory path cannot pass for an env file", async () => {
  mkdirSync(join(repo, "infra"), { recursive: true });
  writeFileSync(join(repo, "infra", "a.env"), "NEXT_PUBLIC_A=1\n");
  await must(["git", "-C", repo, "add", "-A"]);
  await must(["git", "-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "dir"]);
  const head = (await must(["git", "-C", repo, "rev-parse", "HEAD"])).trim();
  await expect(committedFile(repo, head, "infra")).rejects.toThrow(/single regular file/);
  await expect(committedFile(repo, head, "infra/")).rejects.toThrow(/single regular file/);
  expect(await committedFile(repo, head, "infra/a.env")).toContain("NEXT_PUBLIC_A");
});

test("a file swapped for a symlink during extraction is refused", () => {
  const ctx = mkdtempSync(join(base, "ctx-"));
  writeFileSync(join(ctx, "secret.txt"), "SECRET_KEY=hunter2\n");
  writeFileSync(join(ctx, "build.env"), "NEXT_PUBLIC_A=1\n");
  expect(readExtractedFile(ctx, "build.env")).toContain("NEXT_PUBLIC_A");
  rmSync(join(ctx, "build.env"));
  symlinkSync(join(ctx, "secret.txt"), join(ctx, "build.env"));
  expect(() => readExtractedFile(ctx, "build.env")).toThrow(/regular file/);
});

test("placing a local file replaces a committed symlink instead of writing through it", () => {
  const ctx = mkdtempSync(join(base, "place-"));
  mkdirSync(join(ctx, "infra"));
  writeFileSync(join(base, "victim.txt"), "keep me\n");
  symlinkSync(join(base, "victim.txt"), join(ctx, "infra", "build.env"));
  placeFile(ctx, "infra/build.env", "NEXT_PUBLIC_A=1\n");
  expect(lstatSync(join(ctx, "infra", "build.env")).isSymbolicLink()).toBe(false);
  expect(readFileSync(join(ctx, "infra", "build.env"), "utf8")).toBe("NEXT_PUBLIC_A=1\n");
  expect(readFileSync(join(base, "victim.txt"), "utf8")).toBe("keep me\n");
});

test("placing a local file never writes through a symlinked directory", () => {
  const ctx = mkdtempSync(join(base, "dirlink-"));
  const outside = mkdtempSync(join(base, "outside-"));
  symlinkSync(outside, join(ctx, "infra"));
  expect(() => placeFile(ctx, "infra/build.env", "NEXT_PUBLIC_A=1\n")).toThrow(/not a plain directory/);
  expect(existsSync(join(outside, "build.env"))).toBe(false);
});
