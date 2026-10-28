import { Medal, Users } from "lucide-react";
import { ProjectLinks } from "@/components/event/ProjectLinks";
import { Chip } from "@/components/ui/display";
import type { PublicFinalistsDto } from "@/lib/core/judgingRounds";

/**
 * Published finalists on the public results page, one block per judging
 * round (docs/HACKATHON.md "Rounds"): project titles, entrant display names
 * and links, alphabetical. Never scores or ranks.
 */
export function PublicFinalists({ rounds }: { rounds: PublicFinalistsDto[] }) {
  if (rounds.length === 0) return null;
  return (
    <div className="flex flex-col gap-10">
      {rounds.map((round, roundIndex) => {
        const headingId = `finalists-${roundIndex}`;
        return (
          <section key={headingId} aria-labelledby={headingId} className="flex flex-col gap-4">
            <div className="flex items-start gap-3">
              <span aria-hidden className="mt-1 flex size-10 shrink-0 items-center justify-center rounded-md bg-muted text-ink-secondary">
                <Medal className="size-5" />
              </span>
              <div className="min-w-0">
                <h2 id={headingId} className="break-words text-h2 text-ink">
                  Finalists: {round.roundName}
                </h2>
                <p className="mt-1 text-body text-ink-secondary">
                  {round.finalists.length} {round.finalists.length === 1 ? "project goes" : "projects go"} through to {round.roundName}.
                </p>
              </div>
            </div>
            <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {round.finalists.map((finalist, index) => (
                <li key={`${finalist.title}-${index}`} className="flex flex-col gap-2 rounded-lg border border-line bg-canvas p-4">
                  {finalist.isTeam ? (
                    <div className="flex flex-wrap items-center gap-2">
                      <Chip size="sm" tone="outline" icon={<Users aria-hidden className="size-3.5" />}>
                        Team
                      </Chip>
                    </div>
                  ) : null}
                  <p className="break-words text-[17px] font-bold leading-snug text-ink">{finalist.title}</p>
                  <p className="break-words text-sm text-ink-secondary">{finalist.entrantName}</p>
                  <ProjectLinks links={finalist} projectTitle={finalist.title} />
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
