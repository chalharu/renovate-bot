# custom-stability-days Worker

This directory contains the Cloudflare Workers Rust webhook endpoint for the
custom Renovate stability check.

The Worker accepts GitHub `pull_request` webhooks and creates a check run
named `custom-stability-days` for Renovate PR branches. The PR branch comes
from `pull_request.head.ref` and must start with `renovate/`. Non-Renovate
branches and unsupported pull request actions are acknowledged with `200 OK`
without creating a check run.

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

### Waiting-period rules

For Renovate PRs, labels decide how long the check remains pending:

1. `security` completes immediately with success.
2. `renovate-wait-<N>d` waits `N` full days, where `N >= 1`.
3. Otherwise `DEFAULT_WAIT_DAYS` is used.

Elapsed days are calculated from `pull_request.created_at` to the current UTC
time as floored seconds divided by 86,400. Before the wait has elapsed the
check run is sent as `in_progress`; after it has elapsed the check run is
completed with a `success` conclusion.

### Configuration

Wrangler variables/secrets:

- `DEFAULT_WAIT_DAYS`: variable for the default wait period. Invalid or
  missing values safely fall back to `3`.
- `GITHUB_APP_CLIENT_ID`: secret used as the GitHub App JWT issuer.
- `GITHUB_APP_PRIVATE_KEY`: secret used to sign RS256 app JWTs.
- `GITHUB_APP_WEBHOOK_SECRET`: optional webhook secret for
  `X-Hub-Signature-256` verification. If absent, verification is skipped and
  logged.

The GitHub App needs permission to read repository installation metadata and
write checks for repositories that receive the webhook.

### Local validation

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

### Deployment basics

Do not store secrets in `wrangler.toml`. Configure secrets with Wrangler before
deploying:

```sh
wrangler secret put GITHUB_APP_CLIENT_ID
wrangler secret put GITHUB_APP_PRIVATE_KEY
wrangler secret put GITHUB_APP_WEBHOOK_SECRET
wrangler deploy
```

Configure the deployed Worker URL as a GitHub App webhook endpoint for
`pull_request` events.
