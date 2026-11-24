import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { has, must } from "../src/exec.ts";
import { blobCount } from "../src/progress.ts";
import { recompressLayers } from "../src/recompress.ts";
import { makeOciLayout } from "./oci-fixture.ts";

const zstdTest = has("zstd") ? test : test.skip;
let base: string;

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), "ci-local-zstd-"));
});
afterAll(() => rmSync(base, { recursive: true, force: true }));

const blob = (dir: string, digest: string): string => join(dir, "blobs", "sha256", digest.slice("sha256:".length));

zstdTest("layers become zstd, keep their contents, and the manifest and index follow", async () => {
  const dir = join(base, "one");
  const layers = ["a".repeat(50_000), "b".repeat(20_000)];
  const { layerDigests } = makeOciLayout(dir, layers);
  expect(await blobCount(dir)).toBe(3);

  const stats = await recompressLayers(dir, 3, join(base, "cache"), () => {});
  expect(stats).toMatchObject({ compressed: 2, cached: 0, before: 70_000 });
  expect(stats.after).toBeLessThan(2_000);

  const index = JSON.parse(readFileSync(join(dir, "index.json"), "utf8"));
  const manifest = JSON.parse(readFileSync(blob(dir, index.manifests[0].digest), "utf8"));
  expect(index.manifests[0].size).toBe(readFileSync(blob(dir, index.manifests[0].digest)).length);
  expect(`sha256:${createHash("sha256").update(readFileSync(blob(dir, index.manifests[0].digest))).digest("hex")}`).toBe(index.manifests[0].digest);
  manifest.layers.forEach((layer: { mediaType: string; digest: string; size: number }, i: number) => {
    expect(layer.mediaType).toBe("application/vnd.oci.image.layer.v1.tar+zstd");
    const file = blob(dir, layer.digest);
    expect(readFileSync(file).length).toBe(layer.size);
    expect(`sha256:${createHash("sha256").update(readFileSync(file)).digest("hex")}`).toBe(layer.digest);
    expect(existsSync(blob(dir, layerDigests[i] as string))).toBe(false);
  });
  const restored = await must(["zstd", "-dc", blob(dir, manifest.layers[0].digest)]);
  expect(restored).toBe(layers[0] as string);
  expect(await blobCount(dir)).toBe(3);
});

zstdTest("a layer compressed before is reused, not compressed again", async () => {
  const cache = join(base, "cache-reuse");
  makeOciLayout(join(base, "first"), ["same layer ".repeat(5_000), "first only ".repeat(5_000)]);
  await recompressLayers(join(base, "first"), 3, cache, () => {});
  makeOciLayout(join(base, "second"), ["same layer ".repeat(5_000), "second only ".repeat(5_000)]);
  const stats = await recompressLayers(join(base, "second"), 3, cache, () => {});
  expect(stats).toMatchObject({ compressed: 1, cached: 1 });
});

zstdTest("an image with two identical layers still converts", async () => {
  const dir = join(base, "twins");
  const { layerDigests } = makeOciLayout(dir, ["twin layer ".repeat(5_000), "twin layer ".repeat(5_000)]);
  // BuildKit exports its layer blobs read-only, and zstd gives its output the same mode.
  chmodSync(blob(dir, layerDigests[0] as string), 0o444);
  const stats = await recompressLayers(dir, 3, join(base, "cache-twins"), () => {});
  expect(stats.compressed + stats.cached).toBe(2);
});

test("layers of an unexpected type are refused instead of pushed half converted", async () => {
  const dir = join(base, "gzip");
  makeOciLayout(dir, ["x"]);
  const index = JSON.parse(readFileSync(join(dir, "index.json"), "utf8"));
  const file = blob(dir, index.manifests[0].digest);
  const manifest = readFileSync(file, "utf8").replace("layer.v1.tar\"", "layer.v1.tar+gzip\"");
  await Bun.write(file, manifest);
  await expect(recompressLayers(dir, 3, join(base, "cache-bad"), () => {})).rejects.toThrow("unexpected layer type");
});

zstdTest("levels above 19 work too", async () => {
  makeOciLayout(join(base, "ultra"), ["u".repeat(30_000)]);
  const stats = await recompressLayers(join(base, "ultra"), 20, join(base, "cache-ultra"), () => {});
  expect(stats.compressed).toBe(1);
});

const cacheEntry = (cache: string, level: number, layerDigest: string): { file: string; meta: { digest: string; size: number } } => {
  const stem = join(cache, String(level), layerDigest.slice("sha256:".length));
  return { file: `${stem}.zst`, meta: JSON.parse(readFileSync(`${stem}.json`, "utf8")) };
};

const sha = (file: string): string => `sha256:${createHash("sha256").update(readFileSync(file)).digest("hex")}`;

zstdTest("two images compressing the same layer at once both record the whole blob", async () => {
  const cache = join(base, "cache-race");
  const shared = randomBytes(6_000_000).toString("hex");
  const { layerDigests } = makeOciLayout(join(base, "race-a"), [shared]);
  makeOciLayout(join(base, "race-b"), [shared]);
  const first = recompressLayers(join(base, "race-a"), 9, cache, () => {});
  await Bun.sleep(150);
  await Promise.all([first, recompressLayers(join(base, "race-b"), 9, cache, () => {})]);

  const entry = cacheEntry(cache, 9, layerDigests[0] as string);
  expect(entry.meta.size).toBe(statSync(entry.file).size);
  expect(entry.meta.digest).toBe(sha(entry.file));
  for (const name of ["race-a", "race-b"]) {
    const index = JSON.parse(readFileSync(join(base, name, "index.json"), "utf8"));
    const layer = JSON.parse(readFileSync(blob(join(base, name), index.manifests[0].digest), "utf8")).layers[0];
    expect(statSync(blob(join(base, name), layer.digest)).size).toBe(layer.size);
    expect(sha(blob(join(base, name), layer.digest))).toBe(layer.digest);
  }
});

zstdTest("a cache record that disagrees with its blob is rebuilt, not uploaded", async () => {
  const cache = join(base, "cache-stale");
  const text = "stale record ".repeat(40_000);
  const { layerDigests } = makeOciLayout(join(base, "stale-a"), [text]);
  await recompressLayers(join(base, "stale-a"), 3, cache, () => {});
  const entry = cacheEntry(cache, 3, layerDigests[0] as string);
  writeFileSync(entry.file.replace(/\.zst$/, ".json"), JSON.stringify({ digest: `sha256:${"0".repeat(64)}`, size: entry.meta.size - 7 }));

  makeOciLayout(join(base, "stale-b"), [text]);
  await recompressLayers(join(base, "stale-b"), 3, cache, () => {});
  const index = JSON.parse(readFileSync(join(base, "stale-b", "index.json"), "utf8"));
  const layer = JSON.parse(readFileSync(blob(join(base, "stale-b"), index.manifests[0].digest), "utf8")).layers[0];
  expect(layer.size).toBe(entry.meta.size);
  expect(layer.digest).toBe(entry.meta.digest);
  expect(cacheEntry(cache, 3, layerDigests[0] as string).meta).toEqual(entry.meta);
});
