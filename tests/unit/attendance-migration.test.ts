import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");
const sqlOf = (name: string) => readFileSync(resolve(root, `prisma/migrations/${name}/migration.sql`), "utf8").split("\n").filter((line) => !line.trim().startsWith("--")).join("\n");

describe("attendance confirmation migration", () => {
  it("adds a new table and one defaulted Event column, with no scheduling fields", () => {
    const code = sqlOf("20261111000000_attendance_confirmation");
    expect(code).not.toMatch(/\b(DROP|INSERT|RENAME)\b/i);
    expect(code).not.toMatch(/^\s*(UPDATE|DELETE)\s/im);
    // The only change to an existing table is one column with a constant default.
    expect(code.match(/ALTER TABLE "Event"/g)).toHaveLength(1);
    expect(code).toContain('ALTER TABLE "Event" ADD COLUMN "attendanceCheckReleaseOnDecline" BOOLEAN NOT NULL DEFAULT false;');
    expect(code).not.toMatch(/ALTER TABLE "(RSVP|User|Organisation|OutboxMessage|Order)"/);
    // Sending is manual only: nothing in the schema schedules a send.
    expect(code).not.toMatch(/schedul|sendAt|autoSend|leadHours/i);
    expect(code).toContain(`CREATE TYPE "AttendanceResponse" AS ENUM ('ATTENDING', 'NOT_ATTENDING');`);
    expect(code).toContain('CREATE UNIQUE INDEX "AttendanceCheck_rsvpId_key" ON "AttendanceCheck"("rsvpId");');
    expect(code).toContain('CREATE UNIQUE INDEX "AttendanceCheck_tokenHash_key" ON "AttendanceCheck"("tokenHash");');
    expect(code).toContain('CREATE INDEX "AttendanceCheck_eventId_response_idx" ON "AttendanceCheck"("eventId", "response");');
    expect(code).toContain(`"AttendanceCheck_token_hash_shape" CHECK ("tokenHash" ~ '^[0-9a-f]{64}$')`);
    expect(code).toContain('"AttendanceCheck_note_length" CHECK ("note" IS NULL OR char_length("note") <= 500)');
    expect(code).toContain('"AttendanceCheck_response_pair" CHECK (("response" IS NULL) = ("respondedAt" IS NULL))');
    expect(code).toContain('"AttendanceCheck_release_outcome" CHECK');
    expect(code).toContain('"AttendanceCheck_rsvpId_fkey" FOREIGN KEY ("rsvpId") REFERENCES "RSVP"("id") ON DELETE CASCADE');
    expect(code).toContain('"AttendanceCheck_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE');
  });

  it("adds the follow-up columns in their own additive migration", () => {
    const code = sqlOf("20261111000100_attendance_followups");
    expect(code).not.toMatch(/\b(DROP|INSERT|RENAME)\b/i);
    expect(code).not.toMatch(/^\s*(UPDATE|DELETE)\s/im);
    expect(code).toContain('ADD COLUMN "organisersNotifiedAt" TIMESTAMP(3)');
    expect(code).toContain('ADD COLUMN "refundRequestOpenedAt" TIMESTAMP(3)');
    expect(code).toContain('ADD COLUMN "refundRequestId" TEXT');
    expect(code).toContain('"AttendanceCheck_refundRequestId_fkey" FOREIGN KEY ("refundRequestId") REFERENCES "RefundRequest"("id") ON DELETE SET NULL');
  });

  it("makes the production schema check require every attendance object, with the right deletes", () => {
    const script = readFileSync(resolve(root, "scripts/verify-production-schema.mjs"), "utf8");
    for (const name of ["AttendanceCheck_token_hash_shape", "AttendanceCheck_note_length", "AttendanceCheck_response_pair", "AttendanceCheck_release_outcome", "AttendanceCheck_rsvpId_key", "AttendanceCheck_tokenHash_key", "AttendanceCheck_eventId_response_idx", "AttendanceCheck_refundRequestId_idx", "attendanceCheckReleaseOnDecline"]) {
      expect(script).toContain(name);
    }
    expect(script).toContain('["AttendanceCheck_rsvpId_fkey", "AttendanceCheck_eventId_fkey"].filter((name) => !attendanceConstraints.some((row) => row.conname === name && row.confdeltype === "c"))');
    expect(script).toContain('row.conname === "AttendanceCheck_refundRequestId_fkey" && row.confdeltype === "n"');
  });
});
