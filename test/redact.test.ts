import { describe, it, expect, vi } from "vitest";
import { redact, redactString } from "../src/redact.js";
import { audit } from "../src/audit.js";

describe("redactString", () => {
  it("masks a plain 12-digit My Number", () => {
    expect(redactString("番号は123456789012です")).toBe("番号は[REDACTED:id]です");
  });

  it("masks a 4-4-4 grouped My Number (space or hyphen)", () => {
    expect(redactString("1234-5678-9012")).toBe("[REDACTED:id]");
    expect(redactString("1234 5678 9012")).toBe("[REDACTED:id]");
  });

  it("leaves shorter/longer numeric ids alone", () => {
    expect(redactString("tel 09012345678")).toBe("tel 09012345678"); // 11 digits
    expect(redactString("id 1234567890123")).toBe("id 1234567890123"); // 13 digits
  });

  it("masks bearer tokens", () => {
    expect(redactString("Authorization: Bearer abc.DEF-123_x")).toBe(
      "Authorization: Bearer [REDACTED]",
    );
  });
});

describe("redact (deep)", () => {
  it("drops values of sensitive keys", () => {
    const out = redact({ password: "hunter2", PassPhrase: "x", apiKey: "k", scope: "private" });
    expect(out).toEqual({
      password: "[REDACTED]",
      PassPhrase: "[REDACTED]",
      apiKey: "[REDACTED]",
      scope: "private",
    });
  });

  it("masks Japanese secret-bearing keys", () => {
    expect(redact({ マイナンバー: "123456789012", 合言葉: "s" })).toEqual({
      マイナンバー: "[REDACTED]",
      合言葉: "[REDACTED]",
    });
  });

  it("recurses into arrays and nested objects", () => {
    const out = redact({ items: [{ full_text: "個人番号 123456789012" }], id: 3 });
    expect(out).toEqual({ items: [{ full_text: "個人番号 [REDACTED:id]" }], id: 3 });
  });

  it("passes through non-sensitive primitives", () => {
    expect(redact({ id: 3, scope: "private", deleted: false })).toEqual({
      id: 3,
      scope: "private",
      deleted: false,
    });
  });
});

describe("audit() masking", () => {
  it("redacts sensitive content before writing to stderr", () => {
    let line = "";
    const spy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk: unknown) => {
        line += String(chunk);
        return true;
      });
    try {
      audit("register", "full", { full_text: "マイナンバー 123456789012", token: "secret-xyz" });
    } finally {
      spy.mockRestore();
    }
    expect(line).not.toContain("123456789012");
    expect(line).not.toContain("secret-xyz");
    expect(line).toContain("[REDACTED:id]");
    expect(line).toContain('"token":"[REDACTED]"');
  });
});
