export type CalendarEvent = {
  title: string;
  startDateTime: Date;
  endDateTime: Date;
  timezone: string;
  location?: string | null;
};

function escapeCalendarText(value: string) {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\r\n|\r|\n/g, "\\n")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/[\u0000-\u001F\u007F]/g, "");
}

function formatCalendarDate(value: Date) {
  return value.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

/** Creates a prefilled Google Calendar event without putting any ticket capability in the URL. */
export function googleCalendarEventUrl(event: CalendarEvent) {
  const url = new URL("https://calendar.google.com/calendar/render");
  url.searchParams.set("action", "TEMPLATE");
  url.searchParams.set("text", event.title);
  url.searchParams.set("dates", `${formatCalendarDate(event.startDateTime)}/${formatCalendarDate(event.endDateTime)}`);
  url.searchParams.set("details", `Your confirmed Space Works Events RSVP. Event timezone: ${event.timezone}`);
  if (event.location?.trim()) url.searchParams.set("location", event.location.trim());
  return url.toString();
}

/** RFC 5545 limits content lines to 75 octets; continuations begin with one space. */
function foldCalendarLine(line: string) {
  const lines: string[] = [];
  let current = "";
  let byteLength = 0;

  for (const character of line) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (byteLength + characterBytes > 75 && current) {
      lines.push(current);
      current = ` ${character}`;
      byteLength = 1 + characterBytes;
    } else {
      current += character;
      byteLength += characterBytes;
    }
  }
  lines.push(current);
  return lines.join("\r\n");
}

/** Builds a portable UTC iCalendar event. Calendar clients display UTC values in the recipient's local timezone. */
export function createCalendarInvite(event: CalendarEvent & { uid: string; createdAt?: Date; description?: string }) {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Space Works//Space Works Events//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${escapeCalendarText(event.uid)}`,
    `DTSTAMP:${formatCalendarDate(event.createdAt ?? new Date())}`,
    `DTSTART:${formatCalendarDate(event.startDateTime)}`,
    `DTEND:${formatCalendarDate(event.endDateTime)}`,
    `SUMMARY:${escapeCalendarText(event.title)}`,
    `DESCRIPTION:${escapeCalendarText(event.description ?? `Your confirmed Space Works Events RSVP. Event timezone: ${event.timezone}`)}`,
    ...(event.location?.trim() ? [`LOCATION:${escapeCalendarText(event.location.trim())}`] : []),
    "STATUS:CONFIRMED",
    "END:VEVENT",
    "END:VCALENDAR",
    "",
  ];
  return lines.map(foldCalendarLine).join("\r\n");
}

export function calendarInviteFilename(title: string) {
  const safeTitle = title
    .replace(/[^a-zA-Z0-9 _-]/g, "")
    .replace(/\s+/g, "_")
    .slice(0, 50) || "event";
  return `${safeTitle}.ics`;
}
