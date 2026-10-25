import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock("@/components/feedback/ToastProvider", () => ({ useToast: () => ({ showToast: vi.fn() }) }));
vi.mock("@/app/actions/event", () => ({ cancelEvent: vi.fn(), cloneEvent: vi.fn(), deleteEvent: vi.fn(), updateEventSlug: vi.fn() }));

import { EventManageMore } from "@/components/dashboard/EventManageMore";
import type { EventClientDto } from "@/lib/eventDto";

const event = { id: "event_1", slug: "hack", title: "Hack Day" } as unknown as EventClientDto;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("EventManageMore first render", () => {
  it("renders the embed snippets the same whether or not a window exists, so hydration matches the server HTML", () => {
    const server = renderToString(createElement(EventManageMore, { organisationSlug: "org", event }));
    // The browser's first (hydrating) render must not read window.location: React #418 otherwise.
    vi.stubGlobal("window", { location: { origin: "https://events.example" } });
    const hydrating = renderToString(createElement(EventManageMore, { organisationSlug: "org", event }));
    expect(hydrating).toBe(server);
    expect(server).not.toContain("https://events.example");
    expect(server).toContain("/embed/org/hack");
  });
});
