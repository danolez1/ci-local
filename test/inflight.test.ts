import { expect, test } from "bun:test";
import { Mutex, pool, shareInFlight } from "../src/inflight.ts";

test("a second caller with the same key waits for the first and does not run the work again", async () => {
  let runs = 0;
  const work = async () => {
    runs++;
    await Bun.sleep(30);
  };
  const [a, b] = await Promise.all([shareInFlight("check", work), shareInFlight("check", work)]);
  expect(runs).toBe(1);
  expect([a, b].sort()).toEqual([false, true]);
});

test("a failure reaches every caller that shared the work", async () => {
  const work = async () => {
    await Bun.sleep(20);
    throw new Error("check failed");
  };
  const settled = await Promise.allSettled([shareInFlight("bad", work), shareInFlight("bad", work)]);
  expect(settled.map((s) => s.status)).toEqual(["rejected", "rejected"]);
});

test("different keys run side by side and the key is free again afterwards", async () => {
  let runs = 0;
  const work = async () => {
    runs++;
    await Bun.sleep(10);
  };
  await Promise.all([shareInFlight("x", work), shareInFlight("y", work)]);
  await shareInFlight("x", work);
  expect(runs).toBe(3);
});

test("the pool keeps at most the limit in flight and returns results in input order", async () => {
  let active = 0;
  let peak = 0;
  const out = await pool([30, 10, 20, 5, 15], 2, async (ms) => {
    active++;
    peak = Math.max(peak, active);
    await Bun.sleep(ms);
    active--;
    return ms * 2;
  });
  expect(out).toEqual([60, 20, 40, 10, 30]);
  expect(peak).toBe(2);
});

test("a limit of one runs the items one after another", async () => {
  const order: number[] = [];
  await pool([1, 2, 3], 1, async (n) => {
    order.push(n);
    await Bun.sleep(5);
    order.push(-n);
  });
  expect(order).toEqual([1, -1, 2, -2, 3, -3]);
});

test("the mutex lets one section run at a time and serves waiters in the order they asked", async () => {
  const mutex = new Mutex();
  const log: string[] = [];
  let active = 0;
  let peak = 0;
  const section = (name: string, ms: number) =>
    mutex.run(async () => {
      active++;
      peak = Math.max(peak, active);
      log.push(`start ${name}`);
      await Bun.sleep(ms);
      log.push(`end ${name}`);
      active--;
    });
  await Promise.all([section("a", 30), section("b", 5), section("c", 5)]);
  expect(peak).toBe(1);
  expect(log).toEqual(["start a", "end a", "start b", "end b", "start c", "end c"]);
});

test("the mutex is released when a section throws", async () => {
  const mutex = new Mutex();
  await expect(mutex.run(async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
  expect(await mutex.run(async () => "after")).toBe("after");
});
