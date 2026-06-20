import { describe, it, expect } from "vitest";
import {
  authenticate,
  AuthError,
  parseBearer,
  resolveReadScopes,
  resolveWriteScope,
} from "../src/auth/guard.js";
import type { Principal } from "../src/config.js";

const full: Principal = { name: "full", scopes: ["private", "work", "shared"], defaultWriteScope: "private" };
const work: Principal = { name: "work", scopes: ["work", "shared"], defaultWriteScope: "work" };
const family: Principal = { name: "family", scopes: ["shared"], defaultWriteScope: "shared" };

describe("parseBearer", () => {
  it("extracts the token", () => {
    expect(parseBearer("Bearer abc123")).toBe("abc123");
    expect(parseBearer("bearer  abc123  ")).toBe("abc123");
  });
  it("returns null for missing/invalid headers", () => {
    expect(parseBearer(undefined)).toBeNull();
    expect(parseBearer("Token abc")).toBeNull();
  });
});

describe("authenticate", () => {
  const tokens = new Map<string, Principal>([["t-full", full]]);
  it("resolves a known token", () => {
    expect(authenticate("t-full", tokens)).toBe(full);
  });
  it("throws 401 for missing/unknown tokens", () => {
    expect(() => authenticate(null, tokens)).toThrow(AuthError);
    expect(() => authenticate("nope", tokens)).toThrow(AuthError);
  });
});

describe("resolveReadScopes", () => {
  it("defaults to all allowed scopes", () => {
    expect(resolveReadScopes(full).sort()).toEqual(["private", "shared", "work"]);
  });
  it("always includes shared", () => {
    expect(resolveReadScopes(work, ["work"]).sort()).toEqual(["shared", "work"]);
  });
  it("drops requested scopes outside the allowed set", () => {
    // family asks for private; only shared remains.
    expect(resolveReadScopes(family, ["private", "shared"])).toEqual(["shared"]);
  });
  it("throws 403 when no requested scope is readable", () => {
    expect(() => resolveReadScopes(family, ["private", "work"])).toThrow(AuthError);
  });
});

describe("resolveWriteScope", () => {
  it("uses the default when none requested", () => {
    expect(resolveWriteScope(full)).toBe("private");
    expect(resolveWriteScope(family)).toBe("shared");
  });
  it("allows a permitted requested scope", () => {
    expect(resolveWriteScope(work, "shared")).toBe("shared");
  });
  it("rejects writes outside the allowed set", () => {
    expect(() => resolveWriteScope(work, "private")).toThrow(AuthError);
    expect(() => resolveWriteScope(family, "work")).toThrow(AuthError);
  });
});
