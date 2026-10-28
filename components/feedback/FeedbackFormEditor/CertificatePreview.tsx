"use client";

import { cn } from "@/lib/cn";
import { certificateMergeTags, fillCertificateText, type CertificateMergeValues, type CertificateTemplate } from "@/lib/certificateTemplate";

/** Small, decorative preview of the certificate: uploaded artwork with every layer outlined, or the standard layout. */
export function CertificatePreview({ template, eventTitle, eventDateLabel, organisationName, muted }: { template: CertificateTemplate | null; eventTitle?: string; eventDateLabel?: string; organisationName?: string; muted: boolean }) {
  const values: CertificateMergeValues = {
    name: certificateMergeTags.name.sample,
    event: eventTitle || certificateMergeTags.event.sample,
    eventDate: eventDateLabel || certificateMergeTags.eventDate.sample,
    organisation: organisationName || certificateMergeTags.organisation.sample,
    issueDate: certificateMergeTags.issueDate.sample,
    role: "",
    hours: "",
  };
  return (
    <div aria-hidden className={cn("overflow-hidden rounded-xl border border-line bg-panel transition-opacity", muted && "opacity-50")}>
      {template ? (
        <div className="relative">
          {/* eslint-disable-next-line @next/next/no-img-element -- served by the app's private upload route */}
          <img src={`/api/uploads/${template.backgroundKey}`} alt="" className="block h-auto w-full" />
          {template.elements.map((element) => (
            <span
              key={element.id}
              className="absolute flex items-center justify-center overflow-hidden rounded-[3px] border border-dashed border-accent"
              style={{ left: `${element.x}%`, top: `${element.y}%`, width: `${element.width}%`, height: `${element.height}%` }}
            >
              {element.type === "text" ? (
                <span className="truncate px-0.5 text-[10px] font-bold leading-tight text-ink" style={{ color: element.color }}>
                  {fillCertificateText(element.text, values).replace(/\s+/g, " ")}
                </span>
              ) : (
                // eslint-disable-next-line @next/next/no-img-element -- served by the app's private upload route
                <img src={`/api/uploads/${element.key}`} alt="" className="size-full object-contain" />
              )}
            </span>
          ))}
        </div>
      ) : (
        <div className="flex aspect-[1.414] flex-col items-center justify-center gap-1.5 p-4 text-center">
          <span className="text-[10px] font-bold tracking-[0.12em] text-ink-muted">CERTIFICATE OF ATTENDANCE</span>
          <span className="rounded-lg border-[1.5px] border-dashed border-accent px-3 py-1 font-display text-lg font-semibold text-ink">Attendee name</span>
          {eventTitle ? <span className="line-clamp-2 text-xs text-ink-secondary">{eventTitle}{eventDateLabel ? ` · ${eventDateLabel}` : ""}</span> : null}
        </div>
      )}
    </div>
  );
}
