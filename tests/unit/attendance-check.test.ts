import { describe, expect, it } from "vitest";

/*
 * Attendance confirmation (docs/ATTENDANCE.md): the pure rules, the link
 * token, the validators and the email. Delivery is in attendance-outbox.test.ts;
 * database behaviour is in tests/integration/attendance-*.db.test.ts.
 */

import {
  ATTENDANCE_NOTE_MAX,
  ATTENDANCE_REMINDER_INTERVAL_MS,
  ATTENDANCE_STATE_LABELS,
  ATTENDANCE_STATES,
  asReleaseOutcome,
  attendanceBadgeLabel,
  attendanceCheckOpen,
  attendanceReplyClosedReason,
  attendanceSendLabel,
  attendanceStateOf,
  describeAttendanceReplies,
  deskAttendanceState,
  isReminderDue,
  parseAnswerPreselect,
} from "@/lib/attendanceCheck";
import { attendanceEligibleRsvpWhere } from "@/lib/attendanceEligibility";
import { attendancePath, generateAttendanceToken, hashAttendanceToken, isAttendanceTokenShape } from "@/lib/attendanceToken";
import { attendanceCheckRefSchema, attendanceCheckSettingsSchema, attendanceLinkSchema, attendanceReplySchema } from "@/lib/validators";
import { buildAttendanceCheckEmail } from "@/lib/email/attendance";

const NOW = new Date("2035-01-01T09:00:00.000Z");
const START = new Date("2035-01-01T10:00:00.000Z");
const token = "a".repeat(43);

describe("attendance link token", () => {
  it("generates 256-bit base64url tokens and stores only their SHA-256", () => {
    const { raw, hash } = generateAttendanceToken();
    expect(raw).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).toBe(hashAttendanceToken(raw));
    expect(hash).not.toContain(raw);
    expect(generateAttendanceToken().raw).not.toBe(raw);
  });

  it("shape-checks before any lookup", () => {
    expect(isAttendanceTokenShape(token)).toBe(true);
    for (const bad of ["a".repeat(42), "a".repeat(44), `${"a".repeat(42)}/`, `${"a".repeat(42)}=`, hashAttendanceToken(token), null, 123]) {
      expect(isAttendanceTokenShape(bad)).toBe(false);
    }
  });

  it("builds the site-relative form path with an optional preselect", () => {
    expect(attendancePath(token)).toBe(`/attend/${token}`);
    expect(attendancePath(token, "yes")).toBe(`/attend/${token}?answer=yes`);
    expect(attendancePath(token, "no")).toBe(`/attend/${token}?answer=no`);
  });
});

describe("attendance rules", () => {
  it("asks only CONFIRMED registrations of one-off events, from one condition", () => {
    expect(attendanceEligibleRsvpWhere("evt_1")).toEqual({ status: "CONFIRMED", eventId: "evt_1" });
    // Without an event: any one-off event, never a series date (eventId null).
    expect(attendanceEligibleRsvpWhere()).toEqual({ status: "CONFIRMED", eventId: { not: null } });
  });

  it("maps a check to the guest's badge state", () => {
    expect(attendanceStateOf(null)).toBe("notAsked");
    expect(attendanceStateOf({ response: null })).toBe("noReply");
    expect(attendanceStateOf({ response: "ATTENDING" })).toBe("coming");
    expect(attendanceStateOf({ response: "NOT_ATTENDING" })).toBe("notComing");
    expect(ATTENDANCE_STATES.map((state) => ATTENDANCE_STATE_LABELS[state])).toEqual(["Coming", "Not coming", "No reply", "Not asked"]);
  });

  it("shows the desk only whether an asked guest replied, never 'Not asked'", () => {
    expect(deskAttendanceState(null)).toBeNull();
    expect(deskAttendanceState({ response: null })).toBe("noReply");
    expect(deskAttendanceState({ response: "NOT_ATTENDING" })).toBe("notComing");
  });

  it("labels a No that kept a paid place 'Said No · paid'", () => {
    expect(attendanceBadgeLabel("notComing", null)).toBe("Not coming");
    expect(attendanceBadgeLabel("notComing", "multiTicket")).toBe("Said No · paid");
    expect(attendanceBadgeLabel("notComing", "notBuyer")).toBe("Said No · paid");
    expect(attendanceBadgeLabel("notComing", "refundRequested")).toBe("Said No · paid");
    expect(attendanceBadgeLabel("notComing", "failed")).toBe("Not coming");
    expect(attendanceBadgeLabel("coming", "multiTicket")).toBe("Coming");
    expect(asReleaseOutcome("refundRequested")).toBe("refundRequested");
    expect(asReleaseOutcome("other")).toBeNull();
    expect(asReleaseOutcome(null)).toBeNull();
  });

  it("stays open strictly until the start", () => {
    expect(attendanceCheckOpen(START, NOW)).toBe(true);
    expect(attendanceCheckOpen(START, START)).toBe(false);
  });

  it("allows one reminder per guest per 12 hours", () => {
    expect(ATTENDANCE_REMINDER_INTERVAL_MS).toBe(12 * 60 * 60 * 1000);
    expect(isReminderDue(new Date(NOW.getTime() - ATTENDANCE_REMINDER_INTERVAL_MS + 1), NOW)).toBe(false);
    expect(isReminderDue(new Date(NOW.getTime() - ATTENDANCE_REMINDER_INTERVAL_MS), NOW)).toBe(true);
  });

  it("explains why the reply form is closed, cancellation first", () => {
    const after = new Date(START.getTime() + 60_000);
    expect(attendanceReplyClosedReason({ eligible: true, eventStart: START, eventStatus: "PUBLISHED", now: NOW })).toBeNull();
    expect(attendanceReplyClosedReason({ eligible: true, eventStart: START, now: after })).toBe("started");
    expect(attendanceReplyClosedReason({ eligible: false, eventStart: START, now: NOW })).toBe("notConfirmed");
    expect(attendanceReplyClosedReason({ eligible: false, eventStart: START, now: after })).toBe("started");
    expect(attendanceReplyClosedReason({ eligible: true, eventStart: START, eventStatus: "CANCELLED", now: after })).toBe("cancelled");
  });

  it("parses only yes and no as a preselect", () => {
    expect(parseAnswerPreselect("yes")).toBe("ATTENDING");
    expect(parseAnswerPreselect(["no", "yes"])).toBe("NOT_ATTENDING");
    for (const value of ["YES", "maybe", "", undefined, null, 1, ["maybe"]]) expect(parseAnswerPreselect(value)).toBeNull();
  });

  it("describes replies and the send button", () => {
    expect(describeAttendanceReplies({ coming: 12, notComing: 3, noReply: 5 })).toBe("Attendance: 12 coming · 3 not coming · 5 no reply");
    expect(attendanceSendLabel(0, true)).toBe("No confirmed guests to ask");
    expect(attendanceSendLabel(0, false)).toBe("Everyone confirmed has been asked");
    expect(attendanceSendLabel(1, true)).toBe("Ask 1 guest to confirm");
    expect(attendanceSendLabel(4, false)).toBe("Ask 4 guests newly confirmed");
  });
});

describe("attendance validators", () => {
  it("accepts strict organisation-scoped references", () => {
    expect(attendanceCheckRefSchema.safeParse({ organisationSlug: "acme", eventId: "evt_1" }).success).toBe(true);
    expect(attendanceCheckRefSchema.safeParse({ organisationSlug: "acme", eventId: "" }).success).toBe(false);
    expect(attendanceCheckRefSchema.safeParse({ organisationSlug: "acme", eventId: "evt_1", force: true }).success).toBe(false);
    expect(attendanceCheckSettingsSchema.safeParse({ organisationSlug: "acme", eventId: "evt_1", releaseOnDecline: true }).success).toBe(true);
    expect(attendanceCheckSettingsSchema.safeParse({ organisationSlug: "acme", eventId: "evt_1", releaseOnDecline: "yes" }).success).toBe(false);
    expect(attendanceLinkSchema.safeParse({ organisationSlug: "acme", eventId: "evt_1", rsvpId: "r_1" }).success).toBe(true);
    expect(attendanceLinkSchema.safeParse({ organisationSlug: "acme", eventId: "evt_1" }).success).toBe(false);
  });

  it("accepts a reply with a trimmed, control-free note", () => {
    const parsed = attendanceReplySchema.parse({ token, response: "NOT_ATTENDING", note: "  Ill\u0000 today\u001b \n" });
    expect(parsed).toEqual({ token, response: "NOT_ATTENDING", note: "Ill  today" });
    expect(attendanceReplySchema.parse({ token, response: "ATTENDING" }).note).toBe("");
    expect(attendanceReplySchema.parse({ token, response: "ATTENDING", note: "a\nb\tc" }).note).toBe("a\nb\tc");
  });

  it("refuses bad tokens, answers, long notes and extra fields", () => {
    expect(attendanceReplySchema.safeParse({ token: "short", response: "ATTENDING" }).success).toBe(false);
    expect(attendanceReplySchema.safeParse({ token, response: "MAYBE" }).success).toBe(false);
    expect(attendanceReplySchema.safeParse({ token, response: "ATTENDING", note: "x".repeat(ATTENDANCE_NOTE_MAX) }).success).toBe(true);
    const long = attendanceReplySchema.safeParse({ token, response: "ATTENDING", note: "x".repeat(ATTENDANCE_NOTE_MAX + 1) });
    expect(long.error?.issues[0]?.message).toBe("Keep the note to 500 characters or fewer.");
    expect(attendanceReplySchema.safeParse({ token, response: "ATTENDING", rsvpId: "rsvp_1" }).success).toBe(false);
  });
});

describe("attendance email", () => {
  const params = {
    eventTitle: "Launch <night>",
    organisationName: "Acme & Co",
    startDateTime: START,
    timezone: "Europe/London",
    location: "Main hall",
    attendPath: `/attend/${token}`,
    recipientName: "Ada",
    baseUrl: "https://events.example.test/",
  };

  it("asks with absolute Yes and No links that preselect the answer", () => {
    const email = buildAttendanceCheckEmail(params);
    expect(email.subject).toBe("Are you still coming to Launch <night>?");
    const yes = `https://events.example.test/attend/${token}?answer=yes`;
    const no = `https://events.example.test/attend/${token}?answer=no`;
    expect(email.html).toContain(`href="${yes}"`);
    expect(email.html).toContain(`href="${no}"`);
    expect(email.text).toContain(`Yes, I'll be there: ${yes}`);
    expect(email.text).toContain(`No, I can't make it: ${no}`);
    expect(email.text).toContain("Where: Main hall");
    // The event is shown in its own timezone (10:00 UTC is 10:00 in London in January).
    expect(email.text).toMatch(/10:00/);
    expect(email.html).toContain("Launch &lt;night&gt;");
    expect(email.html).toContain("Acme &amp; Co");
    expect(email.html).not.toContain("<night>");
    expect(email.text).toContain("Space Works Events");
  });

  it("only says a No gives up the place when that registration would actually be released", () => {
    for (const email of [buildAttendanceCheckEmail(params), buildAttendanceCheckEmail({ ...params, releaseKind: null })]) {
      expect(email.text).not.toMatch(/waitlist|gives up your place|someone else/i);
      expect(email.text).toContain("Your answer helps them plan.");
    }
    const free = buildAttendanceCheckEmail({ ...params, releaseKind: "free" });
    expect(free.html).toContain("answering No gives up your place so someone else can have it");
    expect(free.text).not.toMatch(/waitlist|refund/i);
    const paid = buildAttendanceCheckEmail({ ...params, releaseKind: "paid" });
    expect(paid.text).toContain("cancels your order under the event's refund policy");
  });

  it("marks reminders, omits an empty location and keeps headers single-line", () => {
    const email = buildAttendanceCheckEmail({ ...params, reminder: true, location: "" });
    expect(email.subject).toBe("Reminder: are you still coming to Launch <night>?");
    expect(email.text).not.toContain("Where:");
    expect(buildAttendanceCheckEmail({ ...params, eventTitle: "Launch\r\nBcc: x@example.test" }).subject).not.toMatch(/[\r\n]/);
  });
});
