/** What a chat channel can be told about. Kept in step with the ChatChannel_shape check. */
export const CHAT_EVENTS = ["registration", "request", "payment", "refund", "cancellation", "dispute", "event", "payout"] as const;
export type ChatEvent = (typeof CHAT_EVENTS)[number];

export const CHAT_EVENT_LABELS: Record<ChatEvent, { label: string; description: string; }> = {
  registration: { label: "New registrations", description: "Someone registers, joins a waitlist or is given a place." },
  request: { label: "Join requests", description: "Someone asks to join an approval-only event." },
  payment: { label: "Payments", description: "An order is paid for, online or at the desk." },
  refund: { label: "Refunds", description: "A refund is sent, or the provider refuses one." },
  cancellation: { label: "Guest cancellations", description: "A guest cancels their own place." },
  dispute: { label: "Chargebacks", description: "A buyer disputes a payment with their bank." },
  event: { label: "Cancelled events", description: "An event, series or date is cancelled." },
  payout: { label: "Payouts", description: "Prize money is paid out, or a payout is reversed." },
};

export function isChatEvent(value: string): value is ChatEvent {
  return (CHAT_EVENTS as readonly string[]).includes(value);
}

export const CHAT_KINDS = ["SLACK", "DISCORD", "MATTERMOST", "TELEGRAM", "WHATSAPP"] as const;
export type ChatKind = (typeof CHAT_KINDS)[number];

export const CHAT_KIND_LABELS: Record<ChatKind, string> = {
  SLACK: "Slack",
  DISCORD: "Discord",
  MATTERMOST: "Mattermost",
  TELEGRAM: "Telegram",
  WHATSAPP: "WhatsApp",
};
