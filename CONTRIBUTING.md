# Contributing to Space Works Events

Thanks for helping make free maker and community events easier to run. Space Works
Events is built in the open at
[github.com/SpaceWorks-Labs/SpaceWorks-Events](https://github.com/SpaceWorks-Labs/SpaceWorks-Events).

## Ways to help

- **Report a bug.** [Open an issue](https://github.com/SpaceWorks-Labs/SpaceWorks-Events/issues/new)
  with what you expected, what happened, and the steps to repeat it. Include your
  browser or device and, for self-hosted installs, the version you run.
- **Suggest an idea.** Start a thread in
  [Discussions](https://github.com/SpaceWorks-Labs/SpaceWorks-Events/discussions). Describe the
  problem your community has before the solution you have in mind.
- **Send a pull request.** For anything larger than a small fix, open an issue or
  discussion first so we can agree on the approach.

## Security issues

Please **don't** report vulnerabilities in a public issue. Use GitHub's private
vulnerability reporting on the repository (Security → Report a vulnerability) and
allow time for a fix before disclosing. The security model is described in
[docs/SECURITY.md](docs/SECURITY.md).

## Local setup

See [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md). In short:

```bash
npm install
docker compose up -d
cp .env.example .env
npm run db:migrate
npm run dev
```

Never commit `.env` or real secrets.

## Before opening a pull request

1. Read [AGENTS.md](AGENTS.md). It covers the Next.js 16 rules, product boundaries
   and the security model every change must keep.
2. Keep each change focused, and match the surrounding code's style. Keep source
   files (TypeScript, TSX and MJS, tests included) at or under 300 lines, not
   counting blank lines and comments; ESLint fails past that. Split a long module
   into focused parts behind its original import path.
3. Run at least:

   ```bash
   npm run lint
   npx tsc --noEmit
   npm run test:unit
   ```

   Changes to authorization, mutations, public routes, the API or deployment need
   the stronger checks in [docs/TESTING.md](docs/TESTING.md).
4. UI changes follow [docs/DESIGN.md](docs/DESIGN.md) and the Space Works brand:
   sentence case, clear and warm copy, teal for actions, and no "Oops" or
   "Something went wrong". Check light and dark mode and a 360px-wide screen.
   Don't restyle organiser logos, covers or colours with the Space Works brand.
5. Database changes need a reviewed Prisma migration.
6. Describe what changed and how you tested it in the pull request.

## Branches and merging

- `main` is the production branch; Render deploys it. Only the maintainer,
  [@Shaan-Shoukath](https://github.com/Shaan-Shoukath), can merge or push to
  `main`. Branch protection enforces this (organisation admins included), and
  force pushes and branch deletion are blocked.
- `dev` is the integration branch. Branch from `dev` (`feat/<short-name>` or
  `fix/<short-name>`) and open your pull request against `dev`. Changes reach
  `main` through a pull request from `dev` that the maintainer reviews and merges.

## Syncing from Yuyu

Space Works Events is derived from [Yuyu](https://github.com/twilighty-abhi/yuyu)
and shares its Git history. Every Monday the **Yuyu upstream check** workflow
fetches Yuyu's branches. If any of them has commits that `dev` has not ported
or reviewed, it opens or updates the issue "Yuyu upstream has commits to review"
with the list (each commit once), and closes the issue once nothing is left. To
port them:

1. Branch from `dev` as `fix/yuyu-sync-<date>` and add the remote:
   `git remote add upstream https://github.com/twilighty-abhi/yuyu.git && git fetch upstream`.
2. Port security and bug fixes first, with `git cherry-pick -x <commit>`. Rework
   UI and copy changes into the Space Works design ([docs/DESIGN.md](docs/DESIGN.md)).
3. Never take Yuyu branding, analytics or product-boundary changes as they are.
   Open the pull request against `dev` as usual.
4. Name each ported commit in its message, as `(cherry picked from Yuyu <hash>)`
   (several hashes may follow, joined by "and"). `git cherry-pick -x` writes
   `(cherry picked from commit <hash>)`, which counts too. The check skips every
   Yuyu commit named this way once it is in `dev`, so keep those lines when
   squashing.
5. A commit you review and decide not to port (already covered, Yuyu-only, or
   deferred) goes in [`.github/yuyu-reviewed.txt`](.github/yuyu-reviewed.txt)
   with its reason, so it stops being listed.

Yuyu does a lot of its newest work on branches other than `main` (such as
`v1-design-overhaul`), so the check looks at every branch.

## Licence

By contributing, you agree that your contributions are licensed under the
[GNU AGPL-3.0-or-later](LICENSE), the same licence as the project.

## Product boundaries

Events are free by default. Paid tickets go straight to the organiser's own
Razorpay or Stripe account (see `docs/PAYMENTS.md`); the platform never holds
ticket money or takes a cut. Contributions that add ads, third-party trackers
or a platform cut of ticket money won't be accepted.
