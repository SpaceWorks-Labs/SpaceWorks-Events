import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  metrics: vi.fn(),
  pdf: vi.fn(),
  membership: vi.fn(),
  isAdmin: vi.fn(),
  audit: vi.fn(),
  limited: vi.fn(),
  findEvent: vi.fn(),
  findDate: vi.fn(),
  occurrenceMetrics: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ auth: mocks.auth }));
vi.mock("@/lib/audit", () => ({ recordAuditEvent: mocks.audit }));
vi.mock("@/lib/permissions", () => ({ getMembership: mocks.membership, isOrgAdmin: mocks.isAdmin }));
vi.mock("@/lib/actionRateLimit", () => ({ isActionRateLimited: mocks.limited }));
vi.mock("@/lib/db", () => ({ prisma: { event: { findUnique: mocks.findEvent }, eventInstance: { findUnique: mocks.findDate } } }));
vi.mock("@/lib/eventReport", () => ({
  getEventReportMetrics: mocks.metrics,
  getOccurrenceReportMetrics: mocks.occurrenceMetrics,
  createEventReportPdf: mocks.pdf,
  isReportAvailable: (end: Date) => end.getTime() <= Date.now(),
  reportFilename: () => "safe-report.pdf",
}));

import { GET } from "@/app/api/reports/event/[eventId]/route";
import { GET as GET_DATE } from "@/app/api/reports/instance/[instanceId]/route";

const ended = new Date("2025-01-01T00:00:00Z");
const metrics = {
  targetId: "event_1",
  organisationId: "org_1",
  endDateTime: ended,
};
const request = () => GET(new Request("https://events.example.test/api/reports/event/event_1"), { params: Promise.resolve({ eventId: "event_1" }) });

describe("event report route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth.mockResolvedValue({ user: { id: "user_1" } });
    mocks.metrics.mockResolvedValue(metrics);
    mocks.limited.mockResolvedValue(false);
    mocks.findEvent.mockResolvedValue({ organisationId: "org_1", endDateTime: ended });
    mocks.membership.mockResolvedValue({ role: "MEMBER" });
    mocks.isAdmin.mockReturnValue(false);
    mocks.pdf.mockResolvedValue(new Uint8Array([37, 80, 68, 70]));
  });

  it("returns a generic not-found response and never loads metrics for a non-admin", async () => {
    const response = await request();
    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.metrics).not.toHaveBeenCalled();
    expect(mocks.pdf).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it("never loads metrics for someone outside the organisation, an unknown event or one still running", async () => {
    mocks.membership.mockResolvedValue(null);
    expect((await request()).status).toBe(404);
    mocks.isAdmin.mockReturnValue(true);
    mocks.membership.mockResolvedValue({ role: "ADMIN" });
    mocks.findEvent.mockResolvedValueOnce(null);
    expect((await request()).status).toBe(404);
    mocks.findEvent.mockResolvedValueOnce({ organisationId: "org_1", endDateTime: new Date(Date.now() + 3_600_000) });
    expect((await request()).status).toBe(404);
    expect(mocks.metrics).not.toHaveBeenCalled();
  });

  it("limits report downloads per account before reading anything", async () => {
    mocks.limited.mockResolvedValue(true);
    const response = await request();
    expect(response.status).toBe(429);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.limited).toHaveBeenCalledWith("report", "user_1");
    expect(mocks.findEvent).not.toHaveBeenCalled();
    expect(mocks.membership).not.toHaveBeenCalled();
    expect(mocks.metrics).not.toHaveBeenCalled();
  });

  it("applies the same checks to a series date's report", async () => {
    mocks.findDate.mockResolvedValue({ endDateTime: ended, series: { organisationId: "org_1" } });
    const response = await GET_DATE(new Request("https://events.example.test/api/reports/instance/date_1"), { params: Promise.resolve({ instanceId: "date_1" }) });
    expect(response.status).toBe(404);
    expect(mocks.membership).toHaveBeenCalledWith("user_1", "org_1");
    expect(mocks.occurrenceMetrics).not.toHaveBeenCalled();
  });

  it("serves an audited, non-cacheable attachment to an organisation admin", async () => {
    mocks.isAdmin.mockReturnValue(true);
    const response = await request();
    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toBe('attachment; filename="safe-report.pdf"');
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "EVENT_REPORT_DOWNLOADED", organisationId: "org_1" }));
  });
});
