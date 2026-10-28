import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/*
 * Idempotency-Key handling for mobile writes (lib/mobile/idempotency.ts): a
 * key replays only for the same path and body, transient and sign-in
 * refusals are never kept, an unfinished first request turns stale rather
 * than running twice, and only HMACs are stored.
 */

process.env.MFA_ENCRYPTION_KEY ||= Buffer.alloc(32, 7).toString("base64");

import { prisma } from "@/lib/db";
import { idempotentRequest, idempotentWrite, STALE_AFTER_MS } from "@/lib/mobile/idempotency";
import { mobileError, mobileOk } from "@/lib/mobile/http";

const ROUTE = "POST /api/mobile/v1/test/:thingId/act";
let userId = "";

beforeAll(async () => {
  const user = await prisma.user.create({ data: { email: `idem-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`, name: "Idem" } });
  userId = user.id;
});

afterAll(async () => {
  await prisma.user.delete({ where: { id: userId } });
});

const request = (path: string, key: string, body: unknown = { n: 1 }) => new Request(`https://events.example.test${path}`, {
  method: "POST",
  headers: { "content-type": "application/json", "idempotency-key": key },
  body: JSON.stringify(body),
});

/** A write that counts its runs and answers with `answer`. */
function counter(answer: () => Response) {
  const write = vi.fn(async () => answer());
  return write;
}

describe.sequential("mobile idempotent writes", () => {
  it("replays a key only on the same path and body", async () => {
    const write = counter(() => mobileOk({ id: "first" }, 201));
    expect((await idempotentWrite(request("/api/mobile/v1/test/a/act", "same-key-0001"), userId, ROUTE, write)).status).toBe(201);
    const replayed = await idempotentWrite(request("/api/mobile/v1/test/a/act", "same-key-0001"), userId, ROUTE, write);
    expect(replayed.headers.get("idempotent-replayed")).toBe("true");
    await expect(replayed.json()).resolves.toEqual({ ok: true, data: { id: "first" } });
    // The same key on another resource is refused, never answered with the first resource's result.
    const other = await idempotentWrite(request("/api/mobile/v1/test/b/act", "same-key-0001"), userId, ROUTE, write);
    expect(other.status).toBe(409);
    expect(other.headers.get("idempotent-replayed")).toBeNull();
    expect((await idempotentWrite(request("/api/mobile/v1/test/a/act", "same-key-0001", { n: 2 }), userId, ROUTE, write)).status).toBe(409);
    expect(write).toHaveBeenCalledTimes(1);
    // Only HMACs are stored, never the key itself.
    const rows = await prisma.mobileIdempotencyKey.findMany({ where: { userId } });
    expect(JSON.stringify(rows)).not.toContain("same-key-0001");
    expect(rows[0]!.keyHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it.each([
    ["a rate limit", () => mobileError("RATE_LIMITED")],
    ["a sign-in refusal", () => mobileError("UNAUTHENTICATED")],
    ["a staff authenticator refusal", () => mobileError("STAFF_MFA_REQUIRED")],
    ["a server error", () => mobileError("INTERNAL_ERROR")],
  ])("never keeps %s, so the same key runs again", async (_name, refusal) => {
    const key = `transient-${Math.random().toString(36).slice(2, 10)}`;
    const refused = counter(refusal);
    const before = await prisma.mobileIdempotencyKey.count({ where: { userId } });
    await idempotentWrite(request("/api/mobile/v1/test/t/act", key), userId, ROUTE, refused);
    await expect(prisma.mobileIdempotencyKey.count({ where: { userId } })).resolves.toBe(before);
    const write = counter(() => mobileOk({ id: "ran" }));
    const retried = await idempotentWrite(request("/api/mobile/v1/test/t/act", key), userId, ROUTE, write);
    expect(retried.headers.get("idempotent-replayed")).toBeNull();
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("never keeps a ticket token in the stored answer", async () => {
    const write = counter(() => mobileOk({ rsvpId: "r1", ticketToken: "secret-ticket-token", order: { tickets: [{ ticketToken: "another-secret" }] } }));
    const first = await idempotentWrite(request("/api/mobile/v1/test/k/act", "ticket-key-01"), userId, ROUTE, write);
    await expect(first.json()).resolves.toMatchObject({ data: { ticketToken: "secret-ticket-token" } });
    const rows = await prisma.mobileIdempotencyKey.findMany({ where: { userId } });
    expect(JSON.stringify(rows)).not.toContain("secret");
    const replayed = await idempotentWrite(request("/api/mobile/v1/test/k/act", "ticket-key-01"), userId, ROUTE, write);
    await expect(replayed.json()).resolves.toEqual({ ok: true, data: { rsvpId: "r1", ticketToken: null, order: { tickets: [{ ticketToken: null }] } } });
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("replays a multipart write whose retry picked a new boundary, and hands the route the body", async () => {
    const form = (amount: string) => { const data = new FormData(); data.set("amount", amount); data.append("receipts", new File([new Uint8Array([1, 2, 3])], "r.jpg", { type: "image/jpeg" })); return data; };
    const multipart = (amount: string) => new Request("https://events.example.test/api/mobile/v1/test/m/act", { method: "POST", headers: { "idempotency-key": "multipart-key-1" }, body: form(amount) });
    const run = vi.fn(async (copy: Request) => mobileOk({ amount: (await copy.formData()).get("amount") }, 201));
    expect((await idempotentRequest(multipart("12"), userId, ROUTE, run, 1024 * 1024)).status).toBe(201);
    const replayed = await idempotentRequest(multipart("12"), userId, ROUTE, run, 1024 * 1024);
    expect(replayed.headers.get("idempotent-replayed")).toBe("true");
    await expect(replayed.json()).resolves.toEqual({ ok: true, data: { amount: "12" } });
    expect((await idempotentRequest(multipart("13"), userId, ROUTE, run, 1024 * 1024)).status).toBe(409);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("keeps a definitive refusal and replays it", async () => {
    const write = counter(() => mobileError("CONFLICT", "Someone changed this first."));
    await idempotentWrite(request("/api/mobile/v1/test/c/act", "conflict-key-01"), userId, ROUTE, write);
    const replayed = await idempotentWrite(request("/api/mobile/v1/test/c/act", "conflict-key-01"), userId, ROUTE, write);
    expect(replayed.status).toBe(409);
    expect(replayed.headers.get("idempotent-replayed")).toBe("true");
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("refuses a running first request, then calls an unfinished one stale without running it again", async () => {
    let release: () => void = () => undefined;
    const slow = vi.fn(() => new Promise<Response>((resolve) => { release = () => resolve(mobileOk({ id: "slow" })); }));
    const first = idempotentWrite(request("/api/mobile/v1/test/s/act", "slow-key-0001"), userId, ROUTE, slow);
    await vi.waitFor(() => expect(slow).toHaveBeenCalled());
    const write = counter(() => mobileOk({ id: "again" }));
    const running = await idempotentWrite(request("/api/mobile/v1/test/s/act", "slow-key-0001"), userId, ROUTE, write);
    await expect(running.json()).resolves.toMatchObject({ error: { code: "CONFLICT" } });
    // A first request that started long ago and never finished is stale.
    await prisma.mobileIdempotencyKey.updateMany({ where: { userId, status: 0 }, data: { createdAt: new Date(Date.now() - STALE_AFTER_MS - 1000) } });
    const stale = await idempotentWrite(request("/api/mobile/v1/test/s/act", "slow-key-0001"), userId, ROUTE, write);
    expect(stale.status).toBe(409);
    await expect(stale.json()).resolves.toMatchObject({ error: { code: "IDEMPOTENCY_STALE" } });
    expect(write).not.toHaveBeenCalled();
    release();
    expect((await first).status).toBe(200);
  });

  it("returns the answer and leaves the key unreplayable when keeping the answer fails", async () => {
    const update = vi.spyOn(prisma.mobileIdempotencyKey, "update").mockRejectedValueOnce(new Error("database went away"));
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const write = counter(() => mobileOk({ id: "done" }));
      expect((await idempotentWrite(request("/api/mobile/v1/test/u/act", "update-key-01"), userId, ROUTE, write)).status).toBe(200);
      const again = await idempotentWrite(request("/api/mobile/v1/test/u/act", "update-key-01"), userId, ROUTE, write);
      expect(again.status).toBe(409);
      expect(write).toHaveBeenCalledTimes(1);
      expect(error).toHaveBeenCalledWith(expect.not.stringContaining("update-key-01"));
    } finally {
      update.mockRestore();
      error.mockRestore();
    }
  });
});
