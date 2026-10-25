import { Avatar, Chip } from "@/components/ui/display";

export function PersonSummary({ name, headline, skills }: { name: string; headline: string | null; skills: string[] }) {
  return (
    <div className="flex min-w-0 flex-1 items-start gap-3">
      <Avatar name={name} size="sm" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-label text-ink">{name}</p>
        {headline ? <p className="break-words text-sm text-ink-secondary">{headline}</p> : null}
        {skills.length ? (
          <ul className="mt-1.5 flex flex-wrap gap-1.5" aria-label="Skills">
            {skills.map((skill) => (
              <li key={skill}><Chip tone="outline" size="sm">{skill}</Chip></li>
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  );
}
