import { describe, expect, it } from "vitest";
import nextConfig from "@/next.config";

describe("capability link referrer policy", () => {
  it("sends no-referrer on every page whose URL carries a token", async () => {
    const rules = await nextConfig.headers!();
    const noReferrer = (source: string) =>
      rules.some((rule) => rule.source === source && rule.headers.some((h) => h.key === "Referrer-Policy" && h.value === "no-referrer"));
    for (const source of ["/join/:kind/:token", "/reset-password", "/verify-email", "/order/:token", "/verify/:token", "/ticket/:token", "/team/:token", "/submit/:token", "/attend/:token"]) {
      expect(noReferrer(source), source).toBe(true);
    }
  });
});
