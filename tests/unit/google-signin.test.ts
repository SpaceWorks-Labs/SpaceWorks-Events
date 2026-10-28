import { beforeAll, describe, expect, it, vi } from "vitest";
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, type JWTVerifyGetKey } from "jose";

vi.mock("@/lib/db", () => ({ prisma: {} }));
vi.mock("@/lib/instanceSettings", () => ({ getGoogleSsoSettings: vi.fn(), getMobileGoogleClientIds: vi.fn(), isNewUserRegistrationEnabled: vi.fn() }));

import { verifyGoogleIdToken } from "@/lib/googleSignIn";

const AUDIENCE = "web-client.apps.googleusercontent.com";
const ANDROID = "android-client.apps.googleusercontent.com";
const webOnly = { webClientId: AUDIENCE, mobileClientIds: [] };
const withMobile = { webClientId: AUDIENCE, mobileClientIds: [ANDROID] };
let keySet: JWTVerifyGetKey;
let privateKey: CryptoKey;
let otherPrivateKey: CryptoKey;

async function token(claims: Record<string, unknown>, options: { key?: CryptoKey; issuer?: string; audience?: string; expiresIn?: string | number; alg?: string } = {}) {
  const jwt = new SignJWT({ email: "ada@example.test", email_verified: true, name: "Ada", ...claims })
    .setProtectedHeader({ alg: options.alg ?? "RS256", kid: "test-key" })
    .setIssuer(options.issuer ?? "https://accounts.google.com")
    .setAudience(options.audience ?? AUDIENCE)
    .setSubject("google-sub-1")
    .setIssuedAt()
    .setExpirationTime(options.expiresIn ?? "5m");
  return jwt.sign(options.key ?? privateKey);
}

beforeAll(async () => {
  const pair = await generateKeyPair("RS256");
  privateKey = pair.privateKey;
  otherPrivateKey = (await generateKeyPair("RS256")).privateKey;
  const jwk = { ...(await exportJWK(pair.publicKey)), kid: "test-key", alg: "RS256", use: "sig" };
  keySet = createLocalJWKSet({ keys: [jwk] });
});

describe("Google ID-token verification", () => {
  it("accepts a valid token for a configured audience", async () => {
    await expect(verifyGoogleIdToken(await token({ azp: ANDROID }), withMobile, keySet)).resolves.toEqual({ sub: "google-sub-1", email: "ada@example.test", name: "Ada", picture: null });
    await expect(verifyGoogleIdToken(await token({ azp: ANDROID }, { issuer: "accounts.google.com" }), withMobile, keySet)).resolves.not.toBeNull();
  });

  it("rejects a bad signature, issuer, audience, expiry or unverified email", async () => {
    await expect(verifyGoogleIdToken(await token({}, { key: otherPrivateKey }), withMobile, keySet)).resolves.toBeNull();
    await expect(verifyGoogleIdToken(await token({}, { issuer: "https://evil.example" }), withMobile, keySet)).resolves.toBeNull();
    await expect(verifyGoogleIdToken(await token({}, { audience: "someone-else" }), withMobile, keySet)).resolves.toBeNull();
    await expect(verifyGoogleIdToken(await token({}, { expiresIn: Math.floor(Date.now() / 1000) - 3600 }), withMobile, keySet)).resolves.toBeNull();
    await expect(verifyGoogleIdToken(await token({ email_verified: false }), withMobile, keySet)).resolves.toBeNull();
    await expect(verifyGoogleIdToken(await token({ email_verified: "true" }), withMobile, keySet)).resolves.toBeNull();
    await expect(verifyGoogleIdToken(await token({ email: undefined }), withMobile, keySet)).resolves.toBeNull();
    await expect(verifyGoogleIdToken("not.a.jwt", withMobile, keySet)).resolves.toBeNull();
    await expect(verifyGoogleIdToken(await token({}), { webClientId: "", mobileClientIds: [] }, keySet)).resolves.toBeNull();
  });

  it("requires a configured mobile azp when the token was issued for the web client id", async () => {
    await expect(verifyGoogleIdToken(await token({ azp: ANDROID }), withMobile, keySet)).resolves.not.toBeNull();
    await expect(verifyGoogleIdToken(await token({ azp: "someone-else.apps.googleusercontent.com" }), withMobile, keySet)).resolves.toBeNull();
    await expect(verifyGoogleIdToken(await token({}), withMobile, keySet)).resolves.toBeNull();
    // A token minted directly for a mobile client id is accepted on its own audience.
    await expect(verifyGoogleIdToken(await token({}, { audience: ANDROID }), withMobile, keySet)).resolves.not.toBeNull();
    // With no app client ids configured, nothing is accepted (Space Works: mobile Google sign-in stays off).
    await expect(verifyGoogleIdToken(await token({ azp: "anything" }), webOnly, keySet)).resolves.toBeNull();
    await expect(verifyGoogleIdToken(await token({}, { audience: ANDROID }), webOnly, keySet)).resolves.toBeNull();
  });
});
