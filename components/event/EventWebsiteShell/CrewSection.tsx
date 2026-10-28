import { Avatar } from "@/components/ui/display";
import type { Props } from "./types";

/** LinkedIn's mark (lucide ships no brand icons). Decorative: the link carries the label. */
function LinkedInMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden focusable="false" className={className} fill="currentColor">
      <path d="M20.45 20.45h-3.56v-5.57c0-1.33-.02-3.04-1.85-3.04-1.85 0-2.14 1.45-2.14 2.94v5.67H9.34V9h3.42v1.56h.05c.48-.9 1.64-1.85 3.37-1.85 3.6 0 4.27 2.37 4.27 5.46v6.28ZM5.34 7.43a2.06 2.06 0 1 1 0-4.13 2.06 2.06 0 0 1 0 4.13ZM7.12 20.45H3.56V9h3.56v11.45ZM22.22 0H1.77C.79 0 0 .77 0 1.73v20.54C0 23.23.79 24 1.77 24h20.45c.98 0 1.78-.77 1.78-1.73V1.73C24 .77 23.2 0 22.22 0Z" />
    </svg>
  );
}

/** The public Crew section (docs/CREW.md): name, role, bio, photo and LinkedIn only. */
export function CrewSection({ crew, eventTitle }: { crew: NonNullable<Props["crew"]>; eventTitle: string }) {
  return (
    <section id="crew" aria-labelledby="crew-title" className="scroll-mt-6">
      <h2 id="crew-title" className="text-h2 text-ink">Crew</h2>
      <p className="mb-4 mt-1 text-body text-ink-secondary">The people running {eventTitle}</p>
      <ul className="grid gap-3 sm:grid-cols-2">
        {crew.map((member) => (
          <li key={member.id} className="flex items-start gap-3 rounded-lg border border-line bg-canvas p-3.5">
            <Avatar name={member.name} src={member.photoUrl} size="lg" tone="accent" />
            <div className="min-w-0 flex-1">
              <div className="flex items-start justify-between gap-2">
                <p className="min-w-0 break-words text-[15px] font-bold text-ink">{member.name}</p>
                {member.linkedinUrl ? (
                  <a
                    href={member.linkedinUrl}
                    target="_blank"
                    rel="noopener noreferrer nofollow ugc"
                    aria-label={`${member.name} on LinkedIn`}
                    className="-m-1.5 inline-flex size-8 shrink-0 items-center justify-center rounded-md text-ink-muted transition-colors hover:bg-subtle hover:text-ink"
                  >
                    <LinkedInMark className="size-4" />
                  </a>
                ) : null}
              </div>
              {member.role ? <p className="text-sm text-ink-muted">{member.role}</p> : null}
              {member.bio ? <p className="mt-1.5 line-clamp-3 whitespace-pre-line text-sm text-ink-secondary">{member.bio}</p> : null}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
