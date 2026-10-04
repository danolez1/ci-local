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
