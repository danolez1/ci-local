import pageSource from "./index.html" with { type: "text" };
import { listRuns, readLog, readRun, stateHome } from "../store.ts";

// @types/bun types .html imports as a bundle; with the text attribute the runtime value is the file contents.
const page = pageSource as unknown as string;

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

// Loopback only, and the Host header is checked, because logs can name internal hosts.
export function startUi(port: number): ReturnType<typeof Bun.serve> {
  return Bun.serve({
    port,
    hostname: "127.0.0.1",
    fetch(req) {
      if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(req.headers.get("host") ?? "")) return json({ error: "forbidden" }, 403);
      const url = new URL(req.url);
      const path = url.pathname;
      if (path === "/") return new Response(page, { headers: { "content-type": "text/html; charset=utf-8" } });
      if (path === "/api/info") return json({ state: stateHome() });
      if (path === "/api/runs") return json(listRuns(50));
      const m = path.match(/^\/api\/runs\/([\w.-]+)(\/log)?$/);
      if (m) {
        const id = m[1] as string;
        if (m[2]) return json(readLog(id, Number(url.searchParams.get("offset") ?? 0) || 0));
        const run = readRun(id);
        return run ? json(run) : json({ error: "not found" }, 404);
      }
      return json({ error: "not found" }, 404);
    },
  });
}
