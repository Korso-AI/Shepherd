# Setup guide as an overlay dialog

**Date:** 2026-07-06
**Scope:** `packages/ui` (hosted shell onboarding)

## Problem

The first-run setup guide (`SetupChecklist`) currently replaces the entire
Tasks panel, so it reads like its own page. The re-open affordance is a
full-width "Setup guide" text button in the header. The guide should instead
be cards on a modal overlay above the board, re-opened from a small "?" icon
button in the upper-right of the header.

## Design

### Trigger — "?" icon button

The `header-setup-guide` text button in `Dashboard.tsx` becomes a small
circular icon button rendering `?`:

- Same header slot (right side, before Sign out), hosted-only, as today.
- `aria-label="Setup guide"` and `title="Setup guide"` (the visible `?` glyph
  is `aria-hidden`).
- New CSS class `header-help` styled as a compact circle (~24px), replacing
  the `header-setup-guide` styles.

### Overlay — `SetupGuideDialog`

A new component `src/onboarding/SetupGuideDialog.tsx` wraps the existing
`SetupChecklist` in the codebase's established modal chrome
(`shepherd-modal__backdrop` + `role="dialog"` / `aria-modal="true"`, as in
`ConfirmDeleteWorkspace`):

- A wider panel variant (`shepherd-modal--setup`): max-width ~640px,
  `max-height: 85vh` with internal scroll (step 2 is tall).
- Panel header: "Setup guide" title + a `✕` close button
  (`aria-label="Close setup guide"`).
- Escape and backdrop click close the dialog; clicks inside do not bubble to
  the backdrop.
- Initial focus lands on the close button (or the panel) when it opens.
- `SetupChecklist` renders inside unchanged — all checklist logic (create
  form, token minting, agent check-in, focus handoff between steps) stays
  where it is. CSS is adjusted so each step reads as a card on the panel.

### Behavior changes

1. **The Tasks panel always shows the board.** The checklist no longer
   replaces it; for a brand-new user the (empty) board sits dimmed behind the
   overlay. `showBoardChrome` drops its "checklist is replacing the Tasks
   tab" exception.
2. **Auto-open unchanged.** The same `useSetupStage` derivation that showed
   the inline checklist now opens the dialog (stage !== "hidden" → dialog
   rendered).
3. **All dismissals route to `skip()`.** `✕`, Escape, backdrop click,
   "Skip for now", and "Go to your board" all call the existing
   `setup.skip()` — persisted per-workspace, reopenable anytime via `?`.
4. **The create stage becomes dismissible.** Today `deriveSetupStage` returns
   `"create"` unconditionally with no workspace ("never block"). A modal that
   cannot close is worse UX than a closable one, and the empty board behind
   still carries an "Open setup guide" CTA, so:
   - `deriveSetupStage` gains a create-stage dismissal: with no workspace,
     `skipped` (session state) or `forcedOpen` still resolve sensibly —
     `forcedOpen` wins, then `skipped → "hidden"`, else `"create"`.
   - The dismissal is session-only (no workspace id to persist against); the
     guide re-opens on the next session until a workspace exists.

### Files touched

- `src/onboarding/SetupGuideDialog.tsx` — new modal wrapper.
- `src/onboarding/SetupChecklist.tsx` — unchanged logic; minor class tweaks
  if needed for card styling inside the panel.
- `src/onboarding/logic.ts` — create-stage dismissal in `deriveSetupStage`.
- `src/onboarding/useSetupStage.ts` — `skip()` works without a workspace id
  (state-only skip).
- `src/components/Dashboard.tsx` — `?` icon button; render
  `SetupGuideDialog` instead of swapping the Tasks panel; simplify
  `showBoardChrome`.
- `src/styles.css` — `header-help` icon button, `shepherd-modal--setup`
  variant, setup-step card styling.

## Error handling

No new failure modes: create/mint errors continue to render inline inside
the checklist (now inside the dialog). Clipboard-failure and one-time-token
messaging are untouched.

## Testing

- `logic.test` (or equivalent): create-stage dismissal matrix — skipped with
  no workspace hides; forcedOpen with no workspace shows `"create"`.
- Dashboard/SetupChecklist tests: guide renders inside `role="dialog"`; the
  `?` button (accessible name "Setup guide") opens it; Escape, backdrop
  click, and `✕` dismiss it; board renders behind (Tasks panel content
  present while dialog is open); "Go to your board" / "Skip for now" still
  dismiss.
