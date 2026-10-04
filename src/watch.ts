import { latestRunId, listRuns, readLog } from "./store.ts";
import type { RunRecord } from "./types.ts";

const COLOR: Record<string, string> = { success: "32", failed: "31", running: "34", skipped: "33", "dry-run": "33", interrupted: "31" };
const paint = (code: string | undefined, text: string): string => `\x1b[${code ?? "0"}m${text}\x1b[0m`;

function age(iso: string): string {
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 90) return `${s}s`;
  if (s < 5400) return `${Math.round(s / 60)}m`;
  return `${Math.round(s / 3600)}h`;
}

function row(r: RunRecord): string {
  const phase = r.phases.at(-1);
  const where = r.status === "running" && phase ? `${phase.name}` : r.tag ?? "";
  return `${paint(COLOR[r.status], r.status.padEnd(8))} ${r.image.padEnd(34)} ${r.sha.slice(0, 8)} ${where.padEnd(18)} ${age(r.started).padStart(4)}`;
}

export async function watch(): Promise<void> {
  const render = () => {
    const runs = listRuns(10);
    const out = ["\x1b[H\x1b[2J", paint("1", "ci-local"), "  (ctrl-c to leave)\n"];
    out.push(runs.length ? runs.map(row).join("\n") : "no runs yet");
    const id = latestRunId();
    if (id) {
      const size = readLog(id, 0, 0).size;
      const tail = readLog(id, Math.max(0, size - 16_384)).text.trimEnd().split("\n").slice(-14);
      out.push(`\n\n${paint("90", id)}`, ...tail);
    }
    process.stdout.write(`${out.join("\n")}\n`);
  };
  render();
  await new Promise<void>(() => setInterval(render, 1000));
}
