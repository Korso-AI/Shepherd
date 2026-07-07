import { useId } from "react";
import type { ReactNode } from "react";

// ---------------------------------------------------------------------------
// EmptyState — the reusable "you have no workspace yet" prompt.
//
// Shown on Tasks/Chat when the account belongs to no workspace (design §7: those
// views render an empty state, never a hard wall or error). The CTA routes the
// user to Config, where create/join lives.
// ---------------------------------------------------------------------------

export interface EmptyStateProps {
  /** Heading text. Defaults to a generic "no workspace yet" prompt. */
  title?: string;
  /** Supporting copy. */
  children?: ReactNode;
  /** Invoked when the user clicks the call-to-action (e.g. switch to Config). */
  onGetStarted?: () => void;
  /** CTA label. */
  ctaLabel?: string;
}

export function EmptyState({
  title = "No workspace yet",
  children,
  onGetStarted,
  ctaLabel = "Go to Config",
}: EmptyStateProps) {
  // A per-instance id so two EmptyStates (e.g. the Tasks and Chat panels of a
  // no-workspace board) never collide on a duplicate `empty-state-heading` id.
  const headingId = useId();
  return (
    <section className="shepherd-empty-state" aria-labelledby={headingId}>
      <h2 id={headingId}>{title}</h2>
      <p>
        {children ??
          "Create a workspace or join one with an invite code to get started."}
      </p>
      {onGetStarted && (
        <button type="button" onClick={onGetStarted}>
          {ctaLabel}
        </button>
      )}
    </section>
  );
}
