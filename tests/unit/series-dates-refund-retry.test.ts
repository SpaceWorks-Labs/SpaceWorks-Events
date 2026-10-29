import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/components/feedback/ToastProvider", () => ({ useToast: () => ({ showToast: vi.fn() }) }));
vi.mock("@/app/actions/series", () => ({ cancelSeriesDate: vi.fn(), setSeriesDateCapacity: vi.fn() }));

import { SeriesDatesManager } from "@/components/series/SeriesDatesManager";

const props = {
  organisationSlug: "org", seriesId: "series", seriesCapacity: null, timeZone: "UTC", canManage: true,
  dates: [{ id: "date", start: "2000-01-01T12:00:00.000Z", capacity: null, taken: 0, cancelled: true }],
};

describe("cancelled series date refund controls", () => {
  it("offers Finish refunds on a past cancelled date", () => {
    const html = renderToString(createElement(SeriesDatesManager, props));
    expect(html).toContain("Finish refunds");
    expect(html).toContain("Cancelled");
    expect(html).not.toContain("Cancel date");
    expect(html).not.toContain(">Capacity<");
  });

  it("keeps the retry restricted to managers", () => {
    expect(renderToString(createElement(SeriesDatesManager, { ...props, canManage: false }))).not.toContain("Finish refunds");
  });

  it("keeps first cancellation controls on uncancelled dates", () => {
    const html = renderToString(createElement(SeriesDatesManager, { ...props, dates: [{ ...props.dates[0], cancelled: false }] }));
    expect(html).toContain("Cancel date");
    expect(html).not.toContain("Finish refunds");
  });
});
