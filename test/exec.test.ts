import { expect, test } from "bun:test";
import { exec, killChildren } from "../src/exec.ts";

test("killChildren stops what exec started, so an interrupted run leaves nothing behind", async () => {
  const started = Date.now();
  const running = exec(["sleep", "30"]);
  await Bun.sleep(100);
  killChildren();
  const result = await running;
  expect(result.code).not.toBe(0);
  expect(Date.now() - started).toBeLessThan(5_000);
});
