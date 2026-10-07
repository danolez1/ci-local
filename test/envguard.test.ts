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

test("a bare carriage return does not hide a second assignment", () => {
  expect(guardBuildEnv("NEXT_PUBLIC_A=1\rAWS_VALUE=abc\r", prefixes, "b.env")[0]).toContain("'AWS_VALUE'");
});

test("a JWT is accepted only for a key named in public_jwt_keys", () => {
  const jwt = ["eyJhbGciOiJIUzI1NiJ9", "payload", "sig"].join(".");
  expect(guardBuildEnv(`NEXT_PUBLIC_ANON=${jwt}\n`, prefixes, "b.env", ["NEXT_PUBLIC_ANON"])).toEqual([]);
  expect(guardBuildEnv(`NEXT_PUBLIC_OTHER=${jwt}\n`, prefixes, "b.env", ["NEXT_PUBLIC_ANON"])[0]).toContain("looks like a secret");
});

test("an allowed JWT key still refuses other secret patterns", () => {
  const live = ["sk", "live", "abc123"].join("_");
  expect(guardBuildEnv(`NEXT_PUBLIC_ANON=${live}\n`, prefixes, "b.env", ["NEXT_PUBLIC_ANON"])[0]).toContain("looks like a secret");
});
