/**
 * Log redaction. The audit logger (and the error path) funnel through here so
 * that sensitive values — My Number, passwords/passphrases, bearer tokens —
 * never reach stderr/journald in the clear, even if a future call site
 * accidentally puts document content into a log detail.
 *
 * This is defence-in-depth, not the primary control: keep secrets out of logs
 * at the call site too. But a single choke point means one place to harden.
 */

const REDACTED = "[REDACTED]";

/**
 * Object keys whose VALUE should be dropped wholesale. Matched case-insensitively
 * as a substring of the key, with word boundaries where a bare word would be too
 * greedy (so `pin` matches a `pin` field but not `spinner`).
 */
const SENSITIVE_KEY =
  /pass(word|phrase)?|secret|credential|token|bearer|api[_-]?key|\bpin\b|パスワード|合言葉|個人番号|マイナンバー|my[\s_-]?number/i;

/**
 * Japanese individual number (マイナンバー): exactly 12 digits, optionally
 * grouped 4-4-4 by a space or hyphen. The word boundaries keep longer numeric
 * IDs (13+ digits) from being partially matched.
 */
const MY_NUMBER = /\b\d{4}[-\s]?\d{4}[-\s]?\d{4}\b/g;

/** `Authorization: Bearer <token>` style secrets embedded in free text. */
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;

/** Redact sensitive patterns inside a single string. */
export function redactString(s: string): string {
  return s.replace(BEARER, "Bearer [REDACTED]").replace(MY_NUMBER, "[REDACTED:id]");
}

/**
 * Deep-copy `value`, redacting sensitive keys (by name) and sensitive patterns
 * (inside strings). Arrays and nested objects are walked recursively.
 */
export function redact(value: unknown, keyHint?: string): unknown {
  if (keyHint !== undefined && SENSITIVE_KEY.test(keyHint)) return REDACTED;
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) return value.map((v) => redact(v));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = redact(v, k);
    return out;
  }
  return value;
}
