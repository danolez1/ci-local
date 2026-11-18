import { expect, test } from "bun:test";
import { exec, inChildGroup, killChildren } from "../src/exec.ts";

// A bare `sleep` is the child on purpose: killing a shell would leave its sleep holding the output pipe open.
test("killChildren inside a group stops that group's process and leaves the other group running", async () => {
  const survivor = inChildGroup(async () => (await exec(["sleep", "0.5"])).code);
  const victim = inChildGroup(async () => {
    const run = exec(["sleep", "5"]);
    await Bun.sleep(100);
    killChildren();
    return (await run).code;
  });
  const [keptCode, killedCode] = await Promise.all([survivor, victim]);
  expect(keptCode).toBe(0);
  expect(killedCode).not.toBe(0);
});

test("killChildren outside any group stops every group's process", async () => {
  const a = inChildGroup(async () => (await exec(["sleep", "5"])).code);
  const b = inChildGroup(async () => (await exec(["sleep", "5"])).code);
  await Bun.sleep(100);
  killChildren();
  const codes = await Promise.all([a, b]);
  expect(codes.every((c) => c !== 0)).toBe(true);
});
