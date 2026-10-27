import { afterEach, describe, expect, it, vi } from "vitest";

// Event page images have their own hourly budget, so building a page with
// dozens of speaker photos never uses up the shared upload budget that
// certificates, member IDs and ticket designs draw on (and the reverse).

afterEach(() => vi.unstubAllEnvs());

async function limiter() {
  vi.resetModules();
  vi.stubEnv("REDIS_URL", "");
  return import("@/lib/rateLimit");
}

async function allowed(check: (bucket: "upload" | "eventPageUpload" | "crewPhotoUpload", id: string) => Promise<boolean>, bucket: "upload" | "eventPageUpload" | "crewPhotoUpload", id: string, times: number) {
  let count = 0;
  for (let index = 0; index < times; index += 1) if (await check(bucket, id)) count += 1;
  return count;
}

describe("upload rate-limit buckets", () => {
  it("allows 60 event page images an hour, separately from 12 other uploads", async () => {
    const { checkRateLimitById } = await limiter();
    expect(await allowed(checkRateLimitById, "eventPageUpload", "user_1", 70)).toBe(60);
    expect(await allowed(checkRateLimitById, "upload", "user_1", 20)).toBe(12);
  });

  it("gives crew-link photos their own budget, so they never use the shared upload budget", async () => {
    const { checkRateLimitById } = await limiter();
    expect(await allowed(checkRateLimitById, "crewPhotoUpload", "subject:link", 70)).toBe(60);
    expect(await allowed(checkRateLimitById, "upload", "subject:link", 20)).toBe(12);
  });
});
