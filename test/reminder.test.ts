import { describe, it, expect } from "vitest";
import { formatReminder } from "../src/reminders/reminder.js";
import type { UpcomingExpiry } from "../src/types.js";

const item = (over: Partial<UpcomingExpiry>): UpcomingExpiry => ({
  id: 1,
  doc_type: "保証書",
  scope: "private",
  valid_until: "2026-07-01",
  snippet: "電子レンジの保証",
  days_left: 5,
  ...over,
});

describe("formatReminder", () => {
  it("returns null when nothing is upcoming", () => {
    expect(formatReminder([], 14)).toBeNull();
  });

  it("summarizes upcoming items with days left and type", () => {
    const msg = formatReminder([item({}), item({ id: 2, days_left: 0, doc_type: null })], 14);
    expect(msg).toContain("2 件");
    expect(msg).toContain("あと5日");
    expect(msg).toContain("[保証書]");
    expect(msg).toContain("今日");
  });
});
