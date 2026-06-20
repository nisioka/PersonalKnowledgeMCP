import { describe, it, expect } from "vitest";
import { loadConfig } from "../src/config.js";

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
