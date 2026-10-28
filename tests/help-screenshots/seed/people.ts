import bcrypt from "bcryptjs";
import { MembershipRole } from "@prisma/client";
import { DAY, EMAILS, ORG_SLUG, OTHER_ORG_SLUG, PASSWORD, assetUrl, avatarSvg, coverSvg, logoSvg, storeImage, type Db } from "./common";

/** Users whose rows the seed owns: the demo staff, plus attendees given by the other seed parts. */
export async function removeExisting(prisma: Db, attendeeEmails: string[]) {
  const emails = [...Object.values(EMAILS), ...attendeeEmails];
  const users = await prisma.user.findMany({ where: { email: { in: emails } }, select: { id: true } });
  const ids = users.map((user) => user.id);
  const orgs = await prisma.organisation.findMany({ where: { slug: { in: [ORG_SLUG, OTHER_ORG_SLUG] } }, select: { id: true, events: { select: { id: true } } } });
  const orgIds = orgs.map((org) => org.id);
  const targetIds = [...ids, ...orgs.flatMap((org) => org.events.map((event) => event.id))];
  // Audit rows outlive their organisation and actors, so remove the demo's own first.
  await prisma.auditEvent.deleteMany({ where: { OR: [{ actorUserId: { in: ids } }, { organisationId: { in: orgIds } }, { targetId: { in: targetIds } }] } });
  // Settings point at library designs; clear the pointer before the cascade.
  await prisma.organisation.updateMany({ where: { id: { in: orgIds } }, data: { defaultTicketDesignId: null } });
  await prisma.organisation.deleteMany({ where: { id: { in: orgIds } } });
  for (const id of ids) await prisma.asset.deleteMany({ where: { key: { startsWith: `users/${id}/` } } });
  if (ids.length) await prisma.user.deleteMany({ where: { id: { in: ids } } });
  // A disposable database: nothing queued may ever be delivered.
  await prisma.outboxMessage.deleteMany({});
}

export async function seedPeople(prisma: Db, now: number) {
  const passwordHash = await bcrypt.hash(PASSWORD, 10);
  const verified = new Date(now - 90 * DAY);
  const user = (email: string, name: string) =>
    prisma.user.create({ data: { email, name, passwordHash, emailVerified: verified, createdAt: new Date(now - 80 * DAY) } });

  const owner = await user(EMAILS.owner, "Ada Lewis");
  const admin = await user(EMAILS.admin, "Ben Okafor");
  const member = await user(EMAILS.member, "Chloe Martin");
  const member2 = await user(EMAILS.member2, "Dev Raman");
  const coOrganiser = await user(EMAILS.coOrganiser, "Femi Adeyemi");
  const judge = await user(EMAILS.judge, "Grace Liu");
  const judge2 = await user(EMAILS.judge2, "Hiro Tanaka");
  const otherOwner = await user(EMAILS.otherOwner, "Nia Roberts");
  const buyer = await user(EMAILS.buyer, "Olu Adebayo");
  // The super-admin signs in with email and password only; its password is set from the server, as here.
  const superAdmin = await user(EMAILS.superAdmin, "Instance Admin");

  const ownerPhoto = await storeImage(prisma, { userId: owner.id }, "profile-images", avatarSvg("AL", "#b45309"), 256, 256);
  await prisma.user.update({ where: { id: owner.id }, data: { profileImageUrl: assetUrl(ownerPhoto) } });

  const org = await prisma.organisation.create({
    data: {
      name: "Riverside Tech Collective",
      slug: ORG_SLUG,
      description: "A volunteer-run community for people who build things with code in Riverside. Monthly meetups, workshops and a yearly hack weekend.",
      createdAt: new Date(now - 120 * DAY),
      memberships: {
        create: [
          { userId: owner.id, role: MembershipRole.OWNER, createdAt: new Date(now - 120 * DAY) },
          { userId: admin.id, role: MembershipRole.ADMIN, createdAt: new Date(now - 100 * DAY) },
          { userId: member.id, role: MembershipRole.MEMBER, createdAt: new Date(now - 60 * DAY) },
          { userId: member2.id, role: MembershipRole.MEMBER, createdAt: new Date(now - 4 * DAY) },
        ],
      },
    },
  });
  const logoKey = await storeImage(prisma, { organisationId: org.id }, "organisation-logos", logoSvg("#0f766e", "R"), 256, 256);
  await prisma.organisation.update({ where: { id: org.id }, data: { logoUrl: assetUrl(logoKey) } });
  // Obviously fake links, since they show (truncated) on the Members page.
  await prisma.organisationInvite.create({
    data: { organisationId: org.id, token: "example-invite-link-admins", role: MembershipRole.ADMIN, createdByUserId: owner.id, createdAt: new Date(now - 3 * DAY), expiresAt: new Date(now + 4 * DAY) },
  });
  await prisma.organisationInvite.create({
    data: { organisationId: org.id, token: "example-invite-link", role: MembershipRole.MEMBER, createdByUserId: owner.id, createdAt: new Date(now - DAY), expiresAt: new Date(now + 6 * DAY) },
  });

  const other = await prisma.organisation.create({
    data: {
      name: "Northside Makers",
      slug: OTHER_ORG_SLUG,
      description: "Hardware tinkerers and makers meeting every month.",
      memberships: { create: [{ userId: otherOwner.id, role: MembershipRole.OWNER }, { userId: owner.id, role: MembershipRole.MEMBER }] },
    },
  });
  const otherLogo = await storeImage(prisma, { organisationId: other.id }, "organisation-logos", logoSvg("#b45309", "N"), 256, 256);
  await prisma.organisation.update({ where: { id: other.id }, data: { logoUrl: assetUrl(otherLogo) } });

  return { owner, admin, member, member2, coOrganiser, judge, judge2, otherOwner, buyer, superAdmin, org, other };
}

export type People = Awaited<ReturnType<typeof seedPeople>>;

/** An event cover image in the app's stored format. */
export async function coverImage(prisma: Db, organisationId: string, from: string, to: string) {
  return assetUrl(await storeImage(prisma, { organisationId }, "event-covers", coverSvg(from, to), 1600, 900));
}
