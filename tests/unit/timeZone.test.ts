import { describe, expect, it } from "vitest";
import { zonedDatetimeLocalValue, zonedInputToIso } from "@/lib/timeZone";

describe("zoned datetime conversion", () => {
  it("does not throw when legacy data contains an invalid timestamp", () => {
    expect(zonedDatetimeLocalValue(new Date("invalid"), "UTC")).toBe("");
  });

  it("preserves a Kolkata wall-clock time as a UTC instant", () => {
    expect(zonedInputToIso("2030-06-15T09:30", "Asia/Kolkata")).toBe("2030-06-15T04:00:00.000Z");
  });

  it("uses daylight-saving offsets and round-trips the wall-clock time", () => {
    const iso = zonedInputToIso("2030-06-15T09:30", "America/New_York");
    expect(iso).toBe("2030-06-15T13:30:00.000Z");
    expect(zonedDatetimeLocalValue(new Date(iso!), "America/New_York")).toBe("2030-06-15T09:30");
  });

  it("rejects a nonexistent time during the daylight-saving transition", () => {
    expect(zonedInputToIso("2030-03-10T02:30", "America/New_York")).toBeNull();
  });

  it("accepts valid times in the hours around a DST change", () => {
    // Before the fix the offset was read at the guessed instant only, so these were refused.
    expect(zonedInputToIso("2026-10-03T19:00", "Australia/Sydney")).toBe("2026-10-03T09:00:00.000Z");
    expect(zonedInputToIso("2026-04-04T19:00", "Australia/Sydney")).toBe("2026-04-04T08:00:00.000Z");
    expect(zonedInputToIso("2026-09-26T19:00", "Pacific/Auckland")).toBe("2026-09-26T07:00:00.000Z");
    expect(zonedInputToIso("2026-03-08T03:30", "America/New_York")).toBe("2026-03-08T07:30:00.000Z");
    expect(zonedInputToIso("2026-03-08T06:59", "America/New_York")).toBe("2026-03-08T10:59:00.000Z");
    expect(zonedInputToIso("2026-03-29T01:30", "Europe/Berlin")).toBe("2026-03-29T00:30:00.000Z");
    expect(zonedInputToIso("2026-10-25T01:30", "Europe/Berlin")).toBe("2026-10-24T23:30:00.000Z");
  });

  it("still refuses the skipped hour and reads a repeated hour as one real instant", () => {
    expect(zonedInputToIso("2026-03-29T02:30", "Europe/Berlin")).toBeNull();
    const repeated = zonedInputToIso("2026-10-25T02:30", "Europe/Berlin");
    expect(["2026-10-25T00:30:00.000Z", "2026-10-25T01:30:00.000Z"]).toContain(repeated);
  });
});
