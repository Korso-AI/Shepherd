import { useEffect, useRef, useState } from "react";
import type { ReactElement } from "react";

/**
 * Per-repo task tallies surfaced in the menu rows. The `"__all__"` key carries
 * the board-wide aggregate shown on the "All repos" option.
 */
export interface RepoCounts {
  /** Active task count for the repo (or aggregate under `"__all__"`). */
  active: number;
  /** Finished task count for the repo (or aggregate under `"__all__"`). */
  done: number;
}

/** Props for {@link RepoSelect}. */
export interface RepoSelectProps {
  /** The distinct repos present on the board (sorted by the caller). */
  repos: string[];
  /** Per-repo `{active,done}` tallies, plus an `"__all__"` aggregate row. */
  counts: Record<string, RepoCounts>;
  /** The selected repo, or `null` for All repos. */
  selected: string | null;
  /** Called with the chosen repo, or `null` when "All repos" is picked. */
  onSelect: (repo: string | null) => void;
}

const EMPTY: RepoCounts = { active: 0, done: 0 };

/**
 * The repo filter: a click-to-open menu of repos plus an "All repos" option,
 * each showing its `"N active · N done"` tally. Ported from app.js
 * `renderRepoSelect` — same markup, classes, and listbox/option roles so it
 * stays keyboard- and screen-reader-operable.
 *
 * Hidden entirely when fewer than two repos exist (nothing to filter). Owns its
 * own open/close state; the trigger toggles it and Escape closes it. Choosing a
 * repo calls `onSelect(repo)`; choosing "All repos" calls `onSelect(null)` —
 * matching app.js, which then stores the sentinel `"__all__"` for All repos.
 *
 * @param props - Repos, per-repo counts, the current selection, and the
 *   selection callback.
 * @returns The repo selector, or `null` when there are fewer than two repos.
 */
export function RepoSelect({
  repos,
  counts,
  selected,
  onSelect,
}: RepoSelectProps): ReactElement | null {
  const [open, setOpen] = useState(false);
  const hostRef = useRef<HTMLSpanElement>(null);

  // Move focus into the freshly-opened menu (the selected option, else the
  // first) so keyboard users can Tab the options and Esc out — only on open.
  useEffect(() => {
    if (!open) return;
    const menu = hostRef.current?.querySelector(".repo-menu");
    if (!menu) return;
    const target =
      menu.querySelector<HTMLElement>('[aria-selected="true"]') ??
      menu.querySelector<HTMLElement>("button");
    target?.focus();
  }, [open]);

  // Dismiss on outside-click — same popover behavior as the workspace
  // switcher. mousedown (not click) so it fires before focus moves.
  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (hostRef.current && !hostRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  if (repos.length < 2) return null;

  const isAll = selected === null || selected === "__all__";
  const label = isAll ? "All repos" : selected;

  /** A single menu option; `repo === null` is the "All repos" row. */
  const renderItem = (repo: string | null, text: string): ReactElement => {
    const c =
      repo === null ? (counts.__all__ ?? EMPTY) : (counts[repo] ?? EMPTY);
    const isOn = repo === null ? isAll : selected === repo;
    const cls = "repo-mi" + (isOn ? " on" : "") + (repo === null ? " all" : "");
    return (
      <button
        key={repo ?? "__all__"}
        type="button"
        className={cls}
        role="option"
        aria-selected={isOn}
        onClick={(e) => {
          e.stopPropagation();
          setOpen(false);
          onSelect(repo);
        }}
      >
        <span>{text}</span>
        <span className="ct">{`${c.active} active · ${c.done} done`}</span>
      </button>
    );
  };

  return (
    <span
      ref={hostRef}
      className="repo"
      onKeyDown={(e) => {
        if (e.key === "Escape") setOpen(false);
      }}
    >
      <button
        type="button"
        className="repo-trig"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Filter by repo (current: ${label})`}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
        }}
      >
        <span className="slash">/</span>
        {" " + label + " "}
        <span>▼</span>
      </button>
      {open && (
        <div className="repo-menu" role="listbox">
          {repos.map((r) => renderItem(r, r))}
          {renderItem(null, "All repos")}
        </div>
      )}
    </span>
  );
}
