import { ExpenseCategory, ExpenseClaimKind, ExpenseClaimStatus, OfflinePaymentMethod, type Event } from "@prisma/client";
import { CURRENCY, DAY, inr, type Db } from "./common";
import type { People } from "./people";

/** Expense claims in every state on the conference, one paid back, and a participant's travel claim. */
export async function seedFinance(prisma: Db, people: People, summit: Event, claimRsvpId: string, now: number) {
  const { org, owner, admin, member, member2, coOrganiser } = people;
  const base = { organisationId: org.id, eventId: summit.id, eventTitle: summit.title, kind: ExpenseClaimKind.STAFF, currency: CURRENCY };
  const claims = [
    { by: admin, payee: "Ben Okafor", category: ExpenseCategory.VENUE, description: "Venue deposit for the Corn Exchange", amount: 15000, status: ExpenseClaimStatus.PAID, daysAgo: 20 },
    { by: member, payee: "Chloe Martin", category: ExpenseCategory.PRINTING, description: "Printed signs and name badges", amount: 2400, status: ExpenseClaimStatus.APPROVED, daysAgo: 6 },
    { by: coOrganiser, payee: "Imogen Clarke", category: ExpenseCategory.TRAVEL, description: "Train fare for our keynote speaker", amount: 3800, status: ExpenseClaimStatus.SUBMITTED, daysAgo: 2 },
    { by: member2, payee: "Dev Raman", category: ExpenseCategory.FOOD, description: "Snacks for the volunteers' briefing", amount: 1200, status: ExpenseClaimStatus.REJECTED, daysAgo: 4, note: "The sponsor is covering volunteer food." },
  ];
  for (const claim of claims) {
    const decided = claim.status !== ExpenseClaimStatus.SUBMITTED;
    const created = await prisma.expenseClaim.create({
      data: {
        ...base, status: claim.status, submittedByUserId: claim.by.id, payeeName: claim.payee, payeeEmail: claim.by.email!, category: claim.category,
        description: claim.description, amountMinor: inr(claim.amount),
        approvedMinor: claim.status === ExpenseClaimStatus.APPROVED || claim.status === ExpenseClaimStatus.PAID ? inr(claim.amount) : null,
        decisionNote: claim.note ?? "", decidedByUserId: decided ? owner.id : null, decidedAt: decided ? new Date(now - (claim.daysAgo - 1) * DAY) : null,
        createdAt: new Date(now - claim.daysAgo * DAY),
      },
    });
    if (claim.status === ExpenseClaimStatus.PAID) {
      await prisma.claimPayout.create({
        data: {
          organisationId: org.id, eventId: summit.id, claimId: created.id, payeeName: claim.payee, amountMinor: inr(claim.amount), currency: CURRENCY,
          method: OfflinePaymentMethod.BANK_TRANSFER, reference: "NEFT 4471", paidAt: new Date(now - 18 * DAY), recordedByUserId: owner.id,
        },
      });
    }
  }
  // A participant's travel claim, still waiting, from their ticket page.
  await prisma.expenseClaim.create({
    data: {
      ...base, kind: ExpenseClaimKind.PARTICIPANT, rsvpId: claimRsvpId, payeeName: "Meera Pillai", payeeEmail: "meera.pillai@example.org",
      category: ExpenseCategory.TRAVEL, description: "Bus from Northside and back", amountMinor: inr(450), createdAt: new Date(now - DAY),
    },
  });
}
