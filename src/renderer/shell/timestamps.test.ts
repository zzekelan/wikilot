import { describe, expect, it } from "vitest";
import {
  formatRelativeTime,
  formatTimestampLabel,
  shouldShowTimestamp,
  TIMESTAMP_VISIBLE_GAP_MS,
} from "./timestamps";

describe("shouldShowTimestamp", () => {
  it("shows when there is no previous message", () => {
    expect(shouldShowTimestamp(undefined, 1000)).toBe(true);
  });

  it("hides within the 5-minute gap", () => {
    const at = Date.UTC(2026, 0, 1, 12, 0, 0);
    expect(shouldShowTimestamp(at, at + TIMESTAMP_VISIBLE_GAP_MS - 1)).toBe(false);
  });

  it("shows at or beyond the 5-minute gap", () => {
    const at = Date.UTC(2026, 0, 1, 12, 0, 0);
    expect(shouldShowTimestamp(at, at + TIMESTAMP_VISIBLE_GAP_MS)).toBe(true);
  });

  it("shows across calendar day boundaries", () => {
    const day1 = new Date(2026, 0, 1, 23, 59, 30).getTime();
    const day2 = new Date(2026, 0, 2, 0, 0, 30).getTime();
    expect(shouldShowTimestamp(day1, day2)).toBe(true);
  });
});

describe("formatTimestampLabel", () => {
  it("shows HH:MM within the same day", () => {
    const at = new Date(2026, 0, 1, 9, 5).getTime();
    const now = new Date(2026, 0, 1, 18, 30).getTime();
    expect(formatTimestampLabel(at, now)).toBe("09:05");
  });

  it("shows MM/DD HH:MM within the same year", () => {
    const at = new Date(2026, 0, 1, 9, 5).getTime();
    const now = new Date(2026, 2, 1, 18, 30).getTime();
    expect(formatTimestampLabel(at, now)).toBe("01/01 09:05");
  });

  it("shows the full date across years", () => {
    const at = new Date(2025, 11, 31, 9, 5).getTime();
    const now = new Date(2026, 0, 1, 0, 0).getTime();
    expect(formatTimestampLabel(at, now)).toBe("2025/12/31 09:05");
  });
});

describe("formatRelativeTime", () => {
  const now = new Date(2026, 0, 8, 12, 0, 0).getTime();

  it("shows now within the first minute", () => {
    expect(formatRelativeTime(now - 30_000, now)).toBe("now");
  });

  it("shows minutes within the hour", () => {
    expect(formatRelativeTime(now - 2 * 60_000, now)).toBe("2m ago");
  });

  it("shows hours within the day", () => {
    expect(formatRelativeTime(now - 5 * 3_600_000, now)).toBe("5h ago");
  });

  it("shows days within the week", () => {
    expect(formatRelativeTime(now - 3 * 86_400_000, now)).toBe("3d ago");
  });

  it("shows MM/DD beyond a week within the same year", () => {
    expect(formatRelativeTime(new Date(2026, 0, 1, 9, 5).getTime(), now)).toBe(
      "01/01",
    );
  });

  it("shows the full date across years", () => {
    expect(formatRelativeTime(new Date(2025, 11, 20, 9, 5).getTime(), now)).toBe(
      "2025/12/20",
    );
  });
});
