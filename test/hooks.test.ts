import { describe, expect, test } from "bun:test";
import { applyBlock, findEarlyExit, isInstalled, isLastStep, isShellHook, removeBlocks } from "../src/hooks.ts";

const husky = "set -e\npnpm test\npnpm build\n";

describe("hook block", () => {
  test("is the last step and adds nothing at the top", () => {
    const out = applyBlock(husky);
    expect(isInstalled(out)).toBe(true);
    expect(isLastStep(out)).toBe(true);
    expect(out.startsWith("set -e\npnpm test\npnpm build\n")).toBe(true);
    expect(out).not.toContain("mktemp");
  });

  test("keeps the shebang on the first line", () => {
    expect(applyBlock("#!/bin/sh\necho hi\n").startsWith("#!/bin/sh\necho hi\n")).toBe(true);
  });

  test("replays a refs variable and otherwise reads stdin", () => {
    const out = applyBlock(husky);
    expect(out).toContain(`printf '%s\\n' "$refs" | ci-local hook pre-push`);
    expect(out).toContain('ci-local hook pre-push "$@" || exit 1');
  });

  test("is idempotent", () => {
    const once = applyBlock(husky);
    expect(applyBlock(once)).toBe(once);
  });

  test("moves the block back to the end after someone appends a step", () => {
    const appended = `${applyBlock(husky)}echo late\n`;
    expect(isLastStep(appended)).toBe(false);
    expect(isLastStep(applyBlock(appended))).toBe(true);
  });

  test("removal restores the original steps", () => {
    expect(removeBlocks(applyBlock(husky))).toBe(husky);
  });

  test("removal also clears a refs block left by an older version", () => {
    const legacy = `# >>> ci-local refs >>>\nx=1\n# <<< ci-local refs <<<\n${husky}`;
    expect(removeBlocks(legacy)).toBe(husky);
  });

  test("builds a hook from nothing", () => {
    const out = applyBlock("");
    expect(out.startsWith("#!/bin/sh")).toBe(true);
    expect(isLastStep(out)).toBe(true);
  });
});

describe("hook safety", () => {
  test("finds a top-level exit that would stop the block from running", () => {
    expect(findEarlyExit(applyBlock("echo mine\nexit 0\n"))).toBe(2);
    expect(findEarlyExit(applyBlock(husky))).toBeNull();
  });

  test("ignores an indented exit inside a function or branch", () => {
    expect(findEarlyExit(applyBlock("if x; then\n  exit 1\nfi\n"))).toBeNull();
  });

  test("only shell hooks can take the block", () => {
    expect(isShellHook("#!/bin/sh\n")).toBe(true);
    expect(isShellHook("#!/usr/bin/env bash\n")).toBe(true);
    expect(isShellHook("set -e\n")).toBe(true);
    expect(isShellHook("#!/usr/bin/env node\n")).toBe(false);
    expect(isShellHook("#!/usr/bin/python3\n")).toBe(false);
  });
});
