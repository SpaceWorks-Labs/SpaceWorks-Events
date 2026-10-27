import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ sendMail: vi.fn() }));
vi.mock("@/lib/email/transporter", () => ({
  getEmailTransport: vi.fn().mockResolvedValue({ transporter: { sendMail: mocks.sendMail }, from: "Space Works Events <noreply@example.test>" }),
}));

import { sendCrewTicketEmail } from "@/lib/email/crew";

const calendarEvent = { startDateTime: new Date("2030-01-01T10:00:00.000Z"), endDateTime: new Date("2030-01-01T12:00:00.000Z"), timezone: "Asia/Kolkata", location: "Hall A" };

describe("crew ticket email", () => {
  beforeEach(() => vi.clearAllMocks());

  it("words a crew ticket for the organising team and keeps escaping", async () => {
    await sendCrewTicketEmail({
      to: "crew@example.test",
      eventTitle: "Launch <b>night</b>\r\nBcc: victim@example.test",
      checkInToken: "crew-ticket",
      recipientName: "Asha",
      role: "Stage <i>lead</i>",
      calendarEvent,
      messageId: "<stable@outbox.invalid>",
    });
    const message = mocks.sendMail.mock.calls[0]?.[0];
    expect(message.subject).toBe("You're on the crew for Launch <b>night</b> Bcc: victim@example.test");
    expect(message.subject).not.toMatch(/[\r\n]/);
    expect(message.html).toContain("You're on the crew for <strong>Launch &lt;b&gt;night&lt;/b&gt;");
    expect(message.html).toContain("Stage &lt;i&gt;lead&lt;/i&gt;");
    expect(message.html).not.toContain("<b>night</b>");
    expect(message.html).not.toContain("Thank you for registering");
    expect(message.html).toContain("/ticket/crew-ticket");
    expect(message.text).toContain("This is your crew ticket: show it at check-in.");
    expect(message.icalEvent?.method).toBe("PUBLISH");
    expect(message.attachments).toBeUndefined();
  });

  it("attaches the designed ticket when there is one", async () => {
    await sendCrewTicketEmail({ to: "crew@example.test", eventTitle: "Event", checkInToken: "tok", calendarEvent, ticketPdf: { filename: "event-ticket.pdf", content: Buffer.from("pdf") } });
    const message = mocks.sendMail.mock.calls[0]?.[0];
    expect(message.attachments).toEqual([{ filename: "event-ticket.pdf", content: Buffer.from("pdf"), contentType: "application/pdf" }]);
  });
});
