import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ prisma: {} }));
vi.mock("@/lib/outbox", () => ({ enqueueOperatorNotice: vi.fn(), enqueueSignInCode: vi.fn() }));
vi.mock("@/lib/rateLimit", () => ({ checkRateLimitById: vi.fn(), failureCount: vi.fn(), isOverLimit: vi.fn(), recordFailure: vi.fn() }));
import { newSignInAdvice } from "@/lib/loginSecurity";

afterEach(() => vi.unstubAllEnvs());

describe("new sign-in alert advice", () => {
  it("tells a person to reset their password from the sign-in page", () => {
    vi.stubEnv("SUPER_ADMIN_EMAIL", "root@example.test");
    expect(newSignInAdvice("person@example.test")).toContain("reset your password from the sign-in page");
  });

  it("sends the super admin to the server tools, since the app refuses their password reset", () => {
    vi.stubEnv("SUPER_ADMIN_EMAIL", "Root@Example.test");
    const advice = newSignInAdvice("root@example.test");
    expect(advice).toContain("scripts/vps-recover.sh");
    expect(advice).not.toContain("sign-in page");
  });
});
