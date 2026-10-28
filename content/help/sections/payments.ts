import type { HelpSectionEntry } from "../manifest";

export const payments = {
  id: "payments",
  title: "Paid events",
  description: "Sell tickets through your organisation's own Razorpay or Stripe account, with codes, passes, refunds and revenue reports.",
  access: "public",
  articles: [
    { slug: "payments/enable-paid-events", title: "Turning on paid events", summary: "How paid events are switched on for a server and what your organisation needs first." },
    { slug: "payments/connect-a-provider", title: "Connecting Razorpay or Stripe", summary: "Connect your organisation's own payment account, test it, and go live." },
    { slug: "payments/ticket-types", title: "Ticket types, group tickets and add-ons", summary: "Prices, sale windows, limits, tickets for groups, and extras guests can buy." },
    { slug: "payments/promo-and-access-codes", title: "Promo and access codes", summary: "Discounts, and codes that unlock hidden tickets." },
    { slug: "payments/passes", title: "Passes", summary: "Sell one purchase that covers several events or dates." },
    { slug: "payments/paid-team-places", title: "Paid team places", summary: "Charge for team and solo places when people register in teams." },
    { slug: "payments/orders-and-receipts", title: "Orders and receipts", summary: "Find an order, see what was paid and refunded, and download the orders list." },
    { slug: "payments/refunds", title: "Refunds and cancellations", summary: "Refund an order in full or in part, and refund everyone when you cancel an event." },
    { slug: "payments/revenue", title: "Revenue and reports", summary: "Sales, fees and refunds for an event and across your organisation." },
  ],
} as const satisfies HelpSectionEntry;
