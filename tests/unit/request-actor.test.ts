import { describe, expect, it, vi } from "vitest";
import { ANONYMOUS_ACTOR, currentMobileActor, currentRequestActor as anyActor, outsideRequestActor, runAsRequestActor, type MobileRequestActor } from "@/lib/requestActor";

const currentRequestActor = currentMobileActor;

const actor = (userId: string): MobileRequestActor => ({ kind: "mobile", userId, sessionId: `s-${userId}`, mfaVerifiedAt: null, authenticatedAt: new Date() });
const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("request actors", () => {
  it("keeps concurrent requests apart across awaits", async () => {
    const seen = await Promise.all(["a", "b", "c"].map((id, index) => runAsRequestActor(actor(id), async () => {
      await tick(10 - index * 3);
      const first = currentRequestActor()?.userId;
      await tick(index * 3);
      return [first, currentRequestActor()?.userId];
    })));
    expect(seen).toEqual([["a", "a"], ["b", "b"], ["c", "c"]]);
    expect(currentRequestActor()).toBeUndefined();
  });

  it("restores the outer actor after a nested run", async () => {
    await runAsRequestActor(actor("outer"), async () => {
      await runAsRequestActor({ ...actor("outer"), checkInSource: "mobile-scan" }, async () => {
        expect(currentRequestActor()?.checkInSource).toBe("mobile-scan");
      });
      expect(currentRequestActor()).toMatchObject({ userId: "outer" });
      expect(currentRequestActor()?.checkInSource).toBeUndefined();
    });
  });

  it("runs a request without a bearer as the anonymous actor", async () => {
    await runAsRequestActor(ANONYMOUS_ACTOR, async () => {
      expect(anyActor()).toEqual({ kind: "anonymous" });
      expect(currentMobileActor()).toBeUndefined();
    });
  });

  it("never lets background work started in a request inherit its actor", async () => {
    const later: Array<string | undefined> = [];
    await runAsRequestActor(actor("phone"), async () => {
      outsideRequestActor(() => {
        setTimeout(() => later.push(currentRequestActor()?.userId), 5);
        queueMicrotask(() => later.push(currentRequestActor()?.userId));
      });
      setTimeout(() => later.push(currentRequestActor()?.userId), 5);
    });
    await tick(20);
    expect(later.sort()).toEqual([undefined, undefined, "phone"].sort());
  });

  it("delivers live check-in events to listeners without the publishing request's actor", async () => {
    // In-process delivery: a configured but unreachable Redis (the Quality gate) delays it past the wait.
    vi.stubEnv("REDIS_URL", "");
    const { publishTicketCheckedIn, subscribeTicketCheckedIn } = await import("@/lib/ticketCheckInEvents");
    const seen: unknown[] = [];
    const unsubscribe = subscribeTicketCheckedIn("rsvp-actor-test", () => seen.push(currentRequestActor()));
    await runAsRequestActor(actor("door"), async () => {
      publishTicketCheckedIn({ rsvpId: "rsvp-actor-test", checkedInAt: new Date() });
    });
    await tick(5);
    unsubscribe();
    vi.unstubAllEnvs();
    expect(seen).toEqual([undefined]);
  });
});
