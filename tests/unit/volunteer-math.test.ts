import { describe, expect, it } from "vitest";
import { canCheckInAt, countedMinutes, formatDuration, formatHours, intervalsOverlap, placesLeft, withinDutyWindow } from "@/lib/volunteer/math";
import { certificateMergeTags, fillCertificateText } from "@/lib/certificateTemplate";
import { crewKindLabel } from "@/lib/crewKind";

/* Shift and hours arithmetic (docs/VOLUNTEERS.md), after the Space Works attendance workflow. */

const at = (minutes: number) => new Date(Date.UTC(2035, 0, 1, 10, 0) + minutes * 60_000);
const shift = { startsAt: at(0), endsAt: at(120), graceMinutes: 15 };

describe("volunteer minutes", () => {
  it("counts whole minutes on duty less breaks", () => {
    expect(countedMinutes(at(0), at(90))).toBe(90);
    expect(countedMinutes(at(0), at(90), 15)).toBe(75);
    expect(countedMinutes(at(0), new Date(at(30).getTime() + 59_000))).toBe(30);
    expect(countedMinutes(at(0), at(0))).toBe(0);
  });

  it("refuses an inverted interval, a negative or fractional break, or a break longer than the duty", () => {
    expect(countedMinutes(at(10), at(0))).toBeNull();
    expect(countedMinutes(at(0), at(30), -1)).toBeNull();
    expect(countedMinutes(at(0), at(30), 1.5)).toBeNull();
    expect(countedMinutes(at(0), at(30), 31)).toBeNull();
    expect(countedMinutes(at(0), at(30), 30)).toBe(0);
  });
});

describe("volunteer windows and overlaps", () => {
  it("treats intervals as half-open, so back-to-back shifts do not overlap", () => {
    expect(intervalsOverlap({ start: at(0), end: at(60) }, { start: at(60), end: at(120) })).toBe(false);
    expect(intervalsOverlap({ start: at(0), end: at(61) }, { start: at(60), end: at(120) })).toBe(true);
    expect(intervalsOverlap({ start: at(10), end: at(20) }, { start: at(0), end: at(120) })).toBe(true);
  });

  it("opens check-in from the grace period before the start until the end", () => {
    expect(canCheckInAt(shift, at(-16))).toBe(false);
    expect(canCheckInAt(shift, at(-15))).toBe(true);
    expect(canCheckInAt(shift, at(119))).toBe(true);
    expect(canCheckInAt(shift, at(120))).toBe(false);
  });

  it("closes check-out the grace period after the end", () => {
    expect(withinDutyWindow(shift, at(135))).toBe(true);
    expect(withinDutyWindow(shift, at(136))).toBe(false);
    expect(withinDutyWindow(shift, at(-16))).toBe(false);
  });

  it("treats capacity 0 as no limit", () => {
    expect(placesLeft(0, 50)).toBeNull();
    expect(placesLeft(3, 1)).toBe(2);
    expect(placesLeft(3, 5)).toBe(0);
  });
});

describe("volunteer labels", () => {
  it("formats hours for certificates and durations for dashboards", () => {
    expect(formatHours(60)).toBe("1 hour");
    expect(formatHours(90)).toBe("1.5 hours");
    expect(formatHours(45)).toBe("0.75 hours");
    expect(formatDuration(45)).toBe("45 min");
    expect(formatDuration(120)).toBe("2 h");
    expect(formatDuration(195)).toBe("3 h 15 min");
  });

  it("fills the contributor merge tags and labels crew kinds", () => {
    const values = { name: "Asha", event: "Launch", eventDate: "1 Jan 2035", organisation: "Space Works", issueDate: "2 Jan 2035", role: "Volunteer · Desk", hours: "6.5 hours" };
    expect(fillCertificateText("{{name}}, {{ role }}, {{hours}}", values)).toBe("Asha, Volunteer · Desk, 6.5 hours");
    expect(Object.keys(certificateMergeTags)).toEqual(expect.arrayContaining(["role", "hours"]));
    expect(crewKindLabel("MENTOR")).toBe("Mentor");
    expect(crewKindLabel(null)).toBe("Crew");
  });
});
