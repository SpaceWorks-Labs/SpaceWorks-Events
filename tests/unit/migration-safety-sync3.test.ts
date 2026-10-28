import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");
const migration = (name: string) => readFileSync(resolve(root, `prisma/migrations/${name}/migration.sql`), "utf8");
const statementsOf = (sql: string) =>
  sql
    .split("\n")
    .filter((line) => line.trim() && !line.trim().startsWith("--"))
    .join("\n")
    .split(";")
    .map((statement) => statement.trim())
    .filter(Boolean);

describe("third Yuyu sync migration contracts", () => {
  it("drops only the orphaned EventSessionType enum", () => {
    expect(statementsOf(migration("20261107020000_drop_orphan_event_session_type"))).toEqual(['DROP TYPE IF EXISTS "EventSessionType"']);
  });

  it("adds the large-event indexes with CREATE INDEX only", () => {
    const sql = migration("20261108000000_large_event_indexes");
    const statements = statementsOf(sql);
    expect(statements).toHaveLength(6);
    // Prisma applies a migration in a transaction, so no CONCURRENTLY; IF NOT EXISTS lets operators pre-build them.
    for (const statement of statements) expect(statement).toMatch(/^CREATE INDEX IF NOT EXISTS "[A-Za-z_]+" ON "(RSVP|Team|Submission|EventInvite)"\("[A-Za-z]+"(, "[A-Za-z]+")*\)$/);
    expect(statements.join("\n")).not.toMatch(/\b(DROP|ALTER|UPDATE|DELETE|INSERT|UNIQUE|CONCURRENTLY)\b/i);
    expect(sql).toContain('CREATE INDEX IF NOT EXISTS "RSVP_eventId_createdAt_id_idx" ON "RSVP"("eventId", "createdAt", "id");');
    expect(sql).toContain('CREATE INDEX IF NOT EXISTS "Submission_eventId_status_submittedAt_id_idx" ON "Submission"("eventId", "status", "submittedAt", "id");');
  });

  it("adds the hackathon email switches as NOT NULL DEFAULT false columns without rewriting rows", () => {
    const statements = statementsOf(migration("20261109000000_hackathon_email_toggles"));
    expect(statements).toEqual([
      'ALTER TABLE "Event" ADD COLUMN "emailEntrantsOnResults" BOOLEAN NOT NULL DEFAULT false',
      'ALTER TABLE "Event" ADD COLUMN "emailSubmissionReceipts" BOOLEAN NOT NULL DEFAULT false',
    ]);
  });
});
