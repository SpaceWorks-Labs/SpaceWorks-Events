import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");

describe("production migration safety contracts", () => {
  it("preserves standalone schedule rows before replacing their legacy column", () => {
    const sql = readFileSync(resolve(root, "prisma/migrations/20260828130000_event_website_program/migration.sql"), "utf8");
    const backup = sql.indexOf('CREATE TEMP TABLE "_standalone_schedule_migration"');
    const deletion = sql.indexOf('DELETE FROM "EventScheduleItem" WHERE "eventId" IS NOT NULL');
    const restore = sql.indexOf('FROM "_standalone_schedule_migration";');
    expect(backup).toBeGreaterThanOrEqual(0);
    expect(deletion).toBeGreaterThan(backup);
    expect(restore).toBeGreaterThan(deletion);
  });

  it("restores cascade-safe auditing and covers collaborator security tables", () => {
    const sql = readFileSync(resolve(root, "prisma/migrations/20260829180000_production_readiness_integrity/migration.sql"), "utf8");
    expect(sql).toContain("IF TG_OP = 'DELETE' THEN\n    organisation_id := NULL;");
    expect(sql).toContain('audit_fallback_eventcollaborator"');
    expect(sql).toContain('audit_fallback_eventcollaboratorinvite"');
  });

  it("backfills immutable feedback field semantics before allowing field removal", () => {
    const sql = readFileSync(resolve(root, "prisma/migrations/20260830020000_feedback_answer_snapshots/migration.sql"), "utf8");
    const addSnapshots = sql.indexOf('ADD COLUMN "fieldKey"');
    const backfill = sql.indexOf('UPDATE "EventFeedbackAnswer" AS answer');
    const notNull = sql.indexOf('ALTER COLUMN "fieldKey" SET NOT NULL');
    const setNull = sql.indexOf('ON DELETE SET NULL');
    expect(addSnapshots).toBeGreaterThanOrEqual(0);
    expect(backfill).toBeGreaterThan(addSnapshots);
    expect(notNull).toBeGreaterThan(backfill);
    expect(setNull).toBeGreaterThan(notNull);
  });

  it("normalizes outbox rows before enforcing the queue state machine", () => {
    const sql = readFileSync(resolve(root, "prisma/migrations/20260830030000_outbox_state_integrity/migration.sql"), "utf8");
    const removeCapabilities = sql.indexOf('DELETE FROM "OutboxMessage"');
    const redactLegacyErrors = sql.indexOf("Legacy delivery failure detail redacted");
    const clearLocks = sql.indexOf('SET "lockedAt" = NULL');
    const repairSent = sql.indexOf('SET "sentAt" = COALESCE');
    const constraint = sql.indexOf('ADD CONSTRAINT "OutboxMessage_state_shape"');
    expect(removeCapabilities).toBeGreaterThanOrEqual(0);
    expect(redactLegacyErrors).toBeGreaterThan(removeCapabilities);
    expect(clearLocks).toBeGreaterThan(redactLegacyErrors);
    expect(repairSent).toBeGreaterThan(clearLocks);
    expect(constraint).toBeGreaterThan(repairSent);
  });

  it("adds event broadcasts without touching existing tables, types, or indexes", () => {
    const sql = readFileSync(resolve(root, "prisma/migrations/20261013000000_event_broadcasts/migration.sql"), "utf8");
    expect(sql).not.toMatch(/\bDROP\b/i);
    expect(sql).not.toMatch(/ALTER TABLE "(?!EventBroadcast")/);
    expect(sql).toContain('CREATE TABLE "EventBroadcast"');
    expect(sql).toContain('"EventBroadcast_statuses_nonempty" CHECK (cardinality("statuses") > 0)');
    expect(sql).toContain('REFERENCES "Event"("id") ON DELETE CASCADE');
    expect(sql).toContain('REFERENCES "User"("id") ON DELETE SET NULL');
  });

  it("adds paid-event settings without touching existing data", () => {
    const sql = readFileSync(resolve(root, "prisma/migrations/20261022000000_payments_core/migration.sql"), "utf8");
    expect(sql).not.toMatch(/\bDROP\b|^\s*(DELETE|UPDATE)\b/im);
    expect(sql).not.toMatch(/ALTER TABLE "(?!InstanceSetting"|OrganisationPaymentSettings"|ProcessedWebhookEvent")/);
    expect(sql).toContain('ADD COLUMN "paidEventsEnabled" BOOLEAN NOT NULL DEFAULT false');
    expect(sql).toContain(`CHECK ("provider" IS NULL OR "provider" <> 'OFFLINE')`);
    expect(sql).toContain('REFERENCES "Organisation"("id") ON DELETE CASCADE');
  });

  it("adds the PENDING_PAYMENT value in its own migration, before anything uses it", () => {
    const value = readFileSync(resolve(root, "prisma/migrations/20261022000100_rsvp_pending_payment/migration.sql"), "utf8");
    expect(value.replace(/^--.*$/gm, "").trim()).toBe(`ALTER TYPE "RsvpStatus" ADD VALUE 'PENDING_PAYMENT';`);
  });

  it("adds the payment ledger without rewriting or dropping existing data", () => {
    const sql = readFileSync(resolve(root, "prisma/migrations/20261022000200_payment_ledger/migration.sql"), "utf8");
    expect(sql).not.toMatch(/\bDROP\b|^\s*DELETE\b/im);
    expect(sql).not.toMatch(/^UPDATE /m);
    expect(sql).not.toMatch(/ADD COLUMN\s+"\w+" [^,;]*NOT NULL(?! DEFAULT)/);
    for (const trigger of ["payment_ledger_guard", "payment_refund_guard", "checkout_attempt_guard"]) expect(sql).toContain(`CREATE TRIGGER "${trigger}"`);
    expect(sql).toContain('REFERENCES "TicketType"("id", "eventId") ON DELETE NO ACTION');
    expect(sql).toContain('CREATE UNIQUE INDEX "Payment_one_pending_per_order"');
  });

  it("adds the REQUESTED order status in its own migration", () => {
    const value = readFileSync(resolve(root, "prisma/migrations/20261024000000_order_requested/migration.sql"), "utf8");
    expect(value.replace(/^--.*$/gm, "").trim()).toBe(`ALTER TYPE "OrderStatus" ADD VALUE 'REQUESTED' BEFORE 'PENDING';`);
  });

  it("adds payment operations with an append-only amendment trail and immutable settled payments", () => {
    const sql = readFileSync(resolve(root, "prisma/migrations/20261024000100_payment_operations/migration.sql"), "utf8");
    expect(sql).not.toMatch(/\bDROP\b|^\s*(UPDATE|DELETE)\b/im);
    expect(sql).not.toMatch(/ADD COLUMN\s+"\w+" [^,;]*NOT NULL(?! DEFAULT)/);
    expect(sql).toContain('CREATE TRIGGER "payment_amendment_append_only"');
    expect(sql).toContain('CREATE OR REPLACE FUNCTION "payment_ledger_guard"()');
    expect(sql).toContain('NEW."offlineReference" IS DISTINCT FROM OLD."offlineReference"');
    expect(sql).toContain(`CHECK ("codeDigest" ~ '^[a-f0-9]{64}$')`);
    expect(sql).toContain('REFERENCES "TicketType"("id", "eventId") ON DELETE NO ACTION');
  });

  it("locks an event's currency once set without touching existing rows", () => {
    const sql = readFileSync(resolve(root, "prisma/migrations/20261023000000_event_currency_lock/migration.sql"), "utf8");
    expect(sql).toContain('CREATE TRIGGER "event_currency_lock"');
    expect(sql).not.toMatch(/\bDROP\b|^\s*(UPDATE|DELETE)\b/im);
  });

  it("opens tickets to series by replacing constraints only, never rows or columns", () => {
    const sql = readFileSync(resolve(root, "prisma/migrations/20261026000000_paid_series/migration.sql"), "utf8");
    // The only drops are constraints and one index, each replaced in the same migration.
    const drops = sql.match(/^.*\bDROP\b.*$/gim) ?? [];
    expect(drops.every((line) => /DROP CONSTRAINT|DROP INDEX|DROP NOT NULL/.test(line))).toBe(true);
    expect(sql).not.toMatch(/DROP (TABLE|COLUMN|TYPE)|^\s*(UPDATE|DELETE)\b/im);
    for (const trigger of ["ticket_type_target_fixed", "rsvp_ticket_type_target", "promo_code_ticket_type_target", "series_currency_lock"]) {
      expect(sql).toContain(`CREATE TRIGGER "${trigger}"`);
    }
  });

  it("adds ticketing extras with columns that default to today's behaviour and no rewrites", () => {
    const sql = readFileSync(resolve(root, "prisma/migrations/20261027000000_ticketing_extras/migration.sql"), "utf8");
    expect(sql).not.toMatch(/\bDROP\b|^\s*(UPDATE|DELETE)\b/im);
    expect(sql).toContain(`"visibility" "TicketVisibility" NOT NULL DEFAULT 'PUBLIC'`);
    expect(sql).toContain('"seatsPerTicket" INTEGER NOT NULL DEFAULT 1');
  });

  it("adds disputes, reminders, transfers and pay-at-the-desk with safe defaults and no rewrites", () => {
    const sql = readFileSync(resolve(root, "prisma/migrations/20261028000000_after_purchase/migration.sql"), "utf8");
    expect(sql).not.toMatch(/\bDROP\b|^\s*(UPDATE|DELETE)\b/im);
    expect(sql).toContain('"allowTransfers" BOOLEAN NOT NULL DEFAULT false');
    expect(sql).toContain('"payAtDesk" BOOLEAN NOT NULL DEFAULT false');
  });

  it("adds organisation email settings as a new table with standard ports only", () => {
    const sql = readFileSync(resolve(root, "prisma/migrations/20261030000000_organisation_email/migration.sql"), "utf8");
    expect(sql).not.toMatch(/\bDROP\b|^\s*(UPDATE|DELETE)\b/im);
    expect(sql).toContain('"smtpPort" IN (25, 465, 587, 2525)');
    expect(sql).toContain('ON DELETE CASCADE');
  });

  it("adds the event reminder marker as a nullable column with no rewrites", () => {
    const sql = readFileSync(resolve(root, "prisma/migrations/20261029000000_event_reminders/migration.sql"), "utf8");
    expect(sql).not.toMatch(/\bDROP\b|^\s*(UPDATE|DELETE)\b/im);
    expect(sql).toContain('ADD COLUMN     "reminderSentAt" TIMESTAMP(3);');
  });

  it("adds known devices as a new table, removed with their account", () => {
    const sql = readFileSync(resolve(root, "prisma/migrations/20261031000000_user_devices/migration.sql"), "utf8");
    expect(sql).not.toMatch(/\bDROP\b|^\s*(UPDATE|DELETE)\b/im);
    expect(sql).toContain('ON DELETE CASCADE');
    expect(sql).toContain('"deviceHash" ~ \'^[a-f0-9]{64}$\'');
  });

  it("adds chat channels as a new table with known notification types only", () => {
    const sql = readFileSync(resolve(root, "prisma/migrations/20261101000000_chat_channels/migration.sql"), "utf8");
    expect(sql).not.toMatch(/\bDROP\b|^\s*(UPDATE|DELETE)\b/im);
    expect(sql).toContain('ON DELETE CASCADE');
    expect(sql).toContain('"events" <@ ARRAY[');
  });

  it("adds broadcast drafts as a new table that cascades with its event and author", () => {
    const sql = readFileSync(resolve(root, "prisma/migrations/20261102000000_event_broadcast_drafts/migration.sql"), "utf8");
    expect(sql).not.toMatch(/\bDROP\b/i);
    expect(sql).not.toMatch(/ALTER TABLE "(?!EventBroadcastDraft")/);
    expect(sql).not.toMatch(/^\s*(UPDATE|DELETE FROM|INSERT INTO)\b/m);
    expect(sql).toContain('CREATE TABLE "EventBroadcastDraft"');
    expect(sql).toContain('CREATE UNIQUE INDEX "EventBroadcastDraft_eventId_userId_key" ON "EventBroadcastDraft"("eventId", "userId")');
    expect(sql).toContain('CHECK (char_length("subject") <= 150)');
    expect(sql).toContain('FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE');
    expect(sql).toContain('FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE');
  });

  it("adds check-in lists as new tables without touching entry check-in", () => {
    const sql = readFileSync(resolve(root, "prisma/migrations/20261103000000_check_in_lists/migration.sql"), "utf8");
    expect(sql).not.toMatch(/\bDROP\b/i);
    expect(sql).not.toMatch(/ALTER TABLE "(?!CheckInList(Record|Event)?")/);
    expect(sql).not.toMatch(/^\s*(UPDATE|DELETE FROM|INSERT INTO)\b/m);
    expect(sql).toContain('CREATE UNIQUE INDEX "CheckInList_eventId_active_name_key" ON "CheckInList"("eventId", lower("name")) WHERE NOT "archived"');
    expect(sql).toContain('CREATE UNIQUE INDEX "CheckInListRecord_listId_rsvpId_key" ON "CheckInListRecord"("listId", "rsvpId")');
    expect(sql).toContain('FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE');
    expect(sql).toContain('"CheckInListRecord_rsvpId_fkey" FOREIGN KEY ("rsvpId") REFERENCES "RSVP"("id") ON DELETE CASCADE');
    expect(sql).toContain('"CheckInListRecord_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE SET NULL');
    expect(sql).toContain('"CheckInListEvent_rsvpId_fkey" FOREIGN KEY ("rsvpId") REFERENCES "RSVP"("id") ON DELETE SET NULL');
    expect(sql).toContain(`CHECK ("source" IN ('online', 'mobile-scan', 'mobile-manual'))`);
  });
});
