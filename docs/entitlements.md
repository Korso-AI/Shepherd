# Workspace entitlements

The hub has a small, optional per-workspace limits primitive: an operator (or a
trusted embedding service) can cap how many **seats** (members) and **repos** a
workspace uses, and how long its announcements are **retained**. It is designed
to be invisible unless a deployment explicitly turns it on.

> **Self-host guarantee:** a deployment that never sets
> `ENTITLEMENTS_DEFAULT_LIMITS` has **no limits of any kind**. Every check in
> this document is a no-op in that case — no caps, no retention pruning, no
> `402` responses. Requests authenticated with the self-host `TEAM_TOKEN` are
> additionally exempt even when the variable *is* set.

## The model

Limits resolve in three layers, checked at enforcement time:

1. **Enforcement switch** — the `ENTITLEMENTS_DEFAULT_LIMITS` env var. Unset ⇒
   the entire subsystem is inert.
2. **Deployment defaults** — the value of that env var: the limits that apply
   to any workspace without its own record (or whose record has expired).
3. **Per-workspace record** — a row in `workspace_entitlements` (migration
   `020`), managed through the internal endpoints below. A live record's caps
   apply **verbatim**, including its `NULL`s.

Within any set of limits, `NULL` for a given cap means **unlimited** for that
dimension. So:

| State                                   | Effective limits            |
| --------------------------------------- | --------------------------- |
| `ENTITLEMENTS_DEFAULT_LIMITS` unset      | none — everything unlimited |
| set, workspace has no record             | the deployment defaults     |
| set, workspace has a live record         | the record's caps, verbatim |
| set, record's `expires_at` is in the past | the deployment defaults     |

`expires_at` makes a record **self-expiring**: past that instant the row stays
visible but stops binding, and the workspace degrades to the deployment
defaults with no cron or cleanup pass required.

## `ENTITLEMENTS_DEFAULT_LIMITS`

A JSON object with exactly three keys, each a positive integer or `null`
(unlimited):

```bash
ENTITLEMENTS_DEFAULT_LIMITS='{"seatsLimit": 10, "reposLimit": 25, "retentionDays": 60}'
```

- `seatsLimit` — max members per workspace. Enforced when an invite is
  redeemed: a redemption that would exceed the cap fails with `402` and leaves
  the invite unconsumed. Race-safe under concurrent redemptions (a
  per-workspace advisory lock serializes the check).
- `reposLimit` — max distinct repos per workspace. Enforced when an agent
  joins on a repo the workspace has not seen before; re-joining an existing
  repo always succeeds regardless of the cap.
- `retentionDays` — announcements older than this are pruned lazily (during
  normal traffic, throttled to at most one sweep per workspace per hour, in
  bounded batches). `null` keeps announcements forever.

Malformed JSON or a non-positive cap fails config validation at boot, naming
the variable.

## The `402 limit_exceeded` error

A request blocked by a cap gets HTTP `402` with a machine-readable body:

```json
{
  "error": "This workspace has reached its seat limit (10/10). Ask a workspace admin about increasing it.",
  "code": "limit_exceeded",
  "limit": "seats",
  "current": 10,
  "max": 10
}
```

`limit` is `"seats"` or `"repos"`. The wire shape is `LimitExceededErrorBody`
in `@shepherd/shared`.

## Internal management endpoints

A trusted embedding service (the same backend that holds `BFF_INTERNAL_TOKEN`)
manages per-workspace records through a service-to-service surface:

```
PUT    /internal/workspaces/:id/entitlements   — upsert the record
GET    /internal/workspaces/:id/entitlements   — record + effective limits + usage
DELETE /internal/workspaces/:id/entitlements   — drop the record (revert to defaults)
```

These accept **only** the internal service-call credential: a matching
`x-internal-token` header, on an `/internal/*` path, with **no**
`x-account-id`. Browser sessions, agent `shp_…` tokens, and the self-host
`TEAM_TOKEN` are all rejected. A self-host deployment without
`BFF_INTERNAL_TOKEN` has no way to reach this surface at all.

`PUT` takes the three caps plus `expiresAt` (ISO timestamp or `null`):

```json
{ "seatsLimit": 10, "reposLimit": null, "retentionDays": 60, "expiresAt": "2027-01-01T00:00:00Z" }
```

`GET` returns the stored record (`null` if none), the limits actually in
effect right now (all-`null` when enforcement is off), and current usage
(`seatsUsed`, `reposUsed`) so a caller can render headroom.
