import { afterEach, describe, expect, it, vi } from "vitest";
import { currentStorageLocation } from "@/lib/storage/objects";

function configure(values: Record<string, string>) {
  for (const [name, value] of Object.entries(values)) vi.stubEnv(name, value);
}

describe("storage location", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("is null without object storage", () => {
    configure({ S3_BUCKET: "", S3_REGION: "" });
    expect(currentStorageLocation()).toBeNull();
  });

  it("names the provider, endpoint and bucket without revealing them", () => {
    configure({ S3_BUCKET: "events", S3_REGION: "auto", S3_ENDPOINT: "https://acct.r2.cloudflarestorage.com", S3_ACCESS_KEY_ID: "id-1", S3_SECRET_ACCESS_KEY: "secret-1" });
    const location = currentStorageLocation()!;
    expect(location).toMatch(/^s3:[0-9a-f]{32}$/);
    expect(location).not.toContain("events");
    // Credentials and cosmetic differences in the endpoint do not move it.
    configure({ S3_ACCESS_KEY_ID: "id-2", S3_SECRET_ACCESS_KEY: "secret-2", S3_ENDPOINT: "https://ACCT.r2.cloudflarestorage.com/" });
    expect(currentStorageLocation()).toBe(location);
    // Another bucket or endpoint is another location.
    configure({ S3_BUCKET: "events-2" });
    expect(currentStorageLocation()).not.toBe(location);
    configure({ S3_BUCKET: "events", S3_ENDPOINT: "https://other.example.test" });
    expect(currentStorageLocation()).not.toBe(location);
  });

  it("tells AWS regions apart when no endpoint is set", () => {
    configure({ S3_BUCKET: "events", S3_REGION: "eu-west-1", S3_ENDPOINT: "" });
    const ireland = currentStorageLocation();
    configure({ S3_REGION: "us-east-1" });
    expect(currentStorageLocation()).not.toBe(ireland);
  });
});
