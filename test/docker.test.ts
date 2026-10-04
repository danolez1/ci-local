import { expect, test } from "bun:test";
import { parseGlobalConfig } from "../src/config.ts";
import { daemonProxies, withProxyHint } from "../src/docker.ts";
import { exec, setProxyMode, withoutProxy } from "../src/exec.ts";

const info = ` HTTP Proxy: http://proxy.orb.internal:8305
 HTTPS Proxy: http://proxy.orb.internal:8305
 No Proxy: localhost,127.0.0.1
 Name: orbstack`;

test("reads the proxies the docker daemon runs with", () => {
  expect(daemonProxies(info)).toEqual(["http http://proxy.orb.internal:8305", "https http://proxy.orb.internal:8305"]);
  expect(daemonProxies(" Name: orbstack\n")).toEqual([]);
});

test("credentials in a proxy URL are not echoed", () => {
  expect(daemonProxies(" HTTP Proxy: http://user:secret@proxy.corp:3128\n")).toEqual(["http http://<redacted>@proxy.corp:3128"]);
});

test("a proxyconnect failure gets an actionable hint, other failures do not", () => {
  const log = 'ERROR: failed to authorize: Get "https://auth.docker.io/token": proxyconnect tcp: dial tcp 10.0.0.1:3128: i/o timeout';
  expect(withProxyHint("docker build exited 1", log)).toContain("orb config set network_proxy none");
  expect(withProxyHint("docker build exited 1", "ERROR: no such file")).toBe("docker build exited 1");
});

test("proxy variables are removed from child commands unless the profile keeps them", async () => {
  expect(Object.keys(withoutProxy({ HTTP_PROXY: "x", https_proxy: "y", NO_PROXY: "z", PATH: "/bin" }))).toEqual(["PATH"]);
  process.env.HTTPS_PROXY = "http://127.0.0.1:9";
  try {
    setProxyMode(false);
    expect((await exec(["sh", "-c", 'echo "[$HTTPS_PROXY]"'])).out.trim()).toBe("[]");
    setProxyMode(true);
    expect((await exec(["sh", "-c", 'echo "[$HTTPS_PROXY]"'])).out.trim()).toBe("[http://127.0.0.1:9]");
  } finally {
    setProxyMode(false);
    delete process.env.HTTPS_PROXY;
  }
});

test("a profile's proxy setting defaults to none and rejects other values", () => {
  expect(parseGlobalConfig("profiles:\n  p: { transport: direct, registry: r:1 }\n").profiles.p?.proxy).toBe("none");
  expect(parseGlobalConfig("profiles:\n  p: { transport: direct, registry: r:1, proxy: inherit }\n").profiles.p?.proxy).toBe("inherit");
  expect(() => parseGlobalConfig("profiles:\n  p: { transport: direct, registry: r:1, proxy: auto }\n")).toThrow(/proxy must be none or inherit/);
});
