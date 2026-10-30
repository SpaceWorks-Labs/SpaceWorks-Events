import { beforeEach, describe, expect, it, vi } from "vitest";
import { newPasswordSchema } from "@/lib/passwordPolicy";
import { safeAuthRedirect } from "@/lib/authRedirect";
const mocks = vi.hoisted(() => ({ auth: vi.fn() }));
vi.mock("@/lib/auth", () => ({ auth: mocks.auth }));
import { hasRecentAuthentication } from "@/lib/reauth";
beforeEach(() => vi.clearAllMocks());
describe("auth inputs", () => {
  it("requires stronger new passwords without restricting legacy sign-in", () => {
    expect(newPasswordSchema.safeParse("short-pass").success).toBe(false);
    expect(newPasswordSchema.safeParse("longer-passphrase").success).toBe(true);
  });
  it("enforces bcrypt's byte limit for ASCII and Unicode", () => {
    expect(newPasswordSchema.safeParse("a".repeat(72)).success).toBe(true);
    expect(newPasswordSchema.safeParse("a".repeat(73)).success).toBe(false);
    expect(newPasswordSchema.safeParse("😀".repeat(18)).success).toBe(true);
    expect(newPasswordSchema.safeParse("😀".repeat(19)).success).toBe(false);
  });
  it.each(["//evil.test", "/\\evil.test", "/\n/evil.test", "https://evil.test", "javascript:alert(1)"])("rejects redirect %j", (path) => {
    expect(safeAuthRedirect(path)).toBe("/dashboard");
  });
  it.each([
    "/x/..//attacker.example",
    "/x/../..//attacker.example/path?q=1",
    "/x/%2e%2e//attacker.example",
    "/x/%2E%2E//attacker.example",
    "/x/.%2e//attacker.example",
    "/./..//attacker.example",
    "/x/..%2F/attacker.example",
    "/x/..\\/attacker.example",
    "/x/..\\\\attacker.example",
    "/%5C%5Cattacker.example",
  ])("never normalises %j to another origin", (path) => {
    const result = safeAuthRedirect(path);
    expect(result).toMatch(/^\/(?![/\\])/);
    expect(new URL(result, "https://app.example").origin).toBe("https://app.example");
  });
  it("rejects the dot-segment bypass outright", () => {
    expect(safeAuthRedirect("/x/..//attacker.example")).toBe("/dashboard");
    expect(safeAuthRedirect("/x/%2e%2e//attacker.example")).toBe("/dashboard");
    expect(safeAuthRedirect("/x/..\\/attacker.example")).toBe("/dashboard");
  });
  it("keeps normalised local destinations", () => {
    expect(safeAuthRedirect("/a/b/../c?x=1#h")).toBe("/a/c?x=1#h");
    expect(safeAuthRedirect("/%2F%2Fattacker.example")).toBe("/%2F%2Fattacker.example");
  });
  it("preserves local invitation destinations", () => {
    expect(safeAuthRedirect("/join/org/example?from=login")).toBe("/join/org/example?from=login");
  });
  it.each([NaN, Infinity, Date.now() + 60_000, Date.now() - 601_000])("rejects invalid freshness %s", async (authenticatedAt) => {
    mocks.auth.mockResolvedValue({ user: { id: "u" }, authenticatedAt });
    expect(await hasRecentAuthentication()).toBe(false);
  });
  it("rejects anonymous sessions even with fresh timestamps", async () => {
    mocks.auth.mockResolvedValue({ user: { id: "" }, authenticatedAt: Date.now() });
    expect(await hasRecentAuthentication()).toBe(false);
  });
});
