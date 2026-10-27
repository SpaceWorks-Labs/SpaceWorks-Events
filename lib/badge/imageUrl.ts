/*
 * Badge artwork comes only from application-managed uploads: WebP derivatives
 * that went through validation, re-encoding and metadata stripping, served by
 * /api/uploads. Remote URLs (provider avatars, pasted links) are never drawn,
 * in the browser or on the server, so badge rendering can't be used to fetch
 * arbitrary hosts (SSRF) or embed unvetted images.
 *
 * The key patterns mirror `isPublicDerivativeKey` in lib/storage, which stays
 * the final check when the server reads the bytes.
 */

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const OWNER = "[A-Za-z0-9_-]{1,128}";
const ORGANISATION_KEY = new RegExp(`^organisations/(${OWNER})/(event-sponsors|event-crew|organisation-logos|event-page-logos|member-id-photos|member-id-watermarks|ticket-design-images)/${UUID}\\.webp$`, "i");
const USER_KEY = new RegExp(`^users/(${OWNER})/profile-images/${UUID}\\.webp$`, "i");

export type ManagedImageScope =
  | { kind: "organisation"; organisationId: string; category: "event-sponsors" | "event-crew" | "organisation-logos" | "event-page-logos" | "member-id-photos" | "member-id-watermarks" | "ticket-design-images" }
  | { kind: "user"; userId: string };

/**
 * The path of an upload URL. Absolute URLs are reduced to their path: the
 * host is never contacted, the key is only ever read from our own storage
 * (and served same-origin), so a stored absolute URL keeps working after a
 * hostname change.
 */
function uploadPath(value: string) {
  const trimmed = value.trim();
  if (trimmed.startsWith("/") && !trimmed.startsWith("//")) return trimmed.split(/[?#]/)[0]!;
  try {
    const url = new URL(trimmed);
    return url.protocol === "https:" || url.protocol === "http:" ? url.pathname : null;
  } catch {
    return null;
  }
}

/** The storage key behind a managed upload URL, or null for anything else. */
export function managedImageKey(value: string | null | undefined, scope?: ManagedImageScope): string | null {
  if (!value || value.length > 600) return null;
  const path = uploadPath(value);
  if (!path) return null;
  const match = /^\/api\/uploads\/([A-Za-z0-9/_.-]+)$/.exec(path);
  if (!match) return null;
  const key = match[1]!;
  if (key.includes("..")) return null;
  const organisation = ORGANISATION_KEY.exec(key);
  const user = USER_KEY.exec(key);
  if (!scope) return organisation || user ? key : null;
  if (scope.kind === "organisation") return organisation && organisation[1] === scope.organisationId && organisation[2] === scope.category ? key : null;
  return user && user[1] === scope.userId ? key : null;
}

/** A same-origin URL for a managed upload, or null when the value isn't one. */
export function managedImageUrl(value: string | null | undefined, scope?: ManagedImageScope): string | null {
  const key = managedImageKey(value, scope);
  return key ? `/api/uploads/${key}` : null;
}

/** The attendee's own uploaded profile picture; provider avatars (remote URLs) are skipped. */
export function attendeePhotoUrl(user: { id: string; profileImageUrl: string | null; image: string | null } | null | undefined) {
  if (!user) return null;
  return managedImageUrl(user.profileImageUrl, { kind: "user", userId: user.id })
    ?? managedImageUrl(user.image, { kind: "user", userId: user.id });
}
