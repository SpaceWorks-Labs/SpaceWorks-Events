import { describe, expect, it } from "vitest";
import { addWallClockHours, checkSchedule, nextWholeHour } from "@/components/event/CreateEventDialog/helpers";

// The New event dialog keeps start and end as wall-clock values on the
// event's clock; the browser's own timezone never enters the calculation.

describe("New event schedule helpers", () => {
  it("suggests a whole hour on the event's clock at least 30 minutes away", () => {
    const now = Date.parse("2030-06-15T10:40:00Z"); // 16:10 in Asia/Kolkata
    expect(nextWholeHour("Asia/Kolkata", now)).toBe("2030-06-15T17:00");
    expect(nextWholeHour("UTC", now)).toBe("2030-06-15T12:00");
  });

  it("adds hours by the calendar, across midnight", () => {
    expect(addWallClockHours("2030-06-15T23:00", 1)).toBe("2030-06-16T00:00");
    expect(addWallClockHours("", 1)).toBe("");
  });

  it("converts on the chosen clock and explains the first problem", () => {
    const now = new Date("2030-01-01T00:00:00Z");
    expect(checkSchedule("2030-06-15T19:00", "2030-06-15T21:00", "Asia/Kolkata", now)).toEqual({
      startIso: "2030-06-15T13:30:00.000Z",
      endIso: "2030-06-15T15:30:00.000Z",
    });
    expect(checkSchedule("", "2030-06-15T21:00", "UTC", now)).toEqual({ error: "Please select both start and end times." });
    expect(checkSchedule("2029-06-15T19:00", "2029-06-15T21:00", "UTC", now)).toEqual({ error: "Start time must be now or in the future." });
    expect(checkSchedule("2030-06-15T19:00", "2030-06-15T19:00", "UTC", now)).toEqual({ error: "End time must be after start time." });
    // 02:30 on 2030-03-10 is skipped by the US spring-forward change.
    expect(checkSchedule("2030-03-10T02:30", "2030-03-10T04:00", "America/New_York", now)).toEqual({ error: "That start time does not exist in America/New_York." });
  });
});
