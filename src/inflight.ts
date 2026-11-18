const running = new Map<string, Promise<void>>();

/** Runs fn once per key at a time: a second caller with the same key waits for the first and shares its outcome. */
export async function shareInFlight(key: string, fn: () => Promise<void>): Promise<boolean> {
  const existing = running.get(key);
  if (existing) {
    await existing;
    return false;
  }
  const work = fn();
  running.set(key, work);
  try {
    await work;
    return true;
  } finally {
    running.delete(key);
  }
}

/** Runs fn over items with at most `limit` in flight, returning the results in input order. */
export async function pool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const lanes = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i] as T);
    }
  });
  await Promise.all(lanes);
  return results;
}
