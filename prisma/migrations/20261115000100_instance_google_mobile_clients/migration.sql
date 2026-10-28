-- The Google OAuth client ids of the Space Works Android and iOS apps. Saved
-- values override GOOGLE_MOBILE_CLIENT_IDS. Client ids are public, not secrets.
ALTER TABLE "InstanceSetting" ADD COLUMN "googleMobileClientIds" TEXT;
