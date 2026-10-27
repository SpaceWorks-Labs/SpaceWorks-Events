# Large-event performance

[Documentation index](README.md)

What keeps the team, judging, guest and export screens fast on a large
hackathon (thousands of teams and registrations, tens of thousands of judge
scores), and what to keep in mind when changing these read paths. The work
was ported from Yuyu (`5a3830bb`), which measured it on a seeded event with
5,000 teams, 15,000 registrations, 4,000 submissions and 114,000 scores.

## Indexes

Migration `20261108000000_large_event_indexes` adds six composite indexes,
so the keyset-paged lists read one page in index order instead of sorting
every row of the event:

| Index | Serves |
| --- | --- |
| `RSVP (eventId, createdAt, id)` | Guests · People newest first and its deep pages |
| `RSVP (eventId, checkedInAt, id)` | Check-in desk and station "Recent check-ins" |
| `Team (eventId, createdAt, id)` | Guests · Teams and the Teams CSV batches |
| `Submission (eventId, createdAt, id)` | Judging → Submissions and its CSV batches |
| `Submission (eventId, status, submittedAt, id)` | The judge workspace, the gallery's newest order and the ranking's input order |
| `EventInvite (eventId, createdAt, id)` | Guests · Invites |

The migration is `CREATE INDEX IF NOT EXISTS` only. Prisma runs migrations in
a transaction, so these cannot be `CONCURRENTLY`; each takes a `SHARE` lock
on its table (reads continue, writes wait) while it builds. On a very large
instance an operator can create the same indexes beforehand with
`CREATE INDEX CONCURRENTLY` and the same names, and the migration is then a
no-op. `npm run db:verify` checks they exist.

## Read paths

- **Judging.** Results, Progress and auto-assignment read judges' work
  through `judgeWorkOnSubmitted` (`lib/core/judging/judgeWork.ts`): one row
  per (judge, SUBMITTED project) with the scores aggregated in SQL, instead
  of every score row of the event. Conflicts of interest are found from each
  judge's own registrations (`conflictedPairs`), not by testing every judge
  against every project. `computeJudgingResultsFromReviews`
  (`lib/judgingScore.ts`) ranks from those rows with the same arithmetic in
  the same order. The judging CSV reads scores and reviews per batch through
  their own `submissionId`.
- **Offline check-in roster.** Two set-based reads (registrations with
  their user and team joined in SQL, then every answer of those
  registrations) instead of a relation lookup per registration.
- **Gallery search.** Team and entrant names are scalar sub-selects by
  primary key, so a public search grows with the event, not the instance.
- **CSV exports.** Every export streams through `csvByteStream`
  (`lib/csvExport.ts`): the next batch is read only once the download has
  taken the previous one, so a slow download holds about one batch in
  memory, and a cancelled download stops the reads. This covers People,
  attendee emails, Teams, Judging, Feedback, orders (event and series) and
  Finance.

## Keeping it equivalent

`tests/integration/judging-results-equivalence.db.test.ts` keeps the
previous implementation (every score and review row loaded and ranked in
memory) as the reference and checks that the ranking under both score
methods, the counted reviews, the Progress outliers and stale lists, and the
judging CSV are identical on seeded data with revoked judges, a conflict of
interest, draft reviews, partial and out-of-range scores and ties. Change the
judging read paths only with this test passing.

Yuyu's load-test harness (`tests/perf/`, a seeded large event plus query
and export timing) was not ported; its seed would need the paid-event,
finance and team-payment data `dev` has.
