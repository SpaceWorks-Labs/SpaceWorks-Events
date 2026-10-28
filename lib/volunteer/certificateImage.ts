import "server-only";

import sharp from "sharp";
import { parseCertificateTemplate } from "@/lib/certificateTemplate";
import { certificateMergeValues, fittedFontSize, renderCustomCertificate } from "@/lib/renderCertificate";
import { formatHours } from "./math";
import type { loadContributorCertificate } from "./certificates";

const escapeMarkup = (s: string) => s.replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c]!);

/** The built-in contributor certificate, used when no design was saved at issue. 1600 × 1130 px. */
export function standardContributorCertificateSvg(input: { organisationName: string; name: string; role: string; hours: string | null; eventTitle: string; issuedAt: Date }) {
  const line = 1380;
  const organisation = fittedFontSize(input.organisationName, 42, line, 0.6);
  const name = fittedFontSize(input.name, 80, line, 0.62);
  const title = fittedFontSize(input.eventTitle, 58, line, 0.62);
  const role = fittedFontSize(input.role, 36, line, 0.6);
  const issued = input.issuedAt.toLocaleDateString("en-GB", { year: "numeric", month: "long", day: "numeric" });
  const contribution = input.hours ? `for ${input.hours} of work on` : "for their contribution to";
  return `<?xml version="1.0" encoding="UTF-8"?><svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1130" viewBox="0 0 1600 1130"><rect width="1600" height="1130" fill="#fff"/><rect x="35" y="35" width="1530" height="1060" rx="20" fill="none" stroke="#1d3557" stroke-width="8"/><text x="800" y="165" text-anchor="middle" font-family="'DejaVu Serif',serif" font-size="${organisation}" fill="#1d3557">${escapeMarkup(input.organisationName)}</text><text x="800" y="315" text-anchor="middle" font-family="'DejaVu Serif',serif" font-size="68" font-weight="700" fill="#111827">CERTIFICATE OF CONTRIBUTION</text><text x="800" y="425" text-anchor="middle" font-family="'DejaVu Sans',sans-serif" font-size="35" fill="#4b5563">With thanks to</text><text x="800" y="545" text-anchor="middle" font-family="'DejaVu Serif',serif" font-size="${name}" font-weight="700" fill="#111827">${escapeMarkup(input.name)}</text><text x="800" y="615" text-anchor="middle" font-family="'DejaVu Sans',sans-serif" font-size="${role}" fill="#1d3557">${escapeMarkup(input.role)}</text><line x1="360" y1="650" x2="1240" y2="650" stroke="#94a3b8" stroke-width="3"/><text x="800" y="735" text-anchor="middle" font-family="'DejaVu Sans',sans-serif" font-size="35" fill="#4b5563">${escapeMarkup(contribution)}</text><text x="800" y="825" text-anchor="middle" font-family="'DejaVu Serif',serif" font-size="${title}" font-weight="700" fill="#1d3557">${escapeMarkup(input.eventTitle)}</text><text x="800" y="955" text-anchor="middle" font-family="'DejaVu Sans',sans-serif" font-size="28" fill="#64748b">Issued ${issued}</text></svg>`;
}

/** Renders a live certificate as JPEG: its saved design, or the standard one. */
export async function renderContributorCertificate(certificate: NonNullable<Awaited<ReturnType<typeof loadContributorCertificate>>>) {
  const { crewMember } = certificate;
  const event = crewMember.event;
  const hours = certificate.minutes > 0 ? formatHours(certificate.minutes) : null;
  const template = parseCertificateTemplate(certificate.template);
  if (template) {
    const values = certificateMergeValues({ name: crewMember.name, eventTitle: event.title, eventStart: event.startDateTime, timeZone: event.timezone, organisationName: event.organisation.name, issuedAt: certificate.issuedAt, role: certificate.role, hours: hours ?? "" });
    return renderCustomCertificate(template, values, event.organisationId);
  }
  const svg = standardContributorCertificateSvg({ organisationName: event.organisation.name, name: crewMember.name, role: certificate.role, hours, eventTitle: event.title, issuedAt: certificate.issuedAt });
  return sharp(Buffer.from(svg)).flatten({ background: "#ffffff" }).jpeg({ quality: 94, chromaSubsampling: "4:4:4" }).toBuffer();
}
