export const SECTION_LABELS: Record<string, string> = {
  ABOUT: "About",
  SCHEDULE: "Schedule",
  SPEAKERS: "Speakers",
  SPONSORS: "Partners",
  VENUE: "Venue",
  FAQ: "FAQ",
  RESOURCES: "Resources",
  CREW: "Crew",
};

export const TIER_LABELS: Record<string, string> = { PLATINUM: "Platinum", GOLD: "Gold", SILVER: "Silver", PARTNER: "Partner", COMMUNITY_PARTNER: "Community" };

export function mapSearchQuery(location: string, mapLinkUrl: string | null) {
  if (mapLinkUrl) {
    try {
      const url = new URL(mapLinkUrl);
      const urlQuery = url.searchParams.get("query") || url.searchParams.get("q") || url.searchParams.get("destination");
      if (urlQuery) return urlQuery;
    } catch {
      // The server rejects invalid URLs, but retain a safe rendering fallback.
    }
  }
  return location.trim() || null;
}

export function duration(start: string, end: string) {
  const minutes = Math.max(0, Math.round((new Date(end).getTime() - new Date(start).getTime()) / 60_000));
  if (minutes === 0) return null;
  if (minutes < 60) return `${minutes} min`;
  const hours = minutes / 60;
  return Number.isInteger(hours) ? `${hours} hr` : `${Math.floor(hours)} hr ${minutes % 60} min`;
}

export function Rich({ html }: { html: string }) {
  return html ? <div className="yy-prose" dangerouslySetInnerHTML={{ __html: html }} /> : null;
}
