# Hosted Korso console integration

These notes apply only to the Korso-hosted console/BFF integration. Self-hosters
can ignore this document.

## BFF forwarding

The upstream forwarder must pass the request **method and body** through — every
forwarded Shepherd endpoint is POST (`/join`, `/work`, `/done`, …).

The hub's routes live at the **root** (`/work`, not `/api/work`), so the
console's per-upstream path prefix for Shepherd must be the empty string.

## Cloud Run IAM

The Cloud Run OIDC token's `aud` must equal the hub's own Cloud Run URL (the
BFF's `SHEPHERD_API_BASE`), since that is exactly what the IAM check validates.

Grant the BFF's invoker service account `roles/run.invoker` on the hub service.
The invoker SA is the frontend's `SHEPHERD_INVOKER_SA_EMAIL` (minted via WIF).

## Hub secrets

Set `BFF_INTERNAL_TOKEN` on the hub (the BFF sends it as `x-internal-token`).
Set `OPERATOR_IDENTITY_SECRET` on both the hub and BFF for `/admin/*` analytics.

See the root README's "Deploying the hub (GCP)" section for the full deploy
walkthrough.
