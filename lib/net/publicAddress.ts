import "server-only";

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { isBlockedWebhookAddress, type ResolvedAddress } from "@/lib/webhooks/urlSafety";

export class PrivateAddressError extends Error {
  override name = "PrivateAddressError";
  constructor() {
    super("That server address points to a private or local network.");
  }
}

/**
 * Networks an organisation's server address may never reach: this host, its
 * LAN, cloud metadata and every other non-public range. The classifier is the
 * organisation webhooks' (lib/webhooks/urlSafety.ts), so IPv4 written as IPv6
 * (mapped, NAT64, 6to4) is judged by its IPv4 address, and site-local, Teredo
 * and documentation ranges are refused too.
 */
export function isBlockedAddress(address: string) {
  return isBlockedWebhookAddress(address);
}

/**
 * Resolve a host an organisation entered to the public addresses to connect
 * to; pin the connection to them. Every address it resolves to must be
 * public, so a name can't hide a private one. `allowPrivate` is for
 * development and tests only.
 */
export async function resolvePublicAddresses(host: string, options: { allowPrivate?: boolean; } = {}): Promise<ResolvedAddress[]> {
  const allowPrivate = options.allowPrivate ?? process.env.NODE_ENV !== "production";
  const literal = isIP(host);
  const addresses: ResolvedAddress[] = literal
    ? [{ address: host, family: literal === 6 ? 6 : 4 }]
    : (await lookup(host, { all: true, verbatim: true })).map((entry) => ({ address: entry.address, family: entry.family === 6 ? 6 : 4 }));
  if (addresses.length === 0) throw new PrivateAddressError();
  if (!allowPrivate && addresses.some(({ address }) => isBlockedAddress(address))) throw new PrivateAddressError();
  return addresses;
}

/** One public address to connect to, for a client given a literal address (SMTP). */
export async function resolvePublicAddress(host: string, options: { allowPrivate?: boolean; } = {}) {
  return (await resolvePublicAddresses(host, options))[0]!.address;
}
