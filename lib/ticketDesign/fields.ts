/**
 * Merge fields a ticket design can print (docs/TICKET_DESIGNER.md): written
 * as {{key}} inside text, filled per ticket on the server. Shared with the
 * editor, which offers them and fills them with sample values.
 */

export const MERGE_FIELDS = [
  { key: "name", label: "Attendee name", sample: "Asha Menon" },
  { key: "event", label: "Event title", sample: "Space Works Hack Day" },
  { key: "date", label: "Date", sample: "Sat 14 Mar 2026" },
  { key: "time", label: "Time", sample: "10:00 – 18:00 IST" },
  { key: "venue", label: "Venue", sample: "Maker Hall, Kochi" },
  { key: "ticket", label: "Ticket type", sample: "General admission" },
  { key: "price", label: "Price", sample: "₹499.00" },
  { key: "order", label: "Order number", sample: "K7QM-3XRA" },
  { key: "registration", label: "Registration number", sample: "R-8F3K2QAB" },
  { key: "team", label: "Team", sample: "Rockets" },
  { key: "organisation", label: "Organisation", sample: "Space Works" },
] as const;

export type MergeFieldKey = (typeof MERGE_FIELDS)[number]["key"];
export type MergeValues = Partial<Record<MergeFieldKey, string>>;

export const SAMPLE_VALUES: MergeValues = Object.fromEntries(MERGE_FIELDS.map((field) => [field.key, field.sample]));

const KNOWN = new Set<string>(MERGE_FIELDS.map((field) => field.key));

/** Text with every {{field}} filled; a field with no value (or an unknown one) prints nothing. */
export function fillMergeFields(text: string, values: MergeValues) {
  return text.replace(/\{\{\s*([a-z]+)\s*\}\}/g, (_, key: string) => (KNOWN.has(key) ? values[key as MergeFieldKey] ?? "" : ""));
}

/** A short, non-secret number for a registration (its id's tail), printed on tickets. */
export function registrationNumber(rsvpId: string) {
  return `R-${rsvpId.slice(-8).toUpperCase()}`;
}
