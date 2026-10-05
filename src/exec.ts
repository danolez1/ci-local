interface ExecOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  stdin?: string | Blob;
  /** Called per output line from stdout and stderr, so long builds stream into the run log. */
  onLine?: (line: string) => void;
}

interface ExecResult {
  code: number;
  out: string;
  err: string;
}

// Runs are sequential and use one profile at a time, so a module-level switch is enough.
let inheritProxy = false;
export function setProxyMode(inherit: boolean): void {
  inheritProxy = inherit;
}

async function pump(stream: ReadableStream<Uint8Array>, onLine?: (line: string) => void): Promise<string> {
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  let all = "";
  let pending = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const text = decoder.decode(value, { stream: true });
    all += text;
    if (!onLine) continue;
    pending += text;
    // Progress bars rewrite the line with \r, so treat it as a line break too.
    const parts = pending.split(/\r?\n|\r/);
    pending = parts.pop() ?? "";
    for (const line of parts) if (line.length > 0) onLine(line);
  }
  if (onLine && pending.length > 0) onLine(pending);
  return all;
}

const children = new Set<ReturnType<typeof Bun.spawn>>();

/** Stops everything exec() started, so an interrupted run does not leave a docker build or an upload going. */
export function killChildren(): void {
  for (const proc of children) proc.kill("SIGTERM");
}

export async function exec(cmd: string[], options: ExecOptions = {}): Promise<ExecResult> {
  const proc = Bun.spawn(cmd, {
    cwd: options.cwd,
    env: { ...childEnv(), ...options.env },
    stdin: options.stdin === undefined ? "ignore" : new Response(options.stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
  children.add(proc);
  try {
    const [out, err, code] = await Promise.all([
      pump(proc.stdout, options.onLine),
      pump(proc.stderr, options.onLine),
      proc.exited,
    ]);
    return { code, out, err };
  } finally {
    children.delete(proc);
  }
}

export async function must(cmd: string[], options: ExecOptions = {}): Promise<string> {
  const r = await exec(cmd, options);
  if (r.code !== 0) {
    const detail = (r.err || r.out).trim().split("\n").slice(-5).join("\n");
    throw new Error(`${cmd.slice(0, 3).join(" ")} exited ${r.code}${detail ? `: ${detail}` : ""}`);
  }
  return r.out;
}

/** Environment for any child process, including ones spawned outside exec(). */
export function childEnv(): Record<string, string | undefined> {
  return inheritProxy ? { ...process.env } : withoutProxy(process.env);
}

const PROXY_VARS = /^(https?|all|no)_proxy$/i;

// A stale proxy in the shell would otherwise reach docker, crane and ssh without anyone noticing.
export function withoutProxy(env: NodeJS.ProcessEnv): Record<string, string | undefined> {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !PROXY_VARS.test(key)));
}

export function has(bin: string): boolean {
  return Bun.which(bin) !== null;
}
