import { useEffect, useId, useRef } from "react";
import { SetupChecklist, type SetupChecklistProps } from "./SetupChecklist.js";

// ---------------------------------------------------------------------------
// SetupGuideDialog — the setup checklist as a modal overlay.
//
// The guide floats over the board (which always renders now) instead of
// replacing the Tasks panel. Same modal chrome as ConfirmDeleteWorkspace:
// backdrop + role="dialog", Escape / backdrop-click / ✕ dismiss. Every
// dismissal path routes through the checklist's own `onSkip`, so the caller's
// skip policy (persist per-workspace, session-only with no workspace) applies
// uniformly — a closed dialog is a skipped guide, reopenable from the header's
// ? button.
// ---------------------------------------------------------------------------

export function SetupGuideDialog(props: SetupChecklistProps) {
  const { onSkip } = props;
  const titleId = useId();
  const closeRef = useRef<HTMLButtonElement>(null);

  // Land keyboard/SR users on the close button when the dialog opens — the
  // checklist manages its own focus from there (step 1 → step 2 handoff).
  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onSkip();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onSkip]);

  return (
    <div className="shepherd-modal__backdrop" onClick={onSkip}>
      <div
        className="shepherd-modal shepherd-modal--setup"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        // Clicks inside the dialog must not bubble to the backdrop's dismiss.
        onClick={(e) => e.stopPropagation()}
      >
        <div className="shepherd-modal__head">
          <h2 id={titleId} className="shepherd-modal__title">
            Setup guide
          </h2>
          <button
            ref={closeRef}
            type="button"
            className="shepherd-modal__close"
            aria-label="Close setup guide"
            title="Close"
            onClick={onSkip}
          >
            <span aria-hidden="true">✕</span>
          </button>
        </div>
        <SetupChecklist {...props} />
      </div>
    </div>
  );
}
