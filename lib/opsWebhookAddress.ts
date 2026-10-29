import "server-only";

import http from "node:http";
import https from "node:https";
import net from "node:net";
import { resolvePublicAddresses } from "@/lib/net/publicAddress";
import { pinnedLookup, type ResolvedAddress } from "@/lib/webhooks/urlSafety";

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
 * and no response body read.
 */
export async function postOpsWebhook(url: string, json: string, timeoutMs: number): Promise<OpsWebhookPost> {
  const addresses = await vettedAddresses(url);
  if (!addresses) return { error: "blocked" };
  const target = new URL(url);
  const hostname = target.hostname.replace(/^\[|\]$/g, "");
  const isHttps = target.protocol === "https:";
  const body = Buffer.from(json, "utf8");
  return new Promise<OpsWebhookPost>((resolve) => {
    let settled = false;
    const finish = (outcome: OpsWebhookPost) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };
    const request = (isHttps ? https : http).request({
      protocol: target.protocol,
      hostname,
      port: target.port || (isHttps ? 443 : 80),
      path: `${target.pathname}${target.search}`,
      method: "POST",
      agent: false,
      lookup: pinnedLookup(addresses) as unknown as net.LookupFunction,
      ...(isHttps && !net.isIP(hostname) ? { servername: hostname } : {}),
      headers: { "content-type": "application/json", "content-length": String(body.length) },
    }, (response) => {
      response.resume();
      finish({ status: response.statusCode ?? 0 });
    });
    const timer = setTimeout(() => {
      finish({ error: "timeout" });
      request.destroy();
    }, timeoutMs);
    request.on("error", () => finish({ error: "unreachable" }));
    request.end(body);
  });
}
