import { Fragment } from "react";
import type { ReactElement } from "react";
import type { WorkspaceTaskT } from "@shepherd/shared";
import {
  dayBucket,
  formatActiveDuration,
  formatRelative,
  matchesRepo,
  statusLabel,
} from "../logic.js";
import { Territory } from "./Territory.js";

/** Props for {@link DoneList}. */
export interface DoneListProps {
  /** The board's tasks; only finished ones in the selected repo are shown. */
  tasks: WorkspaceTaskT[];
  /** The server-clock "now" in epoch ms, for relative time + day bucketing. */
  nowMs: number;
  /** The selected repo, or `null`/`"__all__"` for all repos. */
  selectedRepo: string | null;
  /** Cumulative number of finished tasks to display (initial 10). */
  doneShown: number;
  /** Called when "Load older" is clicked, to grow `doneShown` by a page. */
  onLoadMore: () => void;
}

/** Stable identity for a task across renders (the payload has no task id). */
const taskKey = (t: WorkspaceTaskT): string =>
  `${t.agentName}|${t.repo}|${t.createdAt}`;

/** Whether the board is showing all repos (so cards carry a repo tag). */
const isAllRepos = (selected: string | null): boolean =>
  selected === null || selected === "__all__";

/**
 * The Done column. Ported from app.js `renderDone`. Filters tasks to
 * non-active + selected-repo, then renders the cumulative `[0, doneShown]`
 * slice under day-bucket headers ({@link dayBucket} on `endedAt ?? createdAt`).
 * A dropped task gets a `task__stat--drop` chip and a "went offline … — no done
 * signal" meta; a done task gets a "done" chip and a "finished … · active Nm"
 * meta. When more finished tasks exist than are shown, a "Load older · N of M"
 * button calls {@link DoneListProps.onLoadMore}.
 *
 * @param props - The tasks, the server "now", the repo filter, the cumulative
 *   shown count, and the load-more callback.
 * @returns The done list element.
 */
export function DoneList({
  tasks,
  nowMs,
  selectedRepo,
  doneShown,
  onLoadMore,
}: DoneListProps): ReactElement {
  const allRepos = isAllRepos(selectedRepo);
  const done = tasks.filter(
    (t) => t.status !== "active" && matchesRepo(t, selectedRepo),
  );

  if (done.length === 0) {
    const msg = allRepos
      ? "No finished tasks yet."
      : `No finished tasks in ${selectedRepo} yet.`;
    return (
      <div id="done-list">
        <div className="empty">{msg}</div>
      </div>
    );
  }

  const page = done.slice(0, doneShown);
  let lastDay: string | null = null;

  return (
    <div id="done-list">
      {page.map((t) => {
        const day = dayBucket(t.endedAt ?? t.createdAt, nowMs);
        const header = day !== lastDay ? day : null;
        lastDay = day;

        const dropped = t.status === "dropped";
        const meta = dropped
          ? `went offline ${formatRelative(t.endedAt ?? t.createdAt, nowMs)}, no done signal`
          : `finished ${formatRelative(t.endedAt ?? t.createdAt, nowMs)}${
              formatActiveDuration(t.createdAt, t.endedAt)
                ? " · " + formatActiveDuration(t.createdAt, t.endedAt)
                : ""
            }`;

        return (
          <Fragment key={taskKey(t)}>
            {header !== null && <div className="day">{header}</div>}
            <div className="task">
              <div className="task__r1">
                <span className="task__who">{t.agentName}</span>
                {allRepos && <span className="task__repo">{t.repo}</span>}
                <span
                  className={
                    "task__stat" + (dropped ? " task__stat--drop" : "")
                  }
                >
                  {statusLabel(t.status)}
                </span>
              </div>
              <div className="task__intent">{t.intent}</div>
              <Territory globs={t.pathGlobs} />
              <div className="task__meta">{meta}</div>
            </div>
          </Fragment>
        );
      })}
      {done.length > doneShown && (
        <div
          className="more"
          role="button"
          tabIndex={0}
          onClick={onLoadMore}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              onLoadMore();
            }
          }}
        >
          {`Load older · ${doneShown} of ${done.length}`}
        </div>
      )}
    </div>
  );
}
