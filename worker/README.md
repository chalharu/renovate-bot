# custom-stability-days Worker

This directory contains the Cloudflare Workers Rust webhook endpoint for the
custom Renovate stability check.

The Worker accepts GitHub `pull_request` webhooks for Renovate PR branches
(`pull_request.head.ref` starts with `renovate/`) and manages a check run named
`custom-stability-days`. Non-Renovate branches and unsupported pull request
actions are acknowledged with `200 OK` without changing checks.

The shared Renovate config keeps the global `minimumReleaseAge` setting for
datasources that support release timestamps. Docker registry updates outside
Docker Hub, such as `ghcr.io`, are configured with `minimumReleaseAge: null`
and receive the `renovate-wait-3d` label so this Worker enforces the waiting
period instead.

Supported pull request actions:

- `opened`
- `reopened`
- `synchronize`
- `labeled`
- `unlabeled`

## Waiting-period rules

The flow is intentionally split between the Worker webhook and the Renovate
workflow:

1. `opened`, `reopened`, and `synchronize` create or refresh a `queued` custom
   check for the current Renovate head SHA.
2. The follow-up GitHub Actions step scans open `renovate/*` PRs, reads the
   Renovate JSON log output for the current run to recover branch/update
   metadata, generates an HS256 JWT using the GitHub App private key material as
   the shared secret, and moves the custom check to `in_progress` or
   `completed`.
3. Later `labeled`/`unlabeled` events let the Worker fetch the current labels,
   read the hidden JWT marker from the current custom check output, and
   recalculate pending vs success from the stored `version_created_at`.

For Renovate PRs, current labels decide how long the check waits:

1. `security` completes immediately with success.
2. `renovate-wait-<N>d` waits `N` full days, where `N >= 1`.
3. Otherwise `DEFAULT_WAIT_DAYS` is used.

Elapsed days are calculated from the resolved release `version_created_at`, not
from `pull_request.created_at`. Before the wait has elapsed the check stays
`in_progress`; after it has elapsed the check is `completed` with a `success`
conclusion. If GitHub already exposes the built-in `renovate/stability-days`
check for the current head SHA, the custom check mirrors that gate safely: a
passing built-in check lets the custom check complete, and a still-pending
built-in check keeps the custom check pending.

The hidden JWT marker is stored in the custom check `output.text` field as an
HTML comment so the Worker can retrieve it later via the GitHub Checks API. The
Renovate workflow writes a trace-level JSON log file with a `logContext` for the
selected repository so the follow-up step can prefer Renovate's own resolved
`releaseTimestamp` data. If metadata is unavailable in those logs, the check
stays or returns to `queued` with an explanatory summary instead of inventing a
timestamp. When a single Renovate branch contains multiple upgrades, the helper
uses the most recent logged `releaseTimestamp` so the wait does not clear before
the youngest included release is old enough. Common queued causes are an unreadable
or missing Renovate JSON log file, no `processBranch()` entry for this branch in
the current Renovate run, or a mismatched `RENOVATE_LOG_CONTEXT`.

## Configuration

Wrangler variables/secrets:

- `DEFAULT_WAIT_DAYS`: variable for the default wait period. Invalid or
  missing values safely fall back to `3`.
- `GITHUB_APP_CLIENT_ID`: secret used as the GitHub App JWT issuer.
- `GITHUB_APP_PRIVATE_KEY`: secret used both to sign RS256 GitHub App JWTs and
  as the shared secret for HS256 pending-state tokens.
- `GITHUB_APP_WEBHOOK_SECRET`: secret used for `X-Hub-Signature-256`
  verification. Requests are rejected when it is missing or invalid.

The GitHub App needs permission to read repository installation metadata and
write checks for repositories that receive the webhook. The Renovate workflow
must also receive the same private key as `PRIVATE_KEY` so the follow-up step
can mint matching HS256 pending-state tokens.

## Local validation

Run the Rust checks from this directory:

```sh
cargo fmt --check
cargo check
cargo test
```

To validate the Worker target and release build:

```sh
rustup target add wasm32-unknown-unknown
cargo check --target wasm32-unknown-unknown
cargo install worker-build --locked
worker-build --release
```

## Deployment basics

Production deployments run from GitHub Actions on pushes to `main` via
`.github/workflows/deploy-worker.yaml`. You can also run that workflow manually
from `main` to redeploy the same Worker; the deploy job intentionally skips
non-`main` refs so branch runs cannot overwrite production.

Do not store secrets in `wrangler.toml`. Configure or rotate Worker secrets with
Wrangler before the first deployment, and whenever those values change:

```sh
wrangler secret put GITHUB_APP_CLIENT_ID
wrangler secret put GITHUB_APP_PRIVATE_KEY
wrangler secret put GITHUB_APP_WEBHOOK_SECRET
```

Configure the deployed Worker URL as a GitHub App webhook endpoint for
`pull_request` events.
