import "server-only";

import { request } from "node:https";
import type { LookupFunction } from "node:net";
import { resolvePublicAddresses } from "@/lib/net/publicAddress";
import { pinnedLookup } from "@/lib/webhooks/urlSafety";
import type { ChatConfig } from "./config";
import type { ChatKind } from "./events";

const TIMEOUT_MS = 10_000;

export class ChatDeliveryError extends Error {
  override name = "ChatDeliveryError";
  /** A 4xx reply other than rate limiting: retrying won't help. */
  constructor(message: string, readonly permanent: boolean) {
    super(message);
  }
}

function failure(status: number) {
  return new ChatDeliveryError(`The chat service answered ${status}.`, status >= 400 && status < 500 && status !== 408 && status !== 429);
}

/** A fixed, well-known API host: a plain request that never follows redirects. */
async function postJson(url: string, body: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
    redirect: "error",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  await response.body?.cancel();
  if (!response.ok) throw failure(response.status);
}

/**
 * An organisation's own server (Mattermost): connected only by the public
 * addresses its name resolves to, checked first and pinned for the request
 * (the webhooks' lookup, which also answers Node's `all: true` requests), with
 * TLS checked against the name, so DNS can't be switched in between.
 */
async function postJsonToOwnServer(url: string, body: unknown) {
  const target = new URL(url);
  const addresses = await resolvePublicAddresses(target.hostname);
  const payload = Buffer.from(JSON.stringify(body));
  await new Promise<void>((resolve, reject) => {
    const req = request({
      host: target.hostname,
      port: target.port || 443,
      path: `${target.pathname}${target.search}`,
      method: "POST",
      servername: target.hostname,
      lookup: pinnedLookup(addresses) as unknown as LookupFunction,
      headers: { "Content-Type": "application/json", "Content-Length": payload.length },
      timeout: TIMEOUT_MS,
    }, (response) => {
      response.resume();
      const status = response.statusCode ?? 0;
      if (status >= 200 && status < 300) resolve();
      else reject(failure(status));
    });
    req.on("timeout", () => req.destroy(new ChatDeliveryError("The chat service did not answer in time.", false)));
    req.on("error", (error) => reject(error instanceof ChatDeliveryError ? error : new ChatDeliveryError("Couldn't reach the chat service.", false)));
    req.end(payload);
  });
}

/** Post one plain-text message. Throws ChatDeliveryError on failure. */
export async function sendChatMessage<K extends ChatKind>(kind: K, config: ChatConfig[K], text: string) {
  const message = text.slice(0, 1500);
  switch (kind) {
    case "SLACK":
      return postJson((config as ChatConfig["SLACK"]).url, { text: message });
    case "DISCORD":
      // No mentions: a guest's name can't ping the whole server.
      return postJson((config as ChatConfig["DISCORD"]).url, { content: message, allowed_mentions: { parse: [] } });
    case "MATTERMOST":
      return postJsonToOwnServer((config as ChatConfig["MATTERMOST"]).url, { text: message });
    case "TELEGRAM": {
      const telegram = config as ChatConfig["TELEGRAM"];
      return postJson(`https://api.telegram.org/bot${telegram.token}/sendMessage`, { chat_id: telegram.chatId, text: message, disable_web_page_preview: true });
    }
    case "WHATSAPP": {
      const whatsapp = config as ChatConfig["WHATSAPP"];
      const url = `https://graph.facebook.com/v21.0/${whatsapp.phoneNumberId}/messages`;
      for (const to of whatsapp.to) {
        const recipient = to.replace(/^\+/, "");
        // Outside a 24-hour conversation WhatsApp only delivers approved templates.
        const content = whatsapp.template
          ? { type: "template", template: { name: whatsapp.template, language: { code: whatsapp.language ?? "en" }, components: [{ type: "body", parameters: [{ type: "text", text: message.slice(0, 1000) }] }] } }
          : { type: "text", text: { body: message, preview_url: false } };
        await postJson(url, { messaging_product: "whatsapp", to: recipient, ...content }, { Authorization: `Bearer ${whatsapp.token}` });
      }
      return;
    }
  }
}
