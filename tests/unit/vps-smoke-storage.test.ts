import * as sdk from "@aws-sdk/client-s3";
import { describe, expect, it, vi } from "vitest";
import { deleteSmokeObject } from "@/docker/vps/smoke-storage.mjs";
import { fakeVersionedS3 } from "@/tests/helpers/fakeVersionedS3";

describe("VPS smoke object cleanup", () => {
  it("deletes every version and marker across pages, leaving longer keys alone", async () => {
    const s3 = fakeVersionedS3(sdk);
    s3.bucket.pageSize = 2;
    const key = "deployment-smoke/own-key";
    s3.put(key);
    s3.put(key);
    s3.deleteKey(key);
    s3.put(`${key}-other`);
    await deleteSmokeObject(s3, "smoke-bucket", key);
    expect(s3.keys()).toEqual([`${key}-other`]);
    expect(s3.bucket.entries).toHaveLength(1);
  });

  it("falls back to a plain delete only when versions are unsupported", async () => {
    const s3 = fakeVersionedS3(sdk);
    s3.bucket.versioning = "unsupported";
    s3.put("deployment-smoke/own-key");
    await deleteSmokeObject(s3, "smoke-bucket", "deployment-smoke/own-key");
    expect(s3.bucket.entries).toEqual([]);
  });

  it("propagates permission and version deletion failures so the smoke run fails", async () => {
    const s3 = fakeVersionedS3(sdk);
    const denied = Object.assign(new Error("denied"), { name: "AccessDenied" });
    s3.put("deployment-smoke/own-key");
    s3.bucket.failListWith = denied;
    await expect(deleteSmokeObject(s3, "smoke-bucket", "deployment-smoke/own-key")).rejects.toBe(denied);
    expect(s3.bucket.entries).toHaveLength(1);
    s3.bucket.failListWith = null;
    const send = vi.fn(async (command: unknown) => {
      if (command instanceof sdk.DeleteObjectCommand) throw denied;
      return s3.send(command);
    });
    await expect(deleteSmokeObject({ send }, "smoke-bucket", "deployment-smoke/own-key")).rejects.toBe(denied);
    expect(s3.bucket.entries).toHaveLength(1);
  });
});
