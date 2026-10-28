/** How a payment was made, for receipts: a type ("card", "upi"…) and a short summary. */
export type PaymentMethodDetails = { type: string; summary: string; };

const LABELS: Record<string, string> = {
  card: "Card", upi: "UPI", netbanking: "Net banking", wallet: "Wallet", emi: "EMI", cardless_emi: "Cardless EMI",
  paylater: "Pay later", bank_transfer: "Bank transfer", link: "Link", us_bank_account: "Bank account", sepa_debit: "SEPA Direct Debit",
};

/** Printable text only, trimmed to fit a receipt line. */
function clean(value: unknown, max = 40) {
  return typeof value === "string" ? value.replace(/[^\p{L}\p{N} @._&'-]/gu, "").trim().slice(0, max) : "";
}

function titleCase(value: string) {
  return value.replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

/**
 * One summary for both providers: "Visa •••• 4242", "UPI ••••@okicici",
 * "Net banking · HDFC". A UPI id keeps only its bank handle; card numbers are
 * never more than the last four digits the provider reports.
 */
export function describePaymentMethod(raw: { type: unknown; brand?: unknown; last4?: unknown; vpa?: unknown; bank?: unknown; wallet?: unknown; }): PaymentMethodDetails | null {
  const type = typeof raw.type === "string" && /^[a-z_]{1,32}$/.test(raw.type) ? raw.type : null;
  if (!type) return null;
  const label = LABELS[type] ?? titleCase(type);
  const last4 = typeof raw.last4 === "string" && /^\d{4}$/.test(raw.last4) ? raw.last4 : null;
  const brand = clean(raw.brand, 24);
  if ((type === "card" || type === "emi") && last4) return { type, summary: `${brand ? titleCase(brand.toLowerCase()) : label} •••• ${last4}${type === "emi" ? " (EMI)" : ""}` };
  const handle = clean(raw.vpa, 80).split("@")[1];
  if (type === "upi") return { type, summary: handle ? `UPI ••••@${handle}` : "UPI" };
  const detail = clean(raw.bank) || clean(raw.wallet);
  return { type, summary: detail ? `${label} · ${detail}` : label };
}

/** Money handed over in person or by transfer (offline payments, payouts). */
export const OFFLINE_METHOD_LABELS: Record<string, string> = { CASH: "Cash", UPI: "UPI", BANK_TRANSFER: "Bank transfer", CARD_TERMINAL: "Card terminal", OTHER: "Other" };

export function offlineMethodLabel(method: string) {
  return OFFLINE_METHOD_LABELS[method] ?? "Other";
}
