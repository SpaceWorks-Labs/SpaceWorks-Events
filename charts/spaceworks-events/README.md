# Space Works Events Helm chart

Use this chart only on Kubernetes. For a single VPS or another container host
without Kubernetes, use the
[production Docker deployment guide](../../docs/DEPLOYMENT_DOCKER.md) instead.

## Images

The chart uses one image, `ghcr.io/spaceworks-labs/spaceworks-events-backend`,
which every green build of `main` publishes (see
[Releases and container images](../../docs/CONTAINER_IMAGES.md)). The web
Deployment runs it as the application, the worker and beat Deployments run its
`worker` and `beat` roles, and the migration Job runs its `migrate` role. Use
an immutable version tag such as `0.9.1-main.42.a1b2c3d4e5f6`. The Secret must
provide `NEXT_PUBLIC_BASE_URL` and the installation's own
`NEXT_SERVER_ACTIONS_ENCRYPTION_KEY`; the container applies the origin at start
and refuses to start without the key.

## Runtime secret

Create the namespace and a Kubernetes Secret outside Helm. It must include every production value required by `.env.production.example` / `npm run production:check`, including `DIRECT_URL` when `DATABASE_URL` goes through a transaction pooler (the migration Job falls back to `DATABASE_URL` otherwise).

```bash
kubectl create namespace swevents
kubectl -n swevents create secret generic spaceworks-events-runtime --from-env-file=/secure/path/swevents.env
```

Use External Secrets or Sealed Secrets in a real production cluster; do not commit the secret manifest.

## Install

Create a `values-production.yaml` outside source control:

```yaml
image:
  repository: ghcr.io/spaceworks-labs/spaceworks-events-backend
  tag: "VERSION"
migration:
  image:
    repository: ghcr.io/spaceworks-labs/spaceworks-events-backend
    tag: "VERSION"
ingress:
  enabled: true
  className: nginx
  hosts:
    - host: events.example.com
      paths:
        - path: /
          pathType: Prefix
  tls:
    - secretName: events-example-com-tls
      hosts: [events.example.com]
```

Validate and deploy:

```bash
helm lint charts/spaceworks-events
helm upgrade --install spaceworks-events charts/spaceworks-events --namespace swevents --create-namespace --values /secure/path/values-production.yaml --wait --timeout 10m
```

The migration Job is a Helm pre-install/pre-upgrade hook. A failed migration blocks the application rollout. Before migrating, the Job runs `node scripts/check-reserved-slugs.mjs`: when an organisation already holds an address the new release reserves, the release fails with nothing migrated ([Reserved organisation addresses](../../docs/production-operations.md#reserved-organisation-addresses)).

## Email worker and beat

With `background.enabled: true` (the default), the chart adds two Deployments
from the same image and Secret:

- **worker** (`background.worker`): sends queued email within seconds.
- **beat** (`background.beat`): runs the timed jobs (payment holds and
  reminders, waitlists, event reminders, retention, backup alerts) and queues their email for the worker.
  It is replaced with the `Recreate` strategy, so only one runs at a time.

Each has its own `replicaCount` and `resources`. Their pods listen on loopback
only, have no Service and are probed from inside the container. The web pods
then get `SWE_PROCESS_ROLE=web` and only serve requests. Set
`background.enabled: false` to run everything in the web pods
(`SWE_PROCESS_ROLE=all`). Check the worker and beat heartbeats under Super
admin → Operations after each rollout.
