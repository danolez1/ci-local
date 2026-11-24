import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireImageSlot } from "../src/slots.ts";

let state: string;
beforeEach(() => {
  state = mkdtempSync(join(tmpdir(), "ci-local-slots-"));
  process.env.CI_LOCAL_STATE_DIR = state;
});
afterEach(() => {
  delete process.env.CI_LOCAL_STATE_DIR;
  rmSync(state, { recursive: true, force: true });
});

test("a fourth image waits until one of three gives its slot back", async () => {
  const releases = [await acquireImageSlot(), await acquireImageSlot(), await acquireImageSlot()];
  let waited = false;
  let got = false;
  const fourth = acquireImageSlot(() => {
    waited = true;
  }).then((release) => {
    got = true;
    return release;
  });
  await Bun.sleep(700);
  expect(waited).toBe(true);
  expect(got).toBe(false);
  releases[0]?.();
  (await fourth)();
  expect(got).toBe(true);
  releases[1]?.();
  releases[2]?.();
  expect(readdirSync(join(state, "slots"))).toEqual([]);
});

test("a slot held by a process that no longer exists is taken back", async () => {
  const dead = Bun.spawnSync(["true"]).pid ?? 2 ** 22 - 1;
  for (let i = 0; i < 3; i++) {
    const path = join(state, "slots", `slot-${i}`);
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, "pid"), String(dead));
  }
  const release = await acquireImageSlot();
  release();
});
