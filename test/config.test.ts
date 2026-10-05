import { describe, expect, test } from "bun:test";
import { ConfigError, parseGlobalConfig, parseRepoConfig, resolveProfile } from "../src/config.ts";

const repoYaml = `
version: 1
branches: [main, release/*]
tag_exclude: [docs]
images:
  - image: acme/web
  - name: api
    image: acme/api
    dockerfile: services/api/Dockerfile
    tag_exclude: []
`;

describe("repo config", () => {
  test("applies defaults and per-image overrides", () => {
    const c = parseRepoConfig(repoYaml);
    expect(c.branches).toEqual(["main", "release/*"]);
    expect(c.images[0]).toMatchObject({ name: "web", image: "acme/web", dockerfile: "Dockerfile", context: ".", tag_exclude: ["docs"] });
    expect(c.images[1]).toMatchObject({ name: "api", dockerfile: "services/api/Dockerfile", tag_exclude: [] });
  });

  test("reports every problem at once", () => {
    try {
      parseRepoConfig("version: 2\nimages: []\n");
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      expect((e as ConfigError).problems).toContain("version must be 1");
      expect((e as ConfigError).problems).toContain("images must be a non-empty list");
    }
  });

  test("rejects duplicate image names", () => {
    expect(() => parseRepoConfig("version: 1\nimages:\n  - image: a/x\n  - image: b/x\n")).toThrow(/used twice/);
  });
});

describe("profiles", () => {
  const global = parseGlobalConfig(`
default_profile: vps
profiles:
  vps: { transport: ssh, ssh_host: box, registry: 127.0.0.1:5000 }
  hub: { transport: https, registry: registry.example.com }
`);

  test("ssh needs a host", () => {
    expect(() => parseGlobalConfig("profiles:\n  p: { transport: ssh, registry: r:1 }\n")).toThrow(/ssh_host is required/);
  });

  test("flag beats repo beats default", () => {
    const repo = parseRepoConfig("version: 1\nprofile: hub\nimages:\n  - image: a/x\n");
    expect(resolveProfile(repo, global).name).toBe("hub");
    expect(resolveProfile(repo, global, "vps").name).toBe("vps");
    const plain = parseRepoConfig("version: 1\nimages:\n  - image: a/x\n");
    expect(resolveProfile(plain, global).name).toBe("vps");
  });

  test("a repo can bring its own profile", () => {
    const repo = parseRepoConfig("version: 1\nprofile: mine\nprofiles:\n  mine: { transport: direct, registry: localhost:5000 }\nimages:\n  - image: a/x\n");
    expect(resolveProfile(repo, { profiles: {} }).profile.transport).toBe("direct");
  });

  test("an unknown profile lists the known ones", () => {
    const repo = parseRepoConfig("version: 1\nprofile: nope\nimages:\n  - image: a/x\n");
    expect(() => resolveProfile(repo, global)).toThrow(/known: vps, hub/);
  });
});

const withChecks = (checks: string) => `version: 1\nimages:\n  - image: acme/web\nchecks:\n${checks}`;

test("checks are read with their command and optional expiry", () => {
  const config = parseRepoConfig(withChecks("  - name: test\n    run: pnpm test\n  - name: scan\n    run: ./scan.sh\n    ttl_hours: 24\n"));
  expect(config.checks).toEqual([
    { name: "test", run: "pnpm test", ttl_hours: 0 },
    { name: "scan", run: "./scan.sh", ttl_hours: 24 },
  ]);
  expect(parseRepoConfig("version: 1\nimages:\n  - image: acme/web\n").checks).toEqual([]);
});

test("a check with a missing command, a repeated or odd name, or a bad expiry is refused", () => {
  expect(() => parseRepoConfig(withChecks("  - name: test\n"))).toThrow("run is required");
  expect(() => parseRepoConfig(withChecks("  - name: a\n    run: x\n  - name: a\n    run: y\n"))).toThrow("used twice");
  expect(() => parseRepoConfig(withChecks("  - name: ../x\n    run: y\n"))).toThrow("may only use");
  expect(() => parseRepoConfig(withChecks("  - name: a\n    run: y\n    ttl_hours: 0\n"))).toThrow("whole number");
});
