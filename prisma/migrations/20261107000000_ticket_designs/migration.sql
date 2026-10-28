-- Ticket designer (docs/TICKET_DESIGNER.md): ticket designs in each
-- organisation's library or owned by an event, and which design an event, a
-- ticket type and the organisation default use. A new table and nullable
-- columns only; no existing row is rewritten.
-- AlterTable
ALTER TABLE "Organisation" ADD COLUMN     "defaultTicketDesignId" TEXT;

-- AlterTable
ALTER TABLE "Event" ADD COLUMN     "ticketDesignId" TEXT;

-- AlterTable
ALTER TABLE "TicketType" ADD COLUMN     "ticketDesignId" TEXT;

-- CreateTable
CREATE TABLE "TicketDesign" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "eventId" TEXT,
    "name" TEXT NOT NULL,
    "document" JSONB NOT NULL,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TicketDesign_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TicketDesign_organisationId_eventId_updatedAt_idx" ON "TicketDesign"("organisationId", "eventId", "updatedAt");

-- CreateIndex
CREATE INDEX "TicketDesign_eventId_idx" ON "TicketDesign"("eventId");

-- CreateIndex
CREATE UNIQUE INDEX "Organisation_defaultTicketDesignId_key" ON "Organisation"("defaultTicketDesignId");

-- CreateIndex
CREATE UNIQUE INDEX "Event_ticketDesignId_key" ON "Event"("ticketDesignId");

-- AddForeignKey
ALTER TABLE "Organisation" ADD CONSTRAINT "Organisation_defaultTicketDesignId_fkey" FOREIGN KEY ("defaultTicketDesignId") REFERENCES "TicketDesign"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Event" ADD CONSTRAINT "Event_ticketDesignId_fkey" FOREIGN KEY ("ticketDesignId") REFERENCES "TicketDesign"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TicketType" ADD CONSTRAINT "TicketType_ticketDesignId_fkey" FOREIGN KEY ("ticketDesignId") REFERENCES "TicketDesign"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TicketDesign" ADD CONSTRAINT "TicketDesign_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TicketDesign" ADD CONSTRAINT "TicketDesign_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TicketDesign" ADD CONSTRAINT "TicketDesign_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;


ALTER TABLE "TicketDesign" ADD CONSTRAINT "TicketDesign_shape" CHECK (
  char_length("name") BETWEEN 1 AND 80
  AND jsonb_typeof("document") = 'object'
  AND octet_length("document"::text) <= 262144
);

-- A design is used only where it belongs: an event's or a ticket type's
-- design is one of that event's own; an organisation's default is one of its
-- library templates.
CREATE OR REPLACE FUNCTION "event_ticket_design_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."ticketDesignId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "TicketDesign" WHERE "id" = NEW."ticketDesignId" AND "eventId" = NEW."id"
  ) THEN
    RAISE EXCEPTION 'An event''s ticket design must be one of its own' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "event_ticket_design_owner"
  BEFORE INSERT OR UPDATE OF "ticketDesignId" ON "Event"
  FOR EACH ROW EXECUTE FUNCTION "event_ticket_design_guard"();

CREATE OR REPLACE FUNCTION "ticket_type_design_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."ticketDesignId" IS NOT NULL AND (NEW."eventId" IS NULL OR NOT EXISTS (
    SELECT 1 FROM "TicketDesign" WHERE "id" = NEW."ticketDesignId" AND "eventId" = NEW."eventId"
  )) THEN
    RAISE EXCEPTION 'A ticket type''s design must be one of its event''s own' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "ticket_type_design_owner"
  BEFORE INSERT OR UPDATE OF "ticketDesignId" ON "TicketType"
  FOR EACH ROW EXECUTE FUNCTION "ticket_type_design_guard"();

CREATE OR REPLACE FUNCTION "organisation_ticket_design_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."defaultTicketDesignId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "TicketDesign" WHERE "id" = NEW."defaultTicketDesignId" AND "organisationId" = NEW."id" AND "eventId" IS NULL
  ) THEN
    RAISE EXCEPTION 'The default ticket design must be one of the organisation''s templates' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "organisation_ticket_design_owner"
  BEFORE INSERT OR UPDATE OF "defaultTicketDesignId" ON "Organisation"
  FOR EACH ROW EXECUTE FUNCTION "organisation_ticket_design_guard"();
