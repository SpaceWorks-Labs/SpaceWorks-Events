import { describe, expect, it } from "vitest";
import {
  BROADCAST_PLACEHOLDERS,
  BROADCAST_STARTER_TEMPLATES,
  BROADCAST_URL_PLACEHOLDERS,
  broadcastHtmlToText,
  defaultBroadcastTemplate,
  describeBroadcastAudience,
  renderBroadcastHtml,
  renderBroadcastTemplate,
  sampleBroadcastVariables,
} from "@/lib/broadcastTemplate";

const variables = {
  name: "Priya Nair",
  event: "Founders Mixer",
  eventDate: "Sat, Mar 7, 2026, 6:00 PM IST",
  location: "Community Hall",
  eventUrl: "https://events.test/org/mixer",
  ticketLink: "https://events.test/ticket/secret",
  feedbackUrl: "https://events.test/org/mixer/feedback",
  scheduleUrl: "https://events.test/org/mixer/schedule",
  organisation: "Tech4Good",
};

describe("broadcast subject templates", () => {
  it("replaces every documented placeholder, tolerating inner whitespace", () => {
    const template = BROADCAST_PLACEHOLDERS.map((p) => p.token).join(" | ") + " | {{ name }}";
    expect(renderBroadcastTemplate(template, variables)).toBe(
      "Priya Nair | Founders Mixer | Sat, Mar 7, 2026, 6:00 PM IST | Community Hall | https://events.test/org/mixer | https://events.test/ticket/secret | https://events.test/org/mixer/feedback | https://events.test/org/mixer/schedule | Tech4Good | Priya Nair",
    );
  });

  it("leaves unknown placeholders visible so typos are caught in the preview", () => {
    expect(renderBroadcastTemplate("Hi {{nmae}} and {{name}}", variables)).toBe("Hi {{nmae}} and Priya Nair");
  });

  it("falls back to a neutral greeting and strips control characters from names", () => {
    expect(renderBroadcastTemplate("Hello {{name}}", { ...variables, name: null })).toBe("Hello there");
    expect(renderBroadcastTemplate("Hello {{name}}", { ...variables, name: "  \u0000Asha\u0007 " })).toBe("Hello Asha");
    expect(renderBroadcastTemplate("Hello {{name}}", { ...variables, name: "   " })).toBe("Hello there");
  });

  it("uses the event page when a recipient has no ticket link", () => {
    expect(renderBroadcastTemplate("{{ticketLink}}", { ...variables, ticketLink: null })).toBe("https://events.test/org/mixer");
  });
});

describe("broadcast HTML bodies", () => {
  it("escapes substituted values in text and in link targets", () => {
    const html = '<p>Hello {{name}}</p><p><a class="cta" href="{{ticketLink}}">Ticket</a></p>';
    const rendered = renderBroadcastHtml(html, { ...variables, name: '<img src=x onerror="alert(1)">', ticketLink: 'https://events.test/t?a=1&b="2"' });
    expect(rendered).toBe('<p>Hello &lt;img src=x onerror=&quot;alert(1)&quot;&gt;</p><p><a class="cta" href="https://events.test/t?a=1&amp;b=&quot;2&quot;">Ticket</a></p>');
  });

  it("converts the supported HTML subset into readable plain text", () => {
    const html = '<h2>Agenda</h2><p>Hello <strong>Priya</strong>,<br>welcome &amp; enjoy.</p><ul><li>Doors: 6 PM</li><li>Talks: 7 PM</li></ul><p><a class="cta" href="https://events.test/ticket/abc">View your ticket</a></p><p><a href="https://events.test/x">https://events.test/x</a></p>';
    expect(broadcastHtmlToText(html)).toBe([
      "Agenda",
      "",
      "Hello Priya,",
      "welcome & enjoy.",
      "",
      "• Doors: 6 PM",
      "• Talks: 7 PM",
      "",
      "View your ticket (https://events.test/ticket/abc)",
      "",
      "https://events.test/x",
    ].join("\n"));
  });

  it("keeps one line per bullet when list items wrap their text in paragraphs", () => {
    const html = "<ul><li><p><strong>When:</strong> Wed</p></li><li><p><strong>Where:</strong> Hall</p></li></ul><p>Bye</p>";
    expect(broadcastHtmlToText(html)).toBe("• When: Wed\n• Where: Hall\n\nBye");
  });
});

describe("starter templates", () => {
  it("ships at least a dozen templates covering every phase of an event", () => {
    expect(BROADCAST_STARTER_TEMPLATES.length).toBeGreaterThanOrEqual(12);
    const groups = new Set(BROADCAST_STARTER_TEMPLATES.map((template) => template.group));
    expect([...groups]).toEqual(expect.arrayContaining(["Before the event", "During the event", "After the event", "Registration"]));
    const ids = BROADCAST_STARTER_TEMPLATES.map((template) => template.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(expect.arrayContaining(["reminder", "agenda", "know-before-you-go", "thank-you", "cancelled"]));
  });

  it("only uses known placeholders, valid link placeholders, and a non-empty audience", () => {
    const known = new Set(BROADCAST_PLACEHOLDERS.map((placeholder) => placeholder.token.replace(/[{}]/g, "")));
    for (const template of BROADCAST_STARTER_TEMPLATES) {
      for (const match of `${template.subject}${template.bodyHtml}`.matchAll(/\{\{\s*([a-zA-Z]+)\s*\}\}/g)) {
        expect(known.has(match[1]!), `${template.id} uses {{${match[1]}}}`).toBe(true);
      }
      for (const match of template.bodyHtml.matchAll(/href="\{\{\s*([a-zA-Z]+)\s*\}\}"/g)) {
        expect(BROADCAST_URL_PLACEHOLDERS as readonly string[]).toContain(match[1]);
      }
      expect(template.audience.statuses.length).toBeGreaterThan(0);
      expect(renderBroadcastHtml(template.bodyHtml, variables)).not.toMatch(/\{\{/);
      expect(renderBroadcastTemplate(template.subject, variables)).not.toMatch(/\{\{/);
    }
  });

  it("uses the first template as the default", () => {
    expect(defaultBroadcastTemplate()).toEqual({ subject: BROADCAST_STARTER_TEMPLATES[0]!.subject, body: BROADCAST_STARTER_TEMPLATES[0]!.bodyHtml });
  });
});

describe("audience helpers", () => {
  it("describes audiences in plain language", () => {
    expect(describeBroadcastAudience(["CONFIRMED"], "ANY")).toBe("confirmed registrations");
    expect(describeBroadcastAudience(["CONFIRMED", "WAITLISTED"], "NOT_CHECKED_IN")).toBe("confirmed, waitlisted registrations who did not check in");
    expect(describeBroadcastAudience(["CONFIRMED", "WAITLISTED", "PENDING_APPROVAL", "REJECTED"], "CHECKED_IN")).toBe("all registrations who checked in");
    expect(describeBroadcastAudience([], "ANY")).toBe("no registrations");
  });

  it("builds sample variables with derived links and location labels", () => {
    const base = { title: "Demo", startDateTime: new Date("2030-01-01T10:00:00Z"), timezone: "UTC", eventUrl: "https://events.test/o/e", organisationName: "Org" };
    const sample = sampleBroadcastVariables({ ...base, location: "", isOnline: true });
    expect(sample.location).toBe("Online");
    expect(sample.feedbackUrl).toBe("https://events.test/o/e/feedback");
    expect(sample.scheduleUrl).toBe("https://events.test/o/e/schedule");
    expect(sampleBroadcastVariables({ ...base, location: "", isOnline: false }).location).toBe("the venue");
    expect(sampleBroadcastVariables({ ...base, location: "Hall A", isOnline: false }, "Organiser").name).toBe("Organiser");
  });

  it("writes each link URL once in the plain-text version, decoded once", () => {
    expect(broadcastHtmlToText('<p><a href="https://example.test/?a=1&amp;b=2">https://example.test/?a=1&amp;b=2</a></p>')).toBe("https://example.test/?a=1&b=2");
    expect(broadcastHtmlToText('<p><a href="https://example.test/?q=&amp;lt;b&amp;gt;">Form</a></p>')).toBe("Form (https://example.test/?q=&lt;b&gt;)");
  });

  it("leaves out-of-range numeric entities as written instead of throwing", () => {
    const base = { title: "Demo", startDateTime: new Date("2030-01-01T10:00:00Z"), timezone: "UTC", location: "Hall A", isOnline: false, eventUrl: "https://events.test/o/e", organisationName: "Org" };
    const html = renderBroadcastHtml('<p><a href="https://forms.test/?n={{name}}">Form</a></p>', sampleBroadcastVariables(base, "&#99999999;"));
    expect(broadcastHtmlToText(html)).toBe("Form (https://forms.test/?n=&#99999999;)");
    expect(broadcastHtmlToText("<p>&#99999999; &#x110000; &#65;</p>")).toBe("&#99999999; &#x110000; A");
  });

  it("keeps inherited property names literally instead of resolving Object.prototype", () => {
    const tokens = "{{constructor}} {{toString}} {{hasOwnProperty}} {{valueOf}} {{name}}";
    expect(renderBroadcastTemplate(tokens, variables)).toBe("{{constructor}} {{toString}} {{hasOwnProperty}} {{valueOf}} Priya Nair");
    expect(renderBroadcastHtml(`<p>${tokens}</p>`, variables)).toBe("<p>{{constructor}} {{toString}} {{hasOwnProperty}} {{valueOf}} Priya Nair</p>");
  });
});
