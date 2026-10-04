#!/usr/bin/env node
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

// The tool uses Bun's runtime APIs; this thin launcher lets npx, npm -g and bunx all start it.
const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const child = spawn("bun", [cli, ...process.argv.slice(2)], { stdio: "inherit" });

child.on("error", (e) => {
  if (e.code !== "ENOENT") throw e;
  console.error("ci-local needs Bun on PATH. Install it from https://bun.sh and run this again.");
  process.exit(127);
});
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
