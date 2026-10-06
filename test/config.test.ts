import { describe, it, expect } from "vitest";
import { isLoopbackHost, loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("falls back to dev tokens when PK_TOKENS is unset", () => {
    const cfg = loadConfig({});
    expect(cfg.usingDevTokens).toBe(true);
    expect(cfg.tokens.get("full-dev-token")?.scopes.sort()).toEqual(["private", "shared", "work"]);
    expect(cfg.host).toBe("127.0.0.1");
  });

  it("parses PK_TOKENS and always adds shared", () => {
    const cfg = loadConfig({
      PK_TOKENS: JSON.stringify({ "tok-w": { name: "work", scopes: ["work"] } }),
    });
    expect(cfg.usingDevTokens).toBe(false);
    const p = cfg.tokens.get("tok-w")!;
    expect(p.scopes.sort()).toEqual(["shared", "work"]);
    expect(p.defaultWriteScope).toBe("work"); // first non-shared scope
  });

  it("rejects unknown scopes", () => {
    expect(() =>
      loadConfig({ PK_TOKENS: JSON.stringify({ t: { name: "x", scopes: ["bogus"] } }) }),
    ).toThrow();
  });

  it("rejects a defaultWriteScope not in scopes", () => {
    expect(() =>
      loadConfig({
        PK_TOKENS: JSON.stringify({ t: { name: "x", scopes: ["shared"], defaultWriteScope: "work" } }),
      }),
    ).toThrow();
  });

  it("fails closed when PK_TOKENS is set but empty (no silent dev-token fallback)", () => {
    expect(() => loadConfig({ PK_TOKENS: "" })).toThrow();
    expect(() => loadConfig({ PK_TOKENS: "   " })).toThrow();
  });

  it("rejects an out-of-range PK_PORT", () => {
    expect(() => loadConfig({ PK_PORT: "70000" })).toThrow();
    expect(() => loadConfig({ PK_PORT: "abc" })).toThrow();
  });
});

describe("isLoopbackHost", () => {
  it("accepts the whole 127.0.0.0/8 block, localhost and ::1", () => {
    for (const h of ["127.0.0.1", "127.1.2.3", "localhost", "LocalHost", "::1", "[::1]", "::ffff:127.0.0.1"]) {
      expect(isLoopbackHost(h)).toBe(true);
    }
  });

  it("rejects wildcard binds, LAN addresses and hostnames", () => {
    for (const h of ["0.0.0.0", "::", "[::]", "192.168.1.10", "10.0.0.2", "pk.example.com"]) {
      expect(isLoopbackHost(h)).toBe(false);
    }
  });

  it("fails closed on an empty host (Node expands it to all interfaces)", () => {
    expect(isLoopbackHost("")).toBe(false);
    expect(isLoopbackHost("   ")).toBe(false);
  });

  it("does not treat a 127-prefixed public address as loopback", () => {
    // 127 has to be the FIRST octet, not merely present somewhere.
    expect(isLoopbackHost("12.7.0.1")).toBe(false);
    expect(isLoopbackHost("1.127.0.1")).toBe(false);
  });
});
