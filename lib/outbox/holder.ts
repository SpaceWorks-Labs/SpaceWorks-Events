import "server-only";

/** Only the current holder may receive capabilities resolved from a registration. */
type Holder = { guestEmail: string | null; user: { email: string | null } | null };

export function isCurrentHolderRecipient(holder: Holder | null, to: string): boolean {
  const email = holder?.user?.email?.trim() || holder?.guestEmail?.trim();
  return Boolean(email && email.toLowerCase() === to.trim().toLowerCase());
}
