# Space Works Events documentation

[Back to the project README](../README.md)

Everything you need to understand, run and change Space Works Events, the free, open-source event platform from Space Works. These pages describe what the product does today, how to operate it, and what's planned. If a page and the code ever disagree, the code and Prisma migrations win, and the page needs fixing.

New here? Start with [Features](FEATURES.md) for what it does, then [Local development](DEVELOPMENT.md) to run it. To host everything on one server, follow [Complete Docker VPS deployment](DEPLOYMENT_VPS.md). To go live on free plans, follow [Free-tier cloud deployment](DEPLOYMENT_CLOUD.md).

## Product and engineering

| Document | Purpose |
| --- | --- |
| [Design system](DESIGN.md) | V1 visual design brief: tokens, the dot-sign brand (§2.3), typography, components, motion, page patterns, dark mode, and voice |
| [Contributing](../CONTRIBUTING.md) | How to report bugs, suggest ideas, and prepare a pull request |
| [Features](FEATURES.md) | Current user-facing and administrative capabilities |
| [Mobile API v1](MOBILE_API.md) | User-authenticated API for the Space Works apps (Android and iOS), with an [OpenAPI 3.1 spec](mobile-api.openapi.yaml) and [fixtures](mobile-api-fixtures/) |
| [Team registration](TEAMS.md) | Design contract for team events: settings, capacity units, team status, join links, the team page, looking for a team, and organiser team actions |
| [Hackathon submissions, judging, and results](HACKATHON.md) | Design contract for hackathon events: project submissions and links, judges and conflicts of interest, the rubric and result score, awards, and published results |
| [Paid tickets](PAYMENTS.md) | Turning paid events on, connecting Razorpay or Stripe, selling, refunds, receipts and reporting |
| [Architecture](ARCHITECTURE.md) | System boundaries, request flows, data model, and background work |
| [Local development](DEVELOPMENT.md) | Installation, database setup, and everyday commands |
| [Configuration](CONFIGURATION.md) | Environment-variable reference for development and production |
| [Routes](ROUTES.md) | Public pages, dashboards, APIs, and protected endpoints |
| [Security](SECURITY.md) | Authentication, authorization, privacy, abuse protection, and known boundaries |
| [Permissions](PERMISSIONS.md) | Event and series dashboard matrix: every control, its server check, and what owners, admins, members and each co-organiser grant see |
| [Machine API v1](API.md) | Server-to-server authentication, scopes, contracts, and credential lifecycle |
| [Organisation webhooks](WEBHOOKS.md) | Outgoing signed webhooks: event types, payloads, signature verification, retries, auto-disable, and SSRF rules |
| [Large-event performance](PERFORMANCE.md) | Indexes, set-based reads and streamed exports that keep large hackathons fast, and the judging equivalence test |
| [Testing](TESTING.md) | Test suites, CI checks, coverage, and release verification |

## Deployment and operations

| Document | Purpose |
| --- | --- |
| [Free-tier cloud deployment](DEPLOYMENT_CLOUD.md) | Step-by-step production on Render, Supabase, Upstash, Cloudflare R2, Brevo, and a Cloudflare Worker cron (the default deployment) |
| [Production release](PRODUCTION_RELEASE.md) | Mandatory pre-deployment checklist |
| [Production operations](production-operations.md) | Deployments, probes, schedulers, backups, incidents, and privacy operations |
| [Releases and container images](CONTAINER_IMAGES.md) | VERSION and GitHub Releases, the public multi-platform images on GitHub Packages, and how one image serves every installation |
| [Netlify frontend + VPS backend](DEPLOYMENT_SPLIT.md) | Separate frontend workspace, private API gateway, setup and verification |
| [Complete Docker VPS deployment](DEPLOYMENT_VPS.md) | App, PostgreSQL, Redis, private storage, HTTPS, email worker and beat on one VPS; setup, checks, upgrades and backups |
| [Production Docker deployment](DEPLOYMENT_DOCKER.md) | Current single-host/container deployment, migrations, upgrades, and image limitations |
| [Isolated staging deployment](DEPLOYMENT_STAGING.md) | Single-VM Docker Compose staging/test setup behind host Nginx |
| [Helm chart](../charts/spaceworks-events/README.md) | Kubernetes installation, migration hook, secrets, probes, and ingress configuration |
| [Future phases](FUTURE_PHASES.md) | Work that is not currently implemented |

## Recommended reading order

New contributors should read Development, Architecture, Features, and Security. Operators should additionally read Configuration, Production release, and Production operations before deploying.

## Documentation maintenance

Update the relevant page whenever a feature, route, environment variable, security control, migration requirement, or operational dependency changes. Do not describe planned behavior as an existing feature; planned work belongs in `FUTURE_PHASES.md`.
