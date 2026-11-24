import { createHash, randomUUID } from "node:crypto";
import { copyFileSync, createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { exec } from "./exec.ts";
import { formatBytes } from "./progress.ts";

export const DEFAULT_ZSTD_LEVEL = 19;
const OCI_TAR = "application/vnd.oci.image.layer.v1.tar";
const OCI_ZSTD = "application/vnd.oci.image.layer.v1.tar+zstd";
const CACHE_MAX_AGE_MS = 14 * 24 * 3600 * 1000;

interface Descriptor {
  mediaType: string;
  digest: string;
  size: number;
}

interface Manifest {
  layers: Descriptor[];
}

interface Index {
  manifests: Descriptor[];
}

export interface RecompressStats {
  compressed: number;
  cached: number;
  before: number;
  after: number;
}

const hex = (digest: string): string => digest.slice("sha256:".length);
const blobPath = (dir: string, digest: string): string => join(dir, "blobs", "sha256", hex(digest));

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, "utf8")) as T;
}

async function sha256File(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

interface Compressed {
  file: string;
  digest: string;
  size: number;
  cached: boolean;
}

// Images built at once share base layers, and two compressions of one layer must not write the same file.
const compressing = new Map<string, Promise<Compressed>>();

function writeMeta(meta: string, record: { digest: string; size: number }): void {
  const tmp = `${meta}.${process.pid}.${randomUUID()}.partial`;
  writeFileSync(tmp, JSON.stringify(record));
  renameSync(tmp, meta);
}

/** The blob lands by rename and so is always whole; a record that disagrees with it is the part to distrust. */
async function knownBlob(blob: string, meta: string): Promise<{ digest: string; size: number } | null> {
  if (!existsSync(blob)) return null;
  const size = statSync(blob).size;
  if (existsSync(meta)) {
    try {
      const known = readJson<{ digest: string; size: number }>(meta);
      if (known.size === size && typeof known.digest === "string") return known;
    } catch {
      // An unreadable record is rebuilt below like a wrong one.
    }
  }
  const record = { digest: `sha256:${await sha256File(blob)}`, size };
  writeMeta(meta, record);
  return record;
}

async function compressBlob(source: string, layer: Descriptor, level: number, blob: string, meta: string, onLine: (line: string) => void): Promise<Compressed> {
  const known = await knownBlob(blob, meta);
  if (known) {
    const now = new Date();
    utimesSync(blob, now, now);
    utimesSync(meta, now, now);
    return { file: blob, ...known, cached: true };
  }
  const started = Date.now();
  const tmp = `${blob}.${process.pid}.${randomUUID()}.partial`;
  // zstd refuses levels above 19 unless told it may use the memory they need.
  const r = await exec(["zstd", ...(level > 19 ? ["--ultra"] : []), `-${level}`, "-T0", "-q", "-f", "-o", tmp, source]);
  if (r.code !== 0) {
    rmSync(tmp, { force: true });
    throw new Error(`zstd exited ${r.code}: ${(r.err || r.out).trim().split("\n").slice(-3).join("\n")}`);
  }
  const digest = `sha256:${await sha256File(tmp)}`;
  const size = statSync(tmp).size;
  renameSync(tmp, blob);
  writeMeta(meta, { digest, size });
  if (size > 5e6) onLine(`compress: layer ${hex(layer.digest).slice(0, 12)} ${formatBytes(layer.size)} -> ${formatBytes(size)} in ${Math.round((Date.now() - started) / 1000)}s`);
  return { file: blob, digest, size, cached: false };
}

/** Layer blobs already compressed at this level are kept by uncompressed digest, so a layer that did not change is never recompressed. */
async function zstdBlob(source: string, layer: Descriptor, level: number, cacheDir: string, onLine: (line: string) => void): Promise<Compressed> {
  const dir = join(cacheDir, String(level));
  mkdirSync(dir, { recursive: true });
  const blob = join(dir, `${hex(layer.digest)}.zst`);
  const meta = join(dir, `${hex(layer.digest)}.json`);
  const running = compressing.get(blob);
  if (running) {
    const done = await running;
    return { ...done, cached: true };
  }
  const work = compressBlob(source, layer, level, blob, meta, onLine).finally(() => compressing.delete(blob));
  compressing.set(blob, work);
  return work;
}

function pruneCache(cacheDir: string): void {
  if (!existsSync(cacheDir)) return;
  const cutoff = Date.now() - CACHE_MAX_AGE_MS;
  for (const level of readdirSync(cacheDir)) {
    const dir = join(cacheDir, level);
    if (!statSync(dir).isDirectory()) continue;
    for (const name of readdirSync(dir)) {
      if (statSync(join(dir, name)).mtimeMs < cutoff) rmSync(join(dir, name), { force: true });
    }
  }
}

/**
 * Rewrites an OCI layout in place so its layers are zstd. Layer contents, and so the image config's
 * diff_ids, stay the same; only the manifest's layer descriptors change.
 */
export async function recompressLayers(dir: string, level: number, cacheDir: string, onLine: (line: string) => void): Promise<RecompressStats> {
  const indexFile = join(dir, "index.json");
  const index = readJson<Index>(indexFile);
  const manifestDescriptor = index.manifests[0];
  if (index.manifests.length !== 1 || !manifestDescriptor) throw new Error("expected the build to export exactly one image");
  const manifest = readJson<Manifest>(blobPath(dir, manifestDescriptor.digest));
  if (!manifest.layers) throw new Error("the exported image has no layers; was a multi-platform index exported?");

  const stats: RecompressStats = { compressed: 0, cached: 0, before: 0, after: 0 };
  for (const layer of manifest.layers) {
    stats.before += layer.size;
    if (layer.mediaType === OCI_ZSTD) {
      stats.after += layer.size;
      continue;
    }
    if (layer.mediaType !== OCI_TAR) throw new Error(`unexpected layer type ${layer.mediaType}; the build must export uncompressed layers`);
    const source = blobPath(dir, layer.digest);
    const out = await zstdBlob(source, layer, level, cacheDir, onLine);
    // Two layers with the same content share one blob, and the copy of a cached read-only file cannot be overwritten.
    if (!existsSync(blobPath(dir, out.digest))) copyFileSync(out.file, blobPath(dir, out.digest));
    rmSync(source, { force: true });
    if (out.cached) stats.cached++;
    else stats.compressed++;
    stats.after += out.size;
    layer.mediaType = OCI_ZSTD;
    layer.digest = out.digest;
    layer.size = out.size;
  }

  const data = Buffer.from(JSON.stringify(manifest));
  const digest = `sha256:${createHash("sha256").update(data).digest("hex")}`;
  writeFileSync(blobPath(dir, digest), data);
  rmSync(blobPath(dir, manifestDescriptor.digest), { force: true });
  manifestDescriptor.digest = digest;
  manifestDescriptor.size = data.length;
  writeFileSync(indexFile, JSON.stringify(index));
  pruneCache(cacheDir);
  return stats;
}
