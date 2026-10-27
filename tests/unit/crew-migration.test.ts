import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");
const sql = readFileSync(resolve(root, "prisma/migrations/20261110000000_event_crew/migration.sql"), "utf8");
const verifier = readFileSync(resolve(root, "scripts/verify-production-schema.mjs"), "utf8");

describe("event crew migration (docs/CREW.md)", () => {
  it("is additive: no drops, updates or deletes", () => {
    const statements = sql.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n");
    expect(statements).not.toMatch(/^\s*(DROP|UPDATE|DELETE|TRUNCATE)\b/im);
    expect(statements).not.toMatch(/DROP (TABLE|COLUMN|CONSTRAINT|INDEX)/i);
    expect(sql).toContain(`ALTER TYPE "EventPageSectionType" ADD VALUE 'CREW';`);
    expect(sql).toContain(`ALTER TYPE "ExpenseClaimKind" ADD VALUE 'CREW';`);
    expect(sql).toContain(`ADD COLUMN     "isCrew" BOOLEAN NOT NULL DEFAULT false;`);
    expect(sql).toContain(`ADD COLUMN     "crewClaimsEnabled" BOOLEAN NOT NULL DEFAULT false;`);
  });

  it("keeps a crew ticket free, confirmed, team-less and event-bound in the database", () => {
    expect(sql).toMatch(/ADD CONSTRAINT "RSVP_crew_shape"\s+CHECK \(NOT "isCrew" OR \("eventId" IS NOT NULL AND "teamId" IS NULL AND "status" = 'CONFIRMED' AND "orderId" IS NULL AND "ticketTypeId" IS NULL\)\) NOT VALID;/);
    expect(sql).toContain(`ALTER TABLE "RSVP" VALIDATE CONSTRAINT "RSVP_crew_shape";`);
    expect(sql).toContain(`FOREIGN KEY ("rsvpId") REFERENCES "RSVP"("id") ON DELETE CASCADE`);
    expect(sql).toContain(`CREATE UNIQUE INDEX "EventCrewMember_eventId_email_key"`);
    expect(sql).toContain(`CREATE UNIQUE INDEX "EventCrewJoinLink_token_key"`);
  });

  it("is checked by the production schema verifier", () => {
    for (const name of ["EventCrewMember", "EventCrewJoinLink", "RSVP_crew_shape", "EventCrewMember_rsvpId_fkey", "crewClaimsEnabled"]) expect(verifier).toContain(name);
  });
});
