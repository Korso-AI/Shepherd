import { useEffect, useId, useRef, useState } from "react";
import type { FeedbackTypeT } from "@shepherd/shared";
import { useShepherdClient } from "../context.js";
import { describeError } from "../client.js";
import { buildFeedbackContext } from "../feedbackContext.js";

// ---------------------------------------------------------------------------
// FeedbackWidget — the limited-release "give feedback" floating button.
//
// Rendered unconditionally by <Dashboard> so it floats over every tab (Tasks/
// Chat/Config) and the no-workspace empty state alike. A click opens an
// inline popover (not a modal): header with a close ×, a Bug/Suggestion/Other
// radiogroup (arrow-key navigable), a capped textarea (Ctrl/⌘+Enter submits),
// and a footer hint + Submit. Escape, the ×, and clicking outside all close
// it, returning focus to the trigger. Submitting forwards `workspaceId` when
// the host has one selected so the hub attaches the right workspace (see
// client.ts's submitFeedback), or omits it for the self-host /
// no-workspace-selected case, and silently attaches buildFeedbackContext().
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

/** How long the "Thanks" confirmation shows before the popover auto-closes. */
const CONFIRMATION_MS = 1500;
/** Textarea hard cap — well under FeedbackRequest's max(4000). */
const BODY_MAX = 2000;
/** The character counter stays hidden until the draft reaches this length. */
const COUNTER_FROM = BODY_MAX * 0.8;

export function FeedbackWidget({ workspaceId }: FeedbackWidgetProps) {
  const client = useShepherdClient();
  const headingId = useId();

  const [open, setOpen] = useState(false);
  const [type, setType] = useState<FeedbackTypeT>("bug");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const canSubmit = body.trim() !== "" && !busy;
  const isMac =
    typeof navigator !== "undefined" &&
    /Mac|iPhone|iPad/.test(navigator.platform);

  useEffect(() => {
    if (open) textareaRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [open]);

  function toggle() {
    setOpen((o) => !o);
  }

  function close() {
    setOpen(false);
    triggerRef.current?.focus();
  }

  function reset() {
    setType("bug");
    setBody("");
    setError(null);
    setSent(false);
  }

  function onPanelKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      e.stopPropagation();
      close();
    }
  }

  function onTypeKeyDown(e: React.KeyboardEvent, index: number) {
    const delta =
      e.key === "ArrowRight" || e.key === "ArrowDown"
        ? 1
        : e.key === "ArrowLeft" || e.key === "ArrowUp"
          ? -1
          : 0;
    if (delta === 0) return;
    e.preventDefault();
    const next = (index + delta + TYPES.length) % TYPES.length;
    setType(TYPES[next]!.id);
    const radios =
      rootRef.current?.querySelectorAll<HTMLButtonElement>('[role="radio"]');
    radios?.[next]?.focus();
  }

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await client.submitFeedback(
        { type, body: body.trim(), context: buildFeedbackContext() },
        workspaceId,
      );
      setSent(true);
      setBody("");
      setTimeout(() => {
        close();
        reset();
      }, CONFIRMATION_MS);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="shepherd-feedback" ref={rootRef}>
      <button
        ref={triggerRef}
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
          onKeyDown={onPanelKeyDown}
        >
          <div className="shepherd-feedback__header">
            <h3 id={headingId}>Give feedback</h3>
            <button
              type="button"
              className="shepherd-feedback__close"
              aria-label="Close"
              onClick={close}
            >
              ×
            </button>
          </div>

          {sent ? (
            <p role="status">
              <span aria-hidden="true">✓ </span>
              Thanks — we read every note.
            </p>
          ) : (
            <>
              <div
                className="shepherd-feedback__types"
                role="radiogroup"
                aria-label="Feedback type"
              >
                {TYPES.map((t, i) => (
                  <button
                    key={t.id}
                    type="button"
                    role="radio"
                    aria-checked={type === t.id}
                    tabIndex={type === t.id ? 0 : -1}
                    onClick={() => setType(t.id)}
                    onKeyDown={(e) => onTypeKeyDown(e, i)}
                  >
                    {t.label}
                  </button>
                ))}
              </div>

              <textarea
                ref={textareaRef}
                aria-label="Feedback"
                placeholder="What's on your mind?"
                maxLength={BODY_MAX}
                value={body}
                onChange={(e) => setBody(e.target.value)}
                onKeyDown={(e) => {
                  if (
                    e.key === "Enter" &&
                    (e.ctrlKey || e.metaKey) &&
                    canSubmit
                  ) {
                    void submit();
                  }
                }}
              />

              {body.length >= COUNTER_FROM && (
                <p className="shepherd-feedback__count">
                  {body.length} / {BODY_MAX}
                </p>
              )}

              {error && <p role="alert">{error}</p>}

              <div className="shepherd-feedback__footer">
                <span className="shepherd-feedback__hint" aria-hidden="true">
                  {isMac ? "⌘↵" : "Ctrl↵"} to send
                </span>
                <button
                  type="button"
                  onClick={() => void submit()}
                  disabled={!canSubmit}
                >
                  Submit
                </button>
              </div>
            </>
          )}
        </section>
      )}
    </div>
  );
}
