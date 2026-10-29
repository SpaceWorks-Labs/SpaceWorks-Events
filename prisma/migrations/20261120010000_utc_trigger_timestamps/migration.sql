-- Trigger timestamps in UTC whatever the session time zone.
-- CURRENT_TIMESTAMP is a timestamptz; assigning it to a timestamp(3) column
-- converts it to the session's TimeZone, so a database (or connection) whose
-- TimeZone is not UTC stored local wall-clock time. Each function below is the
-- latest definition with only CURRENT_TIMESTAMP replaced by an explicit UTC
-- conversion; the rest of its logic is unchanged.

CREATE OR REPLACE FUNCTION rsvp_waitlist_dates() RETURNS trigger AS $$
BEGIN
  IF NEW."status"::text = 'WAITLISTED' AND NEW."waitlistedAt" IS NULL THEN
    NEW."waitlistedAt" := (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::timestamp(3);
  END IF;
  -- Leaving the waitlist for anything but a rejection is a promotion (a
  -- confirmed place, or a place held for payment).
  IF TG_OP = 'UPDATE' AND OLD."status"::text = 'WAITLISTED' AND NEW."status"::text NOT IN ('WAITLISTED', 'REJECTED')
     AND NEW."promotedAt" IS NULL THEN
    NEW."promotedAt" := (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::timestamp(3);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION "write_security_audit_fallback"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  row_data jsonb;
  organisation_id text;
  target_id text;
BEGIN
  row_data := CASE WHEN TG_OP = 'DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
  target_id := row_data ->> 'id';
  IF TG_OP = 'DELETE' THEN
    organisation_id := NULL;
  ELSE
    organisation_id := CASE TG_TABLE_NAME
      WHEN 'Organisation' THEN target_id
      WHEN 'Membership' THEN row_data ->> 'organisationId'
      WHEN 'Event' THEN row_data ->> 'organisationId'
      WHEN 'EventSeries' THEN row_data ->> 'organisationId'
      WHEN 'OrganisationInvite' THEN row_data ->> 'organisationId'
      ELSE NULL
    END;
    IF TG_TABLE_NAME IN ('EventInvite', 'EventCollaborator', 'EventCollaboratorInvite')
       AND row_data ->> 'eventId' IS NOT NULL THEN
      SELECT "organisationId" INTO organisation_id FROM "Event" WHERE "id" = row_data ->> 'eventId';
    ELSIF TG_TABLE_NAME IN ('SeriesInvite', 'EventCollaborator', 'EventCollaboratorInvite')
       AND row_data ->> 'eventSeriesId' IS NOT NULL THEN
      SELECT "organisationId" INTO organisation_id FROM "EventSeries" WHERE "id" = row_data ->> 'eventSeriesId';
    ELSIF TG_TABLE_NAME = 'RSVP' THEN
      IF row_data ->> 'eventId' IS NOT NULL THEN
        SELECT "organisationId" INTO organisation_id FROM "Event" WHERE "id" = row_data ->> 'eventId';
      ELSE
        SELECT s."organisationId" INTO organisation_id
        FROM "EventInstance" i INNER JOIN "EventSeries" s ON s."id" = i."eventSeriesId"
        WHERE i."id" = row_data ->> 'eventInstanceId';
      END IF;
    END IF;
  END IF;
  INSERT INTO "AuditEvent" ("id", "action", "organisationId", "targetType", "targetId", "metadata", "createdAt")
  VALUES (gen_random_uuid()::text, 'DB_' || upper(TG_TABLE_NAME) || '_' || TG_OP,
          organisation_id, TG_TABLE_NAME, target_id,
          jsonb_build_object('source', 'database-trigger'), (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::timestamp(3));
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE OR REPLACE FUNCTION "write_api_security_audit_fallback"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  row_data jsonb;
  organisation_id text;
  target_id text;
BEGIN
  row_data := CASE WHEN TG_OP = 'DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;

  IF TG_TABLE_NAME = 'ApiCredential' AND TG_OP = 'UPDATE' THEN
    IF NEW."apiClientId" = OLD."apiClientId"
       AND NEW."name" = OLD."name"
       AND NEW."secretHash" = OLD."secretHash"
       AND NEW."expiresAt" IS NOT DISTINCT FROM OLD."expiresAt"
       AND NEW."revokedAt" IS NOT DISTINCT FROM OLD."revokedAt" THEN
      RETURN NEW;
    END IF;
  END IF;

  IF TG_TABLE_NAME = 'ApiClient' THEN
    target_id := row_data ->> 'id';
    organisation_id := CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE row_data ->> 'organisationId' END;
  ELSE
    target_id := row_data ->> 'apiClientId';
    IF TG_OP = 'DELETE' THEN
      organisation_id := NULL;
    ELSE
      SELECT "organisationId" INTO organisation_id
        FROM "ApiClient" WHERE "id" = target_id;
    END IF;
  END IF;

  INSERT INTO "AuditEvent" (
    "id", "action", "organisationId", "targetType", "targetId", "metadata", "createdAt"
  ) VALUES (
    gen_random_uuid()::text,
    'DB_' || upper(TG_TABLE_NAME) || '_' || TG_OP,
    organisation_id,
    TG_TABLE_NAME,
    target_id,
    jsonb_build_object('source', 'database-trigger'),
    (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::timestamp(3)
  );

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;
