import { beforeEach, describe, expect, it, vi } from "vitest";
import { AccessDenied, CallbackRouteError, CredentialsSignin, MissingCSRF, OAuthCallbackError } from "@auth/core/errors";

const mocks = vi.hoisted(() => ({ logOpsError: vi.fn() }));
vi.mock("@/lib/opsAlerts", () => ({ logOpsError: mocks.logOpsError }));

import { logAuthError } from "@/lib/authLogger";

/** lib/auth.ts throws these for expected sign-in outcomes. */
class MfaRequiredError extends CredentialsSignin {
  code = "mfa_required";
}
class EmailVerificationRequiredError extends CredentialsSignin {
  code = "email_verification_required";
}
class EmailCodeRequiredError extends CredentialsSignin {
  code = "email_code_required";
}
class TooManyAttemptsError extends CredentialsSignin {
  code = "too_many_attempts";
}

describe("Auth.js error logging", () => {
  beforeEach(() => mocks.logOpsError.mockReset());

  it("does not alert on expected sign-in outcomes, a missing CSRF token, or a declined sign-in", () => {
    for (const error of [new MfaRequiredError(), new EmailVerificationRequiredError(), new EmailCodeRequiredError(), new TooManyAttemptsError(), new CredentialsSignin(), new MissingCSRF("no token"), new AccessDenied("declined")]) {
      logAuthError(error);
    }
    expect(mocks.logOpsError).not.toHaveBeenCalled();
  });

  it("still alerts on provider and configuration failures, with the error type in the title", () => {
    logAuthError(new OAuthCallbackError("bad state"));
    logAuthError(new CallbackRouteError("adapter down"));
    logAuthError(new Error("unexpected"));
    expect(mocks.logOpsError.mock.calls.map(([, details]) => details.title)).toEqual([
      "Sign-in failed (OAuthCallbackError)",
      "Sign-in failed (CallbackRouteError)",
      "Sign-in failed (Error)",
    ]);
    expect(mocks.logOpsError.mock.calls.every(([message, details]) => message === "[auth] Authentication failed" && details.level === "error" && details.source === "auth")).toBe(true);
  });
});
