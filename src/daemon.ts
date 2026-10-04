import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { childEnv, exec } from "./exec.ts";
import { stateHome } from "./store.ts";

export interface DaemonInfo {
  pid: number;
  port: number;
  started: string;
}

const infoFile = (): string => join(stateHome(), "ui.json");
export const uiLogFile = (): string => join(stateHome(), "ui.log");
export const DEFAULT_PORT = 7777;
const LABEL = "dev.ci-local.ui";

const cliPath = (): string => fileURLToPath(new URL("./cli.ts", import.meta.url));

// A process owned by another user answers EPERM; this tool's server never does, so that means a recycled pid.
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// A recycled pid must never be signalled, so the process has to be this tool's own server.
function isOurServer(pid: number): boolean {
  const r = Bun.spawnSync(["ps", "-p", String(pid), "-o", "command="], { env: childEnv() });
  const command = r.stdout.toString();
  return command.includes("cli.ts") && command.includes(" ui");
}

export function readDaemon(): DaemonInfo | null {
  try {
    const info = JSON.parse(readFileSync(infoFile(), "utf8")) as DaemonInfo;
    if (alive(info.pid) && isOurServer(info.pid)) return info;
  } catch {
    return null;
  }
  rmSync(infoFile(), { force: true });
  return null;
}

// Only the process that owns the port writes the record, so `ui status` and `ui stop` can trust it.
export function registerDaemon(port: number): void {
  if (readDaemon()) return;
  mkdirSync(stateHome(), { recursive: true });
  writeFileSync(infoFile(), JSON.stringify({ pid: process.pid, port, started: new Date().toISOString() } satisfies DaemonInfo));
  const cleanup = () => {
    if (readDaemon()?.pid === process.pid) rmSync(infoFile(), { force: true });
  };
  process.on("exit", cleanup);
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      cleanup();
      process.exit(0);
    });
  }
}

async function reachable(port: number): Promise<boolean> {
  try {
    return (await fetch(`http://127.0.0.1:${port}/api/info`, { signal: AbortSignal.timeout(800) })).ok;
  } catch {
    return false;
  }
}

export async function startDaemon(port: number): Promise<DaemonInfo> {
  const running = readDaemon();
  if (running) return running;
  mkdirSync(stateHome(), { recursive: true });
  const log = openSync(uiLogFile(), "a");
  // A new process group keeps a closed terminal's hangup from reaching the server.
  const child = Bun.spawn([process.execPath, cliPath(), "ui", "serve", "--port", String(port)], {
    stdin: "ignore",
    stdout: log,
    stderr: log,
    env: childEnv(),
    detached: true,
  });
  child.unref();
  closeSync(log);
  for (let waited = 0; waited < 8000; waited += 200) {
    const info = readDaemon();
    if (info && (await reachable(info.port))) return info;
    if (child.exitCode !== null) break;
    await Bun.sleep(200);
  }
  if (child.exitCode === null) child.kill();
  throw new Error(`the web view did not start on port ${port}; see ${uiLogFile()}`);
}

export async function stopDaemon(): Promise<boolean> {
  const info = readDaemon();
  if (!info) return false;
  process.kill(info.pid, "SIGTERM");
  for (let waited = 0; waited < 5000 && alive(info.pid); waited += 100) await Bun.sleep(100);
  if (alive(info.pid)) process.kill(info.pid, "SIGKILL");
  rmSync(infoFile(), { force: true });
  return true;
}

interface AgentOptions {
  bun: string;
  cli: string;
  port: number;
  log: string;
  stateDir?: string;
}

const xml = (v: string): string => v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** A macOS LaunchAgent that starts the web view at login and restarts it if it dies. */
export function launchAgentPlist(o: AgentOptions): string {
  const args = [o.bun, o.cli, "ui", "serve", "--port", String(o.port)].map((v) => `    <string>${xml(v)}</string>`).join("\n");
  const env = o.stateDir ? `  <key>EnvironmentVariables</key>\n  <dict>\n    <key>CI_LOCAL_STATE_DIR</key>\n    <string>${xml(o.stateDir)}</string>\n  </dict>\n` : "";
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
${env}  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${xml(o.log)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(o.log)}</string>
</dict>
</plist>
`;
}

const agentFile = (): string => join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);

export const agentInstalled = (): boolean => existsSync(agentFile());

export async function installAgent(port: number): Promise<string> {
  if (process.platform !== "darwin") throw new Error("the login service is macOS only; on Linux run `ci-local ui start` from your init system");
  mkdirSync(stateHome(), { recursive: true });
  const file = agentFile();
  mkdirSync(join(homedir(), "Library", "LaunchAgents"), { recursive: true });
  writeFileSync(file, launchAgentPlist({ bun: process.execPath, cli: cliPath(), port, log: uiLogFile(), stateDir: process.env.CI_LOCAL_STATE_DIR }));
  const uid = String(process.getuid?.() ?? 501);
  await exec(["launchctl", "bootout", `gui/${uid}`, file]);
  const r = await exec(["launchctl", "bootstrap", `gui/${uid}`, file]);
  if (r.code !== 0) throw new Error(`launchctl bootstrap failed: ${(r.err || r.out).trim()}`);
  return file;
}

export async function uninstallAgent(): Promise<boolean> {
  const file = agentFile();
  if (!existsSync(file)) return false;
  await exec(["launchctl", "bootout", `gui/${String(process.getuid?.() ?? 501)}`, file]);
  rmSync(file, { force: true });
  return true;
}
