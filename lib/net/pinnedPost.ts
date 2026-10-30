import "server-only";

import http from "node:http";
import https from "node:https";
import net from "node:net";
import { pinnedLookup, type ResolvedAddress } from "@/lib/webhooks/urlSafety";

/*
 * A JSON POST to a server someone else runs (the alert webhook, an
 * organisation's Mattermost), under one absolute deadline that the caller
 * starts before its DNS check. Node's own `timeout` only measures socket
 * inactivity, so a server answering a byte at a time could hold a worker for
 * hours; here the deadline runs until the socket is closed, and the response
 * is destroyed as soon as its status arrives, so no body is ever read.
 */

export const DEADLINE_PASSED = Symbol("deadline passed");

/** `work`'s result, or DEADLINE_PASSED once the deadline (an epoch millisecond) passes first. */
export function beforeDeadline<T>(work: Promise<T>, deadline: number): Promise<T | typeof DEADLINE_PASSED> {
  let timer: NodeJS.Timeout | undefined;
  const expiry = new Promise<typeof DEADLINE_PASSED>((resolve) => {
    timer = setTimeout(() => resolve(DEADLINE_PASSED), Math.max(0, deadline - Date.now()));
  });
  return Promise.race([work, expiry]).finally(() => clearTimeout(timer));
}

export type PinnedPostOutcome = { status: number; } | { error: "timeout" | "unreachable"; };

/**
 * POST `body` to `target`, connected only to `addresses` (checked by the
 * caller and pinned, so DNS can't switch them in between), with TLS checked
 * against the host name and no redirects followed.
 */
export function postPinnedJson(target: URL, addresses: ResolvedAddress[], body: Buffer, deadline: number): Promise<PinnedPostOutcome> {
  const hostname = target.hostname.replace(/^\[|\]$/g, "");
  const isHttps = target.protocol === "https:";
  return new Promise<PinnedPostOutcome>((resolve) => {
    let settled = false;
    const settle = (outcome: PinnedPostOutcome) => {
      if (settled) return;
      settled = true;
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
      response.on("error", () => {});
      settle({ status: response.statusCode ?? 0 });
      response.destroy();
      request.destroy();
    });
    const timer = setTimeout(() => {
      settle({ error: "timeout" });
      request.destroy();
    }, Math.max(0, deadline - Date.now()));
    request.on("close", () => clearTimeout(timer));
    request.on("error", () => settle({ error: "unreachable" }));
    request.end(body);
  });
}
