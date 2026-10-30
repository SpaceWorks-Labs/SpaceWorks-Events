import "server-only";

import { beforeDeadline, DEADLINE_PASSED, postPinnedJson } from "@/lib/net/pinnedPost";
import { resolvePublicAddresses } from "@/lib/net/publicAddress";
import type { ResolvedAddress } from "@/lib/webhooks/urlSafety";

export const PRIVATE_WEBHOOK_ERROR = "That webhook address points to a private or local network. Set OPS_WEBHOOK_ALLOW_PRIVATE=1 to allow one, for example a Mattermost on the same network.";

/**
 * The alert webhook host's addresses when they are all public, else null, so
 * the webhook (and its "Send test message", which reports the HTTP status)
 * can't be used to probe this host, its LAN or cloud metadata. A chat server
 * on the operator's own network needs the explicit OPS_WEBHOOK_ALLOW_PRIVATE=1.
 * Any port is allowed: only the MFA-gated super admin sets this address.
 */
async function vettedAddresses(url: string): Promise<ResolvedAddress[] | null> {
  try {
    const host = new URL(url).hostname.replace(/^\[|\]$/g, "");
    return await resolvePublicAddresses(host, process.env.OPS_WEBHOOK_ALLOW_PRIVATE === "1" ? { allowPrivate: true } : {});
  } catch {
    return null;
  }
}

/** Whether the alert webhook's host is allowed (see vettedAddresses); checked when the address is saved. */
export async function isAllowedOpsWebhook(url: string) {
  return (await vettedAddresses(url)) !== null;
}

export type OpsWebhookPost = { status: number; } | { error: "blocked" | "timeout" | "unreachable"; };

/**
 * POST JSON to the alert webhook, connected only to the addresses checked a
 * moment before (pinned, so DNS can't switch them to a private host in
 * between), with TLS checked against the host name, no redirects followed
 * and no response body read. One deadline covers the DNS check, the
 * connection and the reply, until the socket is closed (lib/net/pinnedPost).
 */
export async function postOpsWebhook(url: string, json: string, timeoutMs: number): Promise<OpsWebhookPost> {
  const deadline = Date.now() + timeoutMs;
  const addresses = await beforeDeadline(vettedAddresses(url), deadline);
  if (addresses === DEADLINE_PASSED) return { error: "timeout" };
  if (!addresses) return { error: "blocked" };
  return postPinnedJson(new URL(url), addresses, Buffer.from(json, "utf8"), deadline);
}
