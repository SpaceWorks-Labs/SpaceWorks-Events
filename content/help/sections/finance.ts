import type { HelpSectionEntry } from "../manifest";

export const finance = {
  id: "finance",
  title: "Event finance",
  description: "Track an event's money: the budget, expense claims and refund requests.",
  access: "public",
  articles: [
    { slug: "finance/overview-and-budget", title: "The Finance tab and budget", summary: "What came in, what went out, the event budget and the money export." },
    { slug: "finance/expense-claims", title: "Expense claims and reimbursements", summary: "File, approve and pay back claims from staff, speakers, volunteers and participants." },
    { slug: "finance/refund-requests", title: "Refund requests", summary: "Decide the refunds guests ask for from their order page." },
  ],
} as const satisfies HelpSectionEntry;
