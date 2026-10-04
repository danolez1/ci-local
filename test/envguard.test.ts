import { expect, test } from "bun:test";
import { guardBuildEnv } from "../src/envguard.ts";

const prefixes = ["NEXT_PUBLIC_"];

test("accepts public-prefixed plain values", () => {
  expect(guardBuildEnv("# note\nNEXT_PUBLIC_URL=https://example.com\nNEXT_PUBLIC_ID=abc\n", prefixes, "b.env")).toEqual([]);
});

test("rejects keys without a public prefix", () => {
  expect(guardBuildEnv("DATABASE_URL=postgres://x\n", prefixes, "b.env")[0]).toContain("'DATABASE_URL'");
});

test("rejects a secret-looking value even under a public key", () => {
  const live = ["sk", "live", "abc123"].join("_");
  expect(guardBuildEnv(`NEXT_PUBLIC_KEY=${live}\n`, prefixes, "b.env")[0]).toContain("looks like a secret");
});

test("strips quotes before checking", () => {
  expect(guardBuildEnv(`NEXT_PUBLIC_A="https://x.test"\n`, prefixes, "b.env")).toEqual([]);
});

test("rejects a JWT and an sk- style key", () => {
  const jwt = ["eyJhbGciOiJIUzI1NiJ9", "payload", "sig"].join(".");
  expect(guardBuildEnv(`NEXT_PUBLIC_A=${jwt}\n`, prefixes, "b.env")[0]).toContain("looks like a secret");
  const key = `sk-${"a".repeat(24)}`;
  expect(guardBuildEnv(`NEXT_PUBLIC_B=${key}\n`, prefixes, "b.env")[0]).toContain("looks like a secret");
});
