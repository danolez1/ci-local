import pkg from "../../package.json" with { type: "json" };
import urbanist from "./fonts/Urbanist.ttf" with { type: "file" };
import pageSource from "./index.html" with { type: "text" };
import { type ControlResult, deleteRun, logPath, queryRuns, readLog, readRun, runStats, stateHome, stopRun } from "../store.ts";

// @types/bun types .html imports as a bundle; with the text attribute the runtime value is the file contents.
const page = pageSource as unknown as string;

// The page only needs its own origin; the policy also blunts any future injection and blocks framing.
const SECURITY_HEADERS = {
  "content-security-policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};

function json(req: Request, body: unknown, status = 200): Response {
  const text = JSON.stringify(body);
  // A tag over the body lets the page's polling get a 304 instead of re-downloading an unchanged list.
  const etag = `"${Bun.hash(text).toString(16)}"`;
  const headers = { "content-type": "application/json", "cache-control": "no-store", etag, ...SECURITY_HEADERS };
  if (status === 200 && req.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers });
  return new Response(text, { status, headers });
}

function int(value: string | null, fallback: number): number {
  const n = Number.parseInt(value ?? "", 10);
  return Number.isFinite(n) ? n : fallback;
}

// A page on another origin can send a request to 127.0.0.1, so a change needs the same origin plus a header
// that browsers only let a page add after a preflight, which this server never answers.
function isTrustedChange(req: Request): boolean {
  const origin = req.headers.get("origin");
  return req.headers.get("x-ci-local") === "1" && (origin === null || origin === `http://${req.headers.get("host")}`);
}

const CONTROL_STATUS: Record<ControlResult, number> = { done: 200, missing: 404, running: 409, "not-running": 409, foreign: 409 };

function control(req: Request, id: string, action: "stop" | "delete"): Response {
  if (!isTrustedChange(req)) return json(req, { error: "forbidden" }, 403);
  const result = action === "stop" ? stopRun(id) : deleteRun(id);
  return json(req, { result }, CONTROL_STATUS[result]);
}

function route(req: Request): Response {
  if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(req.headers.get("host") ?? "")) return json(req, { error: "forbidden" }, 403);
  const url = new URL(req.url);
  const path = url.pathname;
  const q = url.searchParams;
  if (path === "/") return new Response(page, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache", ...SECURITY_HEADERS } });
  if (path === "/fonts/Urbanist.ttf") return new Response(Bun.file(urbanist), { headers: { "content-type": "font/ttf", "cache-control": "public, max-age=86400", ...SECURITY_HEADERS } });
  if (path === "/api/info") return json(req, { name: pkg.name, version: pkg.version, state: stateHome() });
  if (path === "/api/runs") {
    return json(
      req,
      queryRuns({
        page: int(q.get("page"), 1),
        perPage: int(q.get("per_page"), 25),
        status: q.get("status") || undefined,
        repo: q.get("repo") || undefined,
        image: q.get("image") || undefined,
        q: q.get("q") || undefined,
      }),
    );
  }
  if (path === "/api/stats") return json(req, runStats());
  const m = path.match(/^\/api\/runs\/([\w.-]+)(\/log|\/raw|\/stop)?$/);
  if (!m) return json(req, { error: "not found" }, 404);
  const id = m[1] as string;
  if (req.method === "DELETE" && !m[2]) return control(req, id, "delete");
  if (req.method === "POST" && m[2] === "/stop") return control(req, id, "stop");
  if (req.method !== "GET" && req.method !== "HEAD") return json(req, { error: "method not allowed" }, 405);
  if (m[2] === "/stop") return json(req, { error: "method not allowed" }, 405);
  if (m[2] === "/raw") {
    const file = logPath(id);
    if (!file || !Bun.file(file).size) return json(req, { error: "not found" }, 404);
    return new Response(Bun.file(file), { headers: { "content-type": "text/plain; charset=utf-8", ...SECURITY_HEADERS } });
  }
  if (m[2]) return json(req, readLog(id, int(q.get("offset"), 0), int(q.get("limit"), 262_144)));
  const run = readRun(id);
  return run ? json(req, run) : json(req, { error: "not found" }, 404);
}

// Loopback only, and the Host header is checked, because logs can name internal hosts.
export function startUi(port: number): ReturnType<typeof Bun.serve> {
  return Bun.serve({
    port,
    hostname: "127.0.0.1",
    fetch(req) {
      // A malformed Host would otherwise surface as a 500 from URL parsing.
      try {
        return route(req);
      } catch {
        return json(req, { error: "bad request" }, 400);
      }
    },
  });
}
