import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkEnv } from "../src/checks.ts";

const shim = join(import.meta.dir, "../src/shims/bun");
const dir = mkdtempSync(join(tmpdir(), "bun-shim-"));
const stubDir = join(dir, "real");
mkdirSync(stubDir);
const stub = join(stubDir, "bun");
writeFileSync(stub, '#!/bin/bash\nprintf "%s\\n" "$*"\n');
chmodSync(stub, 0o755);
const shimDir = join(import.meta.dir, "../src/shims");

// Like a check run by turbo: the shim folder comes first on PATH and no CI_LOCAL_* variable survives.
function run(args: string[], env: Record<string, string> = {}): string {
  const r = Bun.spawnSync([shim, ...args], { env: { PATH: `${shimDir}:${stubDir}:/usr/bin:/bin`, ...env } });
  return new TextDecoder().decode(r.stdout).trim();
}

test("bun test gets a timeout and one retry", () => {
  expect(run(["test"])).toBe("test --timeout 30000 --retry 1");
  expect(run(["test", "tests/a.test.ts", "--parallel=4"])).toBe("test --timeout 30000 --retry 1 tests/a.test.ts --parallel=4");
});

test("flags the caller already gave are left alone", () => {
  expect(run(["test", "--timeout", "10000", "x"])).toBe("test --retry 1 --timeout 10000 x");
  expect(run(["test", "--timeout=10000", "--retry", "0"])).toBe("test --timeout=10000 --retry 0");
});

test("bun --bun test is recognised and keeps its prefix", () => {
  expect(run(["--bun", "test", "t"])).toBe("--bun test --timeout 30000 --retry 1 t");
});

test("every other bun command passes through untouched", () => {
  expect(run(["run", "build"])).toBe("run build");
  expect(run(["install", "--frozen-lockfile"])).toBe("install --frozen-lockfile");
  expect(run([])).toBe("");
});

test("the environment can change the timeout or turn the retry off", () => {
  expect(run(["test"], { CI_LOCAL_TEST_TIMEOUT: "60000", CI_LOCAL_TEST_RETRY: "0" })).toBe("test --timeout 60000");
});

test("a check runs with the shim directory first on PATH and the real bun remembered", () => {
  const env = checkEnv("web", "/usr/bin", "/opt/bun");
  expect(env.CI_LOCAL_IMAGE).toBe("web");
  expect(env.CI_LOCAL_REAL_BUN).toBe("/opt/bun");
  expect(env.PATH?.endsWith(":/usr/bin")).toBe(true);
  expect(env.PATH?.startsWith(join(import.meta.dir, "../src/shims"))).toBe(true);
  expect(checkEnv(undefined, "/usr/bin", null)).toEqual({});
});

test("the real bun is still found when turbo strips every CI_LOCAL variable", () => {
  expect(run(["test"])).toBe("test --timeout 30000 --retry 1");
});

test("a stale CI_LOCAL_REAL_BUN is ignored in favour of the first bun on PATH after the shim", () => {
  expect(run(["run", "x"], { CI_LOCAL_REAL_BUN: "/does/not/exist" })).toBe("run x");
});
