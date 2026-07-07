# Feedback widget v2 — design

**Date:** 2026-07-06
**Status:** Approved
**Scope:** `packages/shared` (schema), `packages/ui` (widget), `packages/hub` (storage + email). No admin UI (deliberately deferred — email + DB row is the pipeline at limited-release volume).

## Goal

Make the limited-release feedback widget more polished, more actionable, and actually reach a human: every submission should carry enough context to act on and land in dev@korsoai.com's inbox, without adding any friction for the person submitting.

## Current state

- `packages/ui/src/components/FeedbackWidget.tsx`: floating "Feedback" pill → inline popover with three loose type chips (Bug/Suggestion/Other), a textarea, Submit, and a 1.5s "Thanks!" state. No close button, no Escape/click-outside handling, no focus management, no length limit.
- `packages/hub`: `POST /feedback` and `POST /workspaces/:id/feedback` → `submitFeedback` → `feedback` table (migration 014: id, workspace_id, account_id, type, body, created_at). Nothing notifies anyone.

## 1. Widget UX + visual (polished refresh)

Keep the popover structure and the existing warm palette / `styles.css` conventions. Changes:

- **Header row**: "GIVE FEEDBACK" heading with a close **×** button on the right.
- **Segmented type control**: Bug / Suggestion / Other rendered as one connected pill (single bordered container, dividers between segments, filled active segment). Semantics: `role="radiogroup"` with radio buttons, arrow-key navigation between types.
- **Dismissal**: `Escape` closes; click outside the panel closes; the × closes. All three return focus to the Feedback pill.
- **Focus**: opening moves focus into the textarea.
- **Keyboard submit**: Ctrl+Enter (⌘+Enter on mac) submits when the body is non-empty; a footer hint ("⌘↵ to send" / "Ctrl↵ to send", detected from the platform) sits left of the Submit button.
- **Length guardrail**: `maxLength` 2000 on the textarea; a subtle character counter (`1743 / 2000`) appears only once the body passes 80% of the limit.
- **Motion**: the panel opens with a small fade + upward rise (~120ms); wrapped in `@media (prefers-reduced-motion: no-preference)` so reduced-motion users get an instant open.
- **Success state**: a checkmark glyph + "Thanks — we read every note", keeping the existing auto-close timer.

Draft state (`type`, `body`) continues to reset only after a successful send; closing the popover mid-draft keeps the draft (current behavior, now explicit).

## 2. Auto-context capture

The widget silently gathers, at submit time:

| Field        | Source                                                                                      |
| ------------ | ------------------------------------------------------------------------------------------- |
| `route`      | `window.location.pathname` (+ hash if present)                                               |
| `appVersion` | `SHEPHERD_UI_VERSION` constant in a new `src/version.ts`, kept in sync with `package.json` by a test |
| `userAgent`  | `navigator.userAgent`                                                                        |
| `viewport`   | `"{innerWidth}x{innerHeight}"`                                                               |

- **Schema** (`packages/shared`): `FeedbackRequest` gains an optional `context` object; every field optional, `z.string().max(…)`-capped (route/appVersion/viewport 256, userAgent 512). Old clients that omit `context` keep working; unknown extra fields are stripped by Zod as today.
- **DB**: migration `019_feedback_context.sql` (migrations already run to 018) adds a nullable `context jsonb` column (atomic single-transaction file, per the migrate.ts invariant). `insertFeedback` stores the validated object verbatim, `NULL` when absent.
- No new props on `FeedbackWidget`; everything comes from browser globals (guarded so SSR/tests without `window` just omit fields).

## 3. Email delivery via Resend

The hub **already has** Resend infrastructure (`src/email.ts`, fetch-based, used by email invites) and `RESEND_API_KEY`/`INVITE_EMAIL_FROM` in config — this feature extends it rather than adding a new module.

- **Extend `src/email.ts`** with `sendFeedbackEmail(...)`: a plain `fetch` POST to `https://api.resend.com/emails` — no SDK dependency, mirroring `sendInviteEmail`.
- **Config (env)**:
  - `RESEND_API_KEY` + `INVITE_EMAIL_FROM` (existing) — either absent → feedback email is disabled and skips silently (the self-host default). The sender address is shared with invites; no separate `FEEDBACK_EMAIL_FROM`.
  - `FEEDBACK_EMAIL_TO` (new) — default `dev@korsoai.com`.
- **Wiring**: `submitFeedback` inserts the row first, then calls the mailer **fire-and-forget** (`void sendFeedbackEmail(...).catch(log)`). A mail failure (or slow Resend) never fails or delays the HTTP response; the row is the source of truth.
- **Email content**: subject `[Feedback] <type> — <first 60 chars of body>`; plain-text body with the message, type, account ID, workspace ID, each context field, created-at, and the feedback row ID (for looking the row up later).

## 4. Testing

- **ui**: component tests (existing vitest setup) for: × / Escape / click-outside close + focus return, focus-on-open, Ctrl/⌘+Enter submit, counter appears only past 80%, context object included in the client call, success state renders.
- **shared**: schema round-trip — request with and without `context` parses; oversized fields rejected.
- **hub**: `submitFeedback` test with a mocked mailer — row inserted with context; mailer called with the row; mailer rejection does not reject the operation; mailer skipped when `RESEND_API_KEY` unset.

## Ops (outside this change)

1. Verify korsoai.com as a sending domain in Resend; create an API key (skip whatever is already configured for email invites).
2. Ensure `RESEND_API_KEY` and `INVITE_EMAIL_FROM` are set on the hub's Cloud Run service; set `FEEDBACK_EMAIL_TO` only if a destination other than dev@korsoai.com is wanted.
3. Run migration 019 against Cloud SQL via the normal migration path.

## Out of scope

- Admin/triage UI (revisit when volume justifies it).
- Screenshot attachments, reply-to-user email field (account ID already identifies signed-in users).
- Digest emails.
