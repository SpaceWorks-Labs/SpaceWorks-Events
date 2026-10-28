import crypto from "node:crypto";
import sharp from "sharp";
import type { PrismaClient } from "@prisma/client";

/*
 * Shared constants and helpers for the guide's screenshot seed. Everything is
 * fictional and uses example.org addresses.
 */

export const ORG_SLUG = "riverside-tech";
export const OTHER_ORG_SLUG = "northside-makers";
/** A throwaway password for the demo accounts of a disposable database. */
export const PASSWORD = "help-screens-demo-password";
export const SUPER_ADMIN_EMAIL = "root@example.org";

export const EMAILS = {
  owner: "ada@example.org",
  admin: "ben@example.org",
  member: "chloe@example.org",
  member2: "dev@example.org",
  coOrganiser: "femi@example.org",
  judge: "grace@example.org",
  judge2: "hiro@example.org",
  otherOwner: "nia@example.org",
  buyer: "olu.adebayo@example.org",
  superAdmin: SUPER_ADMIN_EMAIL,
} as const;

export const DAY = 24 * 60 * 60 * 1000;
export const HOUR = 60 * 60 * 1000;
export const MINUTE = 60 * 1000;
export const TIMEZONE = "Europe/London";
export const CURRENCY = "INR";

export type Db = PrismaClient;

export const sha256 = (value: string) => crypto.createHash("sha256").update(value).digest("hex");
export const token = () => crypto.randomBytes(24).toString("base64url");
export const guestKey = (email: string) => `guest:${email.toLowerCase()}`;
export const inr = (rupees: number) => BigInt(Math.round(rupees * 100));
export const emailFor = (name: string) => `${name.toLowerCase().normalize("NFD").replace(/[^a-z ]/g, "").trim().replace(/\s+/g, ".")}@example.org`;
export const slugify = (value: string) => value.toLowerCase().normalize("NFD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/** A start time `days` from now at a fixed UTC hour, so screenshots stay stable within a day. */
export function daysFromNow(now: number, days: number, hourUtc: number, minute = 0) {
  const date = new Date(now + days * DAY);
  date.setUTCHours(hourUtc, minute, 0, 0);
  return date;
}

/** Renders an SVG to the WebP derivative format the app stores. */
async function webp(svg: string, width: number, height: number) {
  return sharp(Buffer.from(svg)).resize(width, height).webp({ quality: 85 }).toBuffer();
}

export const assetUrl = (key: string) => `/api/uploads/${key}`;

/** Stores an image in the database storage provider (the local fallback) and returns its key. */
export async function storeImage(prisma: Db, owner: { organisationId?: string; userId?: string }, folder: string, svg: string, width: number, height: number) {
  const prefix = owner.organisationId ? `organisations/${owner.organisationId}` : `users/${owner.userId}`;
  const key = `${prefix}/${folder}/${crypto.randomUUID()}.webp`;
  const data = await webp(svg, width, height);
  await prisma.asset.create({
    data: { key, organisationId: owner.organisationId ?? null, contentType: "image/webp", byteSize: BigInt(data.length), provider: "database", fileData: new Uint8Array(data) },
  });
  return key;
}

const FONT = "Helvetica, Arial, sans-serif";

export function avatarSvg(initials: string, colour: string) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="${colour}"/><text x="128" y="160" font-family="${FONT}" font-size="96" font-weight="700" fill="#ffffff" text-anchor="middle">${initials}</text></svg>`;
}

export function logoSvg(colour: string, letter: string) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" rx="56" fill="${colour}"/><path d="M40 170 Q88 130 128 170 T216 170" stroke="#ffffff" stroke-width="16" fill="none" stroke-linecap="round"/><text x="128" y="118" font-family="${FONT}" font-size="88" font-weight="800" fill="#ffffff" text-anchor="middle">${letter}</text></svg>`;
}

export function sponsorSvg(name: string, colour: string) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="240"><rect width="480" height="240" fill="#ffffff"/><circle cx="96" cy="120" r="48" fill="${colour}"/><text x="168" y="138" font-family="${FONT}" font-size="52" font-weight="700" fill="#1f2937">${name}</text></svg>`;
}

export function coverSvg(from: string, to: string) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/></linearGradient></defs><rect width="1600" height="900" fill="url(#g)"/><circle cx="1200" cy="260" r="140" fill="#ffffff" opacity="0.25"/><path d="M0 700 Q400 560 800 700 T1600 680 V900 H0Z" fill="#000000" opacity="0.18"/></svg>`;
}

export function certificateSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1131" viewBox="0 0 1600 1131">
  <rect width="1600" height="1131" fill="#fbf8f1"/>
  <rect x="40" y="40" width="1520" height="1051" fill="none" stroke="#0f766e" stroke-width="14"/>
  <rect x="72" y="72" width="1456" height="987" fill="none" stroke="#d4a72c" stroke-width="4"/>
  <circle cx="800" cy="930" r="62" fill="#d4a72c"/>
  <circle cx="800" cy="930" r="46" fill="none" stroke="#fbf8f1" stroke-width="4"/>
  <path d="M120 140 L260 140 M1340 140 L1480 140 M120 990 L260 990 M1340 990 L1480 990" stroke="#0f766e" stroke-width="6"/>
</svg>`;
}
