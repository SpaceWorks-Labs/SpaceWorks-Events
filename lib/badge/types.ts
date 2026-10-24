import { applyIdCardMergeFields, ID_CARD_TEAM_FIELD_KEY, type IdCardPrintSettings } from "@/lib/idCardPrint";

/** Everything printed about one attendee. */
export type IdCardAttendee = {
  rsvpId?: string;
  displayName: string;
  email: string | null;
  /** Active ticket bearer token used only for rendering this attendee's QR. Never log or persist it. */
  checkInQrToken: string;
  checkInDetails: Array<{ label: string; value: string }>;
  registrationDetails: Array<{ key: string; label: string; value: string }>;
  /** Managed (uploaded) profile image only; see lib/badge/imageUrl.ts. */
  photoUrl?: string | null;
  /** Member ID cards: the printed ID number, e.g. SWK-2026-0042. */
  idNumber?: string | null;
  /** Member ID cards: the expiry date, already formatted for print. */
  validUntil?: string | null;
  /** TEAM events: the attendee's team, for the {{team}} merge field and the Team line. */
  teamName?: string | null;
};

/**
 * Event and organisation artwork for badges. Every URL is an
 * application-managed upload URL that passed `managedImageUrl`.
 */
export type BadgeBranding = {
  eventAccent: string | null;
  organisationLogoUrl: string | null;
  eventLogoUrl: string | null;
  sponsorLogoUrls: string[];
  /** Member ID cards: an uploaded watermark image (managed upload). */
  watermarkUrl?: string | null;
};

export const EMPTY_BRANDING: BadgeBranding = { eventAccent: null, organisationLogoUrl: null, eventLogoUrl: null, sponsorLogoUrls: [] };

export type PrintableField = { key: string; label: string; value: string };

/** The registration answers (and the Team line) chosen for the card, in the chosen order, that this attendee actually has. */
export function printableFields(settings: IdCardPrintSettings, attendee: Pick<IdCardAttendee, "registrationDetails" | "teamName">): PrintableField[] {
  const details = new Map(attendee.registrationDetails.map((detail) => [detail.key, detail]));
  return settings.printFieldKeys.flatMap((key) => {
    if (key === ID_CARD_TEAM_FIELD_KEY) {
      const team = attendee.teamName?.trim();
      return team ? [{ key, label: "Team", value: team }] : [];
    }
    const detail = details.get(key.startsWith("registration:") ? key.slice("registration:".length) : key);
    return detail ? [{ key, label: detail.label, value: detail.value }] : [];
  });
}

/** The settings with `{{team}}` filled in the heading, badge label and footer for this attendee. */
export function withMergeFields(settings: IdCardPrintSettings, attendee: Pick<IdCardAttendee, "teamName">): IdCardPrintSettings {
  const values = { team: attendee.teamName };
  const heading = applyIdCardMergeFields(settings.heading, values);
  const badgeLabel = applyIdCardMergeFields(settings.badgeLabel, values);
  const footerText = applyIdCardMergeFields(settings.footerText, values);
  if (heading === settings.heading && badgeLabel === settings.badgeLabel && footerText === settings.footerText) return settings;
  return { ...settings, heading, badgeLabel, footerText };
}

/** Up to two initials for the photo placeholder. */
export function attendeeInitials(name: string) {
  const words = name.replace(/[^\p{L}\p{N}\s'-]/gu, " ").trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  const first = [...words[0]!][0] ?? "";
  const last = words.length > 1 ? [...words[words.length - 1]!][0] ?? "" : "";
  return (first + last).toLocaleUpperCase("en");
}
