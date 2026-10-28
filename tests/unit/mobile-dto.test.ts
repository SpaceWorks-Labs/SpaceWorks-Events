import { describe, expect, it } from "vitest";
import { absoluteUrl, toGuest, toRegistrationField, toUserDto } from "@/lib/mobile/dto";
import { eventPermissionsFor, canSeeGuests } from "@/lib/mobile/permissions";
import { guestSchema, rosterDtoSchema, sessionDtoSchema, userDtoSchema, registrationDtoSchema } from "@/lib/mobile/schemas";
import { toCheckInResult } from "@/lib/mobile/checkIn";

const base = "https://yuyu.example";

describe("mobile DTOs", () => {
  it("maps a user without credential or MFA material", () => {
    const record = {
      id: "u1", name: "Ada", email: "ada@example.test", image: null, profileImageUrl: "/api/uploads/users/u1/profile-images/a.webp",
      emailVerified: new Date(), mfaEnabledAt: null,
      passwordHash: "$2b$12$secret", mfaSecretEncrypted: "v1.secret", recoveryCodeHashes: ["x"], sessionVersion: 4,
    };
    const dto = toUserDto(record, base);
    expect(dto).toEqual({ id: "u1", name: "Ada", email: "ada@example.test", imageUrl: `${base}/api/uploads/users/u1/profile-images/a.webp`, emailVerified: true, mfaEnabled: false });
    const serialized = JSON.stringify(dto);
    for (const forbidden of ["passwordHash", "$2b$", "mfaSecret", "recoveryCode", "sessionVersion"]) expect(serialized).not.toContain(forbidden);
  });

  it("rejects unexpected fields in strict response schemas", () => {
    const user = { id: "u1", name: null, email: null, imageUrl: null, emailVerified: false, mfaEnabled: false };
    expect(userDtoSchema.safeParse({ ...user, passwordHash: "x" }).success).toBe(false);
    expect(userDtoSchema.safeParse({ ...user, mfaSecretEncrypted: "x" }).success).toBe(false);
    expect(sessionDtoSchema.safeParse({ accessToken: "a", accessTokenExpiresAt: new Date().toISOString(), refreshToken: "r", refreshTokenExpiresAt: new Date().toISOString(), user, sessionVersion: 1 }).success).toBe(false);
    const guest = { rsvpId: "r1", displayName: "G", email: null, status: "CONFIRMED", checkedInAt: null, registeredAt: new Date().toISOString(), isGuest: true };
    // A guest-list row never carries a ticket token; only the CHECK_IN roster does.
    expect(guestSchema.safeParse({ ...guest, ticketToken: "secret" }).success).toBe(false);
    expect(guestSchema.safeParse({ ...guest, checkInToken: "secret" }).success).toBe(false);
    expect(rosterDtoSchema.safeParse({ generatedAt: new Date().toISOString(), rows: [{ ...guest, ticketToken: "t", checkInDetails: [], registrationDetails: [] }] }).success).toBe(true);
    expect(registrationDtoSchema.shape.ticketToken.safeParse(null).success).toBe(true);
  });

  it("never returns the web print QR token from check-in results", () => {
    const result = toCheckInResult({
      rsvpId: "r1", displayName: "G", email: null, status: "CONFIRMED", alreadyCheckedIn: false, checkedInAt: null,
      checkInQrToken: "bearer-ticket-token", checkInDetails: [], registrationDetails: [{ key: "diet", label: "Diet", value: "Vegan" }],
    });
    expect(JSON.stringify(result)).not.toContain("bearer-ticket-token");
    expect(result.registrationDetails).toEqual([{ label: "Diet", value: "Vegan" }]);
  });

  it("resolves only http(s) and site-relative image URLs", () => {
    expect(absoluteUrl("/api/uploads/x.webp", base)).toBe(`${base}/api/uploads/x.webp`);
    expect(absoluteUrl("https://cdn.example/x.webp", base)).toBe("https://cdn.example/x.webp");
    expect(absoluteUrl("javascript:alert(1)", base)).toBeNull();
    expect(absoluteUrl("//evil.example/x", base)).toBeNull();
    expect(absoluteUrl("", base)).toBeNull();
  });

  it("maps guests and registration fields explicitly", () => {
    const guest = toGuest({ id: "r1", status: "WAITLISTED", checkedInAt: null, createdAt: new Date("2030-01-01T00:00:00Z"), userId: null, guestName: " Bo ", guestEmail: "bo@example.test", user: null });
    expect(guest).toEqual({ rsvpId: "r1", displayName: "Bo", email: "bo@example.test", status: "WAITLISTED", checkedInAt: null, registeredAt: "2030-01-01T00:00:00.000Z", isGuest: true });
    const field = toRegistrationField({ id: "f1", key: "diet", label: "Diet", type: "SELECT", required: false, options: ["A", 3, "B"], helpText: "", placeholder: null, settings: { allowOther: true, maxLength: 9, showIf: { fieldKey: "attending", values: ["Yes"] } } });
    expect(field).toEqual({ id: "f1", key: "diet", label: "Diet", type: "SELECT", required: false, helpText: null, placeholder: null, options: ["A", "B"], settings: { allowOther: true }, showIf: { fieldKey: "attending", values: ["Yes"] } });
  });

  it("derives permissions like the event dashboard", () => {
    const extras = { checkInToLists: true, manageOrders: false, manageCrew: false, fileClaims: true, manageFinance: false, manageApplications: false, reviewApplications: false };
    const checkInOnly = eventPermissionsFor(null, ["CHECK_IN"]);
    expect(checkInOnly).toEqual({ checkIn: true, manageRegistrations: false, sendEmails: false, schedule: false, manageFeedback: false, manageRegistrationWindow: false, judge: false, ...extras });
    expect(canSeeGuests(checkInOnly)).toBe(true);
    expect(canSeeGuests(eventPermissionsFor(null, ["EDIT_DETAILS"]))).toBe(false);
    expect(eventPermissionsFor("ADMIN", [])).toEqual({ checkIn: true, manageRegistrations: true, sendEmails: true, schedule: true, manageFeedback: true, manageRegistrationWindow: true, judge: false, checkInToLists: true, manageOrders: true, manageCrew: true, fileClaims: true, manageFinance: true, manageApplications: false, reviewApplications: false });
    // Space Works: the MANAGE_REGISTRATIONS grant manages guests and orders, as on the web.
    expect(eventPermissionsFor(null, ["MANAGE_REGISTRATIONS"])).toMatchObject({ manageRegistrations: true, manageOrders: true, manageCrew: true, manageFinance: false });
    // A plain member files claims but decides nothing.
    expect(eventPermissionsFor("MEMBER", [])).toMatchObject({ fileClaims: true, manageFinance: false, checkIn: false });
    // Judging: OWNER/ADMIN or the JUDGE grant, only once the event takes submissions.
    expect(eventPermissionsFor("OWNER", [], { submissionsEnabled: true }).judge).toBe(true);
    expect(eventPermissionsFor(null, ["JUDGE"], { submissionsEnabled: true }).judge).toBe(true);
    expect(eventPermissionsFor(null, ["JUDGE"]).judge).toBe(false);
    expect(eventPermissionsFor(null, ["CHECK_IN", "MANAGE_REGISTRATIONS"], { submissionsEnabled: true }).judge).toBe(false);
    // JUDGE never satisfies any other organiser flag; like any grant, it files its own staff claims (docs/FINANCE.md).
    expect(eventPermissionsFor(null, ["JUDGE"], { submissionsEnabled: true })).toEqual({ checkIn: false, manageRegistrations: false, sendEmails: false, schedule: false, manageFeedback: false, manageRegistrationWindow: false, judge: true, checkInToLists: false, manageOrders: false, manageCrew: false, fileClaims: true, manageFinance: false, manageApplications: false, reviewApplications: false });
    // MENTOR and REVIEW_APPLICATIONS are isolated like JUDGE: their console only, no organiser flags but their own claims.
    for (const grant of ["MENTOR", "REVIEW_APPLICATIONS"] as const) {
      const { fileClaims, ...rest } = eventPermissionsFor(null, [grant]);
      expect(fileClaims).toBe(true);
      expect(Object.values(rest).some(Boolean)).toBe(false);
    }
    expect(eventPermissionsFor(null, []).fileClaims).toBe(false);
    // Applications (docs/ADMISSION.md): only on events taking them; REVIEW_APPLICATIONS opens the review workspace alone.
    expect(eventPermissionsFor(null, ["MANAGE_REGISTRATIONS"], { admissionEnabled: true })).toMatchObject({ manageApplications: true, reviewApplications: false });
    expect(eventPermissionsFor("OWNER", [], { admissionEnabled: true })).toMatchObject({ manageApplications: true, reviewApplications: true });
    expect(eventPermissionsFor("OWNER", [])).toMatchObject({ manageApplications: false, reviewApplications: false });
    const reviewer = eventPermissionsFor(null, ["REVIEW_APPLICATIONS"], { admissionEnabled: true });
    expect(Object.entries(reviewer).filter(([, value]) => value).map(([key]) => key)).toEqual(["fileClaims", "reviewApplications"]);
  });

});
