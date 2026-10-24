import type { TeamRegistrationConfig } from "@/components/rsvp/TeamRegistrationFields";
import type { RegistrationFieldDefinition } from "@/components/rsvp/registrationTypes";
import type { RsvpStatus } from "@prisma/client";
import type { PublicTicketType } from "@/lib/payments/tickets";
import type { TicketingInfo } from "@/components/rsvp/PromoCodeField";

export type Props = {
  /** Team event settings (docs/TEAMS.md); null for individual registration. */
  team?: TeamRegistrationConfig | null;
  /**
   * Hackathon pages (docs/HACKATHON.md): each href is set only when that page
   * is live (results published; gallery public after the window closed).
   */
  judging?: { resultsHref: string | null; projectsHref: string | null } | null;
  orgSlug: string;
  organisation: { name: string; logoUrl: string | null };
  preview: boolean;
  event: {
    slug: string;
    title: string;
    coverImageUrl: string | null;
    location: string;
    isOnline: boolean;
    status: string;
    start: string;
    end: string;
    timezone: string;
    capacity: number | null;
  };
  page: {
    tagline: string;
    logoUrl: string | null;
    accentColor: string | null;
    aboutHtml: string;
    sections: Array<{ type: string; isVisible: boolean }>;
  };
  highlights: Array<{ id: string; title: string; description: string }>;
  sessions: Array<{
    id: string;
    slug: string;
    title: string;
    start: string;
    end: string;
    type: string;
    trackId: string;
    trackName: string;
    trackSortOrder: number;
    speakers: Array<{ slug: string; name: string }>;
  }>;
  speakers: Array<{ id: string; slug: string; name: string; photoUrl: string | null; websiteUrl: string | null; headline: string; organisation: string }>;
  sponsors: Array<{ id: string; name: string; logoUrl: string | null; description: string; websiteUrl: string | null; tier: string }>;
  venue: { location: string; mapLinkUrl: string | null } | null;
  faqs: Array<{ id: string; question: string; answerHtml: string }>;
  resources: Array<{ id: string; title: string; description: string; href: string }>;
  registrationFields: RegistrationFieldDefinition[];
  confirmedCount: number | null;
  registrationOpen: boolean;
  /** At capacity: new registrations join the waitlist. Derived server-side. */
  registrationFull: boolean;
  approvalRequired: boolean;
  /** The signed-in viewer's own registration, so the card shows it on any device. */
  viewerRsvp?: { token: string; status: RsvpStatus } | null;
  /** Ticket types on sale; empty for a free event without types. */
  tickets?: PublicTicketType[];
  /** Seats currently held while attendees pay. */
  heldCount?: number;
  paidSalesOpen?: boolean;
  /** Paid tickets: whether promo codes exist, and the refund terms. */
  ticketing?: TicketingInfo | null;
};
