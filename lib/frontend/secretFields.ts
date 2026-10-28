/**
 * Fields that never cross a host boundary: view readers (lib/frontend/handler.ts)
 * and mobile DTOs are both checked against it. Every schema field whose name
 * holds "Hash", "Encrypted" or "Secret" must be listed
 * (tests/unit/secret-fields.test.ts reads prisma/schema.prisma).
 */
export const secretFields = new Set([
  "passwordHash", "mfaSecretEncrypted", "recoveryCodeHashes", "checkInStationPinHash",
  "checkInStationPinEncrypted", "checkInStationSecretVersion", "secretHash", "tokenHash",
  "smtpPasswordEncrypted", "googleClientSecretEncrypted", "opsWebhookUrlEncrypted", "access_token", "refresh_token", "id_token", "sessionToken",
  "razorpayKeySecretEncrypted", "razorpayWebhookSecretEncrypted", "stripeSecretKeyEncrypted", "stripeWebhookSecretEncrypted",
  // Mobile app sessions (lib/mobileAuth.ts) and sign-in devices.
  "accessTokenHash", "refreshTokenHash", "previousRefreshTokenHashes", "deviceHash",
  // Chat secrets, team management links, mobile idempotency keys and finalist notice emails.
  "secretEncrypted", "manageTokenHash", "keyHash", "requestHash", "emailHash",
]);
