import { useEffect, useId, useRef, useState } from "react";
import type { WorkspaceSummaryT } from "@shepherd/shared";
import { useShepherdClient } from "../context.js";
import { describeError } from "../client.js";

// ---------------------------------------------------------------------------
// WorkspaceSwitcher — the app-bar control that shows the ACTIVE workspace and
// is the single home for "which workspaces do I belong to" actions: switch,
// create, and join. It lives in the Dashboard header (rendered on every tab),
// so the active workspace is always visible — the redesign's core fix for
// "I can't tell which workspace I'm in."
//
// This absorbs create/join (previously buried in the Config <Workspaces>
// section) so the Config tab is left meaning exactly one thing: settings for
// the CURRENT workspace. Create/join therefore own their client calls here.
//
// Empty account (no workspace): the trigger degrades to a dashed "Get started"
// affordance whose menu offers only Create / Join — the one obvious entry point
// for a brand-new user, matching the no-workspace board's EmptyState CTA.
// ---------------------------------------------------------------------------

export interface WorkspaceSwitcherProps {
  /** All workspaces the account belongs to. */
  workspaces: WorkspaceSummaryT[];
  /** The currently-active workspace, or null when the account has none. */
  selected: WorkspaceSummaryT | null;
  /** Switch the active workspace. */
  onSelect: (workspaceId: string) => void;
  /** Called after a create/join changes membership, so the shell re-lists. */
  onChanged: () => void;
  /** Called after a join (which adds the caller to a new roster). */
  onMembersChanged?: () => void;
}

type Mode = "menu" | "create" | "join";

/** First letter of a workspace name, for the square avatar chip. */
function initial(name: string): string {
  return (name.trim()[0] ?? "?").toUpperCase();
}

export function WorkspaceSwitcher({
  workspaces,
  selected,
  onSelect,
  onChanged,
  onMembersChanged,
}: WorkspaceSwitcherProps) {
  const client = useShepherdClient();
  const menuId = useId();
  const rootRef = useRef<HTMLDivElement>(null);

  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<Mode>("menu");
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Reset the popover to its default (menu) state whenever it closes, so it
  // never re-opens mid-form with a stale input or error.
  function close() {
    setOpen(false);
    setMode("menu");
    setName("");
    setCode("");
    setError(null);
  }

  // Dismiss on outside-click and Escape — standard popover behavior.
  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node))
        close();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") close();
    }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  async function create() {
    if (!name.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const ws = await client.createWorkspace({ name: name.trim() });
      // Switch to the freshly-created workspace, then re-list. ShepherdRoot
      // preserves a still-present selection across the re-list, so ordering
      // onSelect before onChanged lands the user on the new workspace.
      onSelect(ws.id);
      onChanged();
      close();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  async function join() {
    if (!code.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await client.redeemInvite(code.trim());
      onSelect(res.workspace.id);
      onChanged();
      onMembersChanged?.();
      close();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  const hasWorkspace = selected !== null;
  const label = selected ? selected.name : "Get started";

  return (
    <div className="ws-switcher" ref={rootRef}>
      <button
        type="button"
        className={"ws-trig" + (hasWorkspace ? "" : " ws-trig--empty")}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => (open ? close() : setOpen(true))}
      >
        {hasWorkspace ? (
          <span className="ws-avatar" aria-hidden="true">
            {initial(label)}
          </span>
        ) : (
          <span className="ws-plus" aria-hidden="true">
            ＋
          </span>
        )}
        <span className="ws-name">{label}</span>
        <span className="ws-caret" aria-hidden="true">
          ▾
        </span>
      </button>

      {open && (
        <div className="ws-menu" id={menuId} role="menu">
          {mode === "menu" && (
            <>
              <p className="ws-menu__head">
                {hasWorkspace ? "Switch workspace" : "Your workspaces"}
              </p>
              {workspaces.length === 0 ? (
                <p className="ws-menu__none">None yet</p>
              ) : (
                <ul className="ws-menu__list">
                  {workspaces.map((w) => {
                    const active = w.id === selected?.id;
                    return (
                      <li key={w.id}>
                        <button
                          type="button"
                          role="menuitemradio"
                          aria-checked={active}
                          className={"ws-mi" + (active ? " ws-mi--on" : "")}
                          onClick={() => {
                            onSelect(w.id);
                            close();
                          }}
                        >
                          <span
                            className="ws-avatar ws-avatar--sm"
                            aria-hidden="true"
                          >
                            {initial(w.name)}
                          </span>
                          <span className="ws-mi__name">{w.name}</span>
                          {active && (
                            <span className="ws-mi__check" aria-hidden="true">
                              ✓
                            </span>
                          )}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
              <div className="ws-menu__actions">
                <button
                  type="button"
                  role="menuitem"
                  className="ws-action"
                  onClick={() => {
                    setError(null);
                    setMode("create");
                  }}
                >
                  ＋ Create workspace
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="ws-action"
                  onClick={() => {
                    setError(null);
                    setMode("join");
                  }}
                >
                  ⎘ Join with a code
                </button>
              </div>
            </>
          )}

          {mode === "create" && (
            <form
              className="ws-form"
              onSubmit={(e) => {
                e.preventDefault();
                void create();
              }}
            >
              <label htmlFor={`${menuId}-name`}>New workspace name</label>
              <input
                id={`${menuId}-name`}
                type="text"
                placeholder="e.g. Acme Engineering"
                value={name}
                autoFocus
                onChange={(e) => setName(e.target.value)}
              />
              <div className="ws-form__row">
                <button
                  type="button"
                  className="ws-form__back"
                  onClick={() => setMode("menu")}
                >
                  Back
                </button>
                <button type="submit" disabled={busy || !name.trim()}>
                  Create
                </button>
              </div>
            </form>
          )}

          {mode === "join" && (
            <form
              className="ws-form"
              onSubmit={(e) => {
                e.preventDefault();
                void join();
              }}
            >
              <label htmlFor={`${menuId}-code`}>Invite code</label>
              <input
                id={`${menuId}-code`}
                type="text"
                placeholder="Paste an invite code"
                value={code}
                autoFocus
                onChange={(e) => setCode(e.target.value)}
              />
              <div className="ws-form__row">
                <button
                  type="button"
                  className="ws-form__back"
                  onClick={() => setMode("menu")}
                >
                  Back
                </button>
                <button type="submit" disabled={busy || !code.trim()}>
                  Join
                </button>
              </div>
            </form>
          )}

          {error && (
            <p className="ws-menu__error" role="alert">
              {error}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
