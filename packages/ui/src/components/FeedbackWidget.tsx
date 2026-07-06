import { useId, useState } from "react";
import type { FeedbackTypeT } from "@shepherd/shared";
import { useShepherdClient } from "../context.js";
import { describeError } from "../client.js";

// ---------------------------------------------------------------------------
// FeedbackWidget — the limited-release "give feedback" floating button.
//
// Rendered unconditionally by <Dashboard> so it floats over every tab (Tasks/
// Chat/Config) and the no-workspace empty state alike. A click opens an
// inline popover (not a modal) with a type picker + textarea; submitting
// forwards `workspaceId` when the host has one selected so the hub attaches
// the right workspace (see client.ts's submitFeedback), or omits it for the
// self-host / no-workspace-selected case.
// ---------------------------------------------------------------------------

export interface FeedbackWidgetProps {
  /** The currently selected workspace, if any — forwarded so the hub can attach it. */
  workspaceId?: string;
}

const TYPES: ReadonlyArray<{ id: FeedbackTypeT; label: string }> = [
  { id: "bug", label: "Bug" },
  { id: "suggestion", label: "Suggestion" },
  { id: "other", label: "Other" },
];

/** How long the "Thanks!" confirmation shows before the popover auto-closes. */
const CONFIRMATION_MS = 1500;

export function FeedbackWidget({ workspaceId }: FeedbackWidgetProps) {
  const client = useShepherdClient();
  const headingId = useId();

  const [open, setOpen] = useState(false);
  const [type, setType] = useState<FeedbackTypeT>("bug");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  function toggle() {
    setOpen((o) => !o);
  }

  function reset() {
    setType("bug");
    setBody("");
    setError(null);
    setSent(false);
  }

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await client.submitFeedback({ type, body: body.trim() }, workspaceId);
      setSent(true);
      setBody("");
      setTimeout(() => {
        setOpen(false);
        reset();
      }, CONFIRMATION_MS);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="shepherd-feedback">
      <button
        type="button"
        className="shepherd-feedback__trigger"
        onClick={toggle}
        aria-expanded={open}
      >
        Feedback
      </button>

      {open && (
        <section
          className="shepherd-feedback__panel"
          aria-labelledby={headingId}
        >
          <h3 id={headingId}>Give feedback</h3>

          {sent ? (
            <p role="status">Thanks! Your feedback was sent.</p>
          ) : (
            <>
              <div className="shepherd-feedback__types">
                {TYPES.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    aria-pressed={type === t.id}
                    onClick={() => setType(t.id)}
                  >
                    {t.label}
                  </button>
                ))}
              </div>

              <textarea
                aria-label="Feedback"
                placeholder="What's on your mind?"
                value={body}
                onChange={(e) => setBody(e.target.value)}
              />

              {error && <p role="alert">{error}</p>}

              <button
                type="button"
                onClick={() => void submit()}
                disabled={body.trim() === "" || busy}
              >
                Submit
              </button>
            </>
          )}
        </section>
      )}
    </div>
  );
}
