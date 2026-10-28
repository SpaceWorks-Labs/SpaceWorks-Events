import { describe, expect, it } from "vitest";
import { z } from "zod";
import { secretFields } from "@/lib/frontend/secretFields";
import * as dto from "@/lib/mobile/schemas";

/*
 * No mobile response DTO may carry a secret: the fields the frontend split
 * already forbids, an order's access token, team manage or join tokens,
 * submission links, or a ticket token anywhere but the places that hold the
 * caller's own confirmed ticket.
 */

const MOBILE_FORBIDDEN = new Set([
  ...secretFields,
  "accessToken", "orderToken", "manageToken", "teamManageToken", "joinToken", "teamJoinToken",
  "submissionToken", "submissionLink", "checkInToken", "checkInQrToken", "certificateToken",
]);

/** DTOs allowed to carry a ticket token; each is the caller's own CONFIRMED ticket (or, for the roster, the staff desk's offline copy). */
const TICKET_TOKEN_ALLOWED = new Set(["registrationDtoSchema", "registrationsDtoSchema", "publicEventDtoSchema", "rsvpResultDtoSchema", "paidRsvpResultSchema", "orderTicketSchema", "orderDetailDtoSchema", "seriesDateDtoSchema", "rosterDtoSchema"]);

function keysOf(schema: z.ZodType) {
  const keys = new Set<string>();
  const walk = (node: unknown) => {
    if (Array.isArray(node)) node.forEach(walk);
    else if (node && typeof node === "object") {
      const properties = (node as { properties?: Record<string, unknown>; }).properties;
      if (properties) for (const key of Object.keys(properties)) keys.add(key);
      Object.values(node).forEach(walk);
    }
  };
  walk(z.toJSONSchema(schema, { unrepresentable: "any" }));
  return keys;
}

const schemas = Object.entries(dto as Record<string, unknown>).filter((entry): entry is [string, z.ZodType] => entry[1] instanceof z.ZodType);

describe("mobile DTO secrets", () => {
  it("covers the response schemas", () => {
    expect(schemas.length).toBeGreaterThan(40);
  });

  it.each(schemas.filter(([name]) => name !== "sessionDtoSchema"))("%s carries no secret field", (_name, schema) => {
    expect([...keysOf(schema)].filter((key) => MOBILE_FORBIDDEN.has(key))).toEqual([]);
  });

  it("allows the session's own tokens only in the session DTO", () => {
    expect([...keysOf(dto.sessionDtoSchema)].filter((key) => MOBILE_FORBIDDEN.has(key))).toEqual(["accessToken"]);
  });

  it.each(schemas.filter(([name]) => !TICKET_TOKEN_ALLOWED.has(name)))("%s carries no ticket token", (_name, schema) => {
    expect(keysOf(schema).has("ticketToken")).toBe(false);
  });

  it("walks into the mentor round's form questions and visit leases", () => {
    const keys = keysOf(dto.mentorConsoleDtoSchema);
    for (const key of ["label", "options", "leaseId", "generation"]) expect(keys.has(key)).toBe(true);
  });

  it("never returns a ticket for a paid place not yet paid", () => {
    const paid = { rsvpId: "r1", status: "PENDING_PAYMENT", orderId: "o1", checkoutUrl: null, holdExpiresAt: null };
    expect(dto.rsvpResultDtoSchema.safeParse({ ...paid, ticketToken: null }).success).toBe(true);
    expect(dto.rsvpResultDtoSchema.safeParse({ ...paid, ticketToken: "tk_secret" }).success).toBe(false);
    expect(dto.rsvpResultDtoSchema.safeParse({ rsvpId: "r1", status: "PENDING_PAYMENT", ticketToken: "tk_secret" }).success).toBe(false);
  });
});
