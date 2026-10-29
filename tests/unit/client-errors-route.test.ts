import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ report: vi.fn(), limit: vi.fn() }));
vi.mock("@/lib/opsAlerts", () => ({ reportOpsAlert: mocks.report, sanitizeAlertPath: (path: string) => path }));
vi.mock("@/lib/rateLimit", () => ({ getClientIpFromHeaders: () => "203.0.113.5", checkRateLimitById: mocks.limit }));

import { POST } from "@/app/api/client-errors/route";
import { chunkedRequest, oversizedJsonParts } from "@/tests/helpers/chunkedRequest";

const ENDPOINT = "https://events.example.test/api/client-errors";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.limit.mockResolvedValue(true);
});

describe("POST /api/client-errors body cap", () => {
  it("stops reading a chunked report without Content-Length past 4 KiB and still answers an empty 204", async () => {
    const stream = chunkedRequest(ENDPOINT, oversizedJsonParts(512 * 1024));
    const response = await POST(stream.request);
    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
    expect(stream.cancelled()).toBe(true);
    expect(stream.pulled()).toBeLessThan(10);
    expect(mocks.report).not.toHaveBeenCalled();
  });

  it("forwards a normal chunked report", async () => {
    const body = JSON.stringify({ boundary: "route", name: "TypeError", message: "x is undefined", path: "/acme" });
    const response = await POST(chunkedRequest(ENDPOINT, [body.slice(0, 12), body.slice(12)]).request);
    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
    expect(mocks.report).toHaveBeenCalledWith(expect.objectContaining({ source: "browser", title: "Page crashed in the browser", context: { page: "/acme" } }));
  });
});
