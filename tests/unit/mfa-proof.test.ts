import { beforeEach, describe, expect, it } from "vitest";
import { createMfaProof, hasValidMfaProof, MFA_PROOF_MAX_AGE_SECONDS } from "@/lib/mfaProof";

describe("MFA step-up proof", () => {
  beforeEach(() => {
    process.env.AUTH_SECRET = "unit-test-auth-secret-with-at-least-32-characters";
  });

  it("accepts a proof only for the verified user, session version and sign-in", () => {
    const now = 1_000_000;
    const proof = createMfaProof("user_1", 3, "sid-a", now);
    expect(hasValidMfaProof(proof, "user_1", 3, "sid-a", now + 1)).toBe(true);
    expect(hasValidMfaProof(proof, "user_2", 3, "sid-a", now + 1)).toBe(false);
    expect(hasValidMfaProof(proof, "user_1", 4, "sid-a", now + 1)).toBe(false);
  });

  it("is void for another sign-in, or a session without a sign-in id", () => {
    const now = 1_000_000;
    const proof = createMfaProof("user_1", 3, "sid-a", now);
    expect(hasValidMfaProof(proof, "user_1", 3, "sid-b", now + 1)).toBe(false);
    expect(hasValidMfaProof(proof, "user_1", 3, null, now + 1)).toBe(false);
    expect(hasValidMfaProof(proof, "user_1", 3, "", now + 1)).toBe(false);
  });

  it("rejects tampered and expired proofs", () => {
    const now = 1_000_000;
    const proof = createMfaProof("user_1", 3, "sid-a", now);
    expect(hasValidMfaProof(`${proof}x`, "user_1", 3, "sid-a", now + 1)).toBe(false);
    expect(hasValidMfaProof(proof, "user_1", 3, "sid-a", now + MFA_PROOF_MAX_AGE_SECONDS * 1000)).toBe(false);
  });
});
