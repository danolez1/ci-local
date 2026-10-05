import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const digest = (data: Buffer): string => createHash("sha256").update(data).digest("hex");

/** A minimal single-image OCI layout with uncompressed layers, shaped like BuildKit's tar=false export. */
export function makeOciLayout(dir: string, layers: string[]): { layerDigests: string[] } {
  const blobs = join(dir, "blobs", "sha256");
  mkdirSync(blobs, { recursive: true });
  const put = (data: Buffer): { digest: string; size: number } => {
    const hex = digest(data);
    writeFileSync(join(blobs, hex), data);
    return { digest: `sha256:${hex}`, size: data.length };
  };
  const layerDescriptors = layers.map((text) => ({ mediaType: "application/vnd.oci.image.layer.v1.tar", ...put(Buffer.from(text)) }));
  const config = put(Buffer.from(JSON.stringify({ architecture: "amd64", os: "linux", rootfs: { type: "layers", diff_ids: layerDescriptors.map((l) => l.digest) } })));
  const manifest = put(Buffer.from(JSON.stringify({ schemaVersion: 2, mediaType: "application/vnd.oci.image.manifest.v1+json", config: { mediaType: "application/vnd.oci.image.config.v1+json", ...config }, layers: layerDescriptors })));
  writeFileSync(join(dir, "oci-layout"), JSON.stringify({ imageLayoutVersion: "1.0.0" }));
  writeFileSync(join(dir, "index.json"), JSON.stringify({ schemaVersion: 2, mediaType: "application/vnd.oci.image.index.v1+json", manifests: [{ mediaType: "application/vnd.oci.image.manifest.v1+json", ...manifest }] }));
  return { layerDigests: layerDescriptors.map((l) => l.digest) };
}
