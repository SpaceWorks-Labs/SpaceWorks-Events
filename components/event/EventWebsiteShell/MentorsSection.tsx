import { Avatar } from "@/components/ui/display";

/**
 * The event page's Mentors section (docs/MENTOR_DESK.md): only mentors who
 * chose to be listed, with their name, bio and skills. Never an affiliation,
 * email or anything from the help queue.
 */
export function MentorsSection({ mentors }: { mentors: Array<{ id: string; name: string; bio: string; skills: string[] }> }) {
  return (
    <section id="mentors" aria-labelledby="mentors-title" className="scroll-mt-6">
      <h2 id="mentors-title" className="mb-4 text-h2 text-ink">Mentors</h2>
      <ul className="grid gap-3 sm:grid-cols-2">
        {mentors.map((mentor) => (
          <li key={mentor.id} className="flex items-start gap-3 rounded-lg border border-line bg-panel p-3.5">
            <Avatar name={mentor.name} />
            <div className="min-w-0">
              <p className="text-[15px] font-semibold text-ink">{mentor.name}</p>
              {mentor.skills.length ? <p className="text-sm text-ink-muted">{mentor.skills.join(" · ")}</p> : null}
              {mentor.bio ? <p className="mt-1 text-sm text-ink-secondary">{mentor.bio}</p> : null}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
