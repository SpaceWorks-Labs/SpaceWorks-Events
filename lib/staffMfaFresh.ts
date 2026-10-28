import { MFA_PROOF_MAX_AGE_SECONDS } from "@/lib/mfaProof";

/** Whether an app session's authenticator check is recent enough to count (12 hours, like the web proof). */
export function mobileMfaFresh(mfaVerifiedAt: Date | null, now = Date.now()) {
  if (!mfaVerifiedAt) return false;
  const at = mfaVerifiedAt.getTime();
  return now - at < MFA_PROOF_MAX_AGE_SECONDS * 1000 && at <= now + 60_000;
}
