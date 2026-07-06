import type { ReactElement } from "react";
import type { WorkspaceTaskT } from "@shepherd/shared";
import {
  formatRelative,
  groupActiveClaims,
  matchesRepo,
  type ClaimGroup,
} from "../logic.js";
import { Territory } from "./Territory.js";

/** Props for {@link ActiveList}. */
export interface ActiveListProps {
  /** The board's tasks; only active ones in the selected repo are shown. */
  tasks: WorkspaceTaskT[];
  /** The server-clock "now" in epoch ms, for relative time labels. */
  nowMs: number;
  /** The selected repo, or `null`/`"__all__"` for all repos. */
  selectedRepo: string | null;
}

/** Stable identity for a claim across renders (the payload has no claim id). */
const claimKey = (t: WorkspaceTaskT): string =>
  `${t.agentName}|${t.repo}|${t.createdAt}`;

/** Whether the board is showing all repos (so cards carry a repo tag). */
const isAllRepos = (selected: string | null): boolean =>
  selected === null || selected === "__all__";

/**
 * One active claim's body: intent + territory + a "started N ago" meta line.
 * Shared by the plain card and each row of a grouped card (app.js `claimBody`).
 */
function ClaimBody({
  task,
  nowMs,
}: {
  task: WorkspaceTaskT;
  nowMs: number;
}): ReactElement {
  return (
    <>
      <div className="task__intent">{task.intent}</div>
      <Territory globs={task.pathGlobs} />
      <div className="task__meta">{`started ${formatRelative(task.createdAt, nowMs)}`}</div>
    </>
  );
}

/**
 * A lone agent/claim rendered as the classic single card (app.js `plainCard`):
 * the agent, an optional model/program tag, a live dot, then the claim body.
 */
function PlainCard({
  task,
  nowMs,
  allRepos,
}: {
  task: WorkspaceTaskT;
  nowMs: number;
  allRepos: boolean;
}): ReactElement {
  const tag = task.model || task.program;
  return (
    <div className="task">
      <div className="task__r1">
        <span className="task__who">{task.agentName}</span>
        {allRepos && <span className="task__repo">{task.repo}</span>}
        {tag && <span className="task__tag">{tag}</span>}
        <span className="livedot" title="active" />
      </div>
      <ClaimBody task={task} nowMs={nowMs} />
    </div>
  );
}

/**
 * An agent with multiple live claims rendered grouped (app.js `groupCard`): a
 * header, one `.claim` per primary, and a collapsible `"+N narrower claim(s)"`
 * fold for claims a broader sibling fully covers (folded, never hidden).
 */
function GroupCard({
  group,
  nowMs,
  allRepos,
}: {
  group: ClaimGroup<WorkspaceTaskT>;
  nowMs: number;
  allRepos: boolean;
}): ReactElement {
  const tag = group.model || group.program;
  const total = group.primaries.length + group.narrower.length;
  const n = group.narrower.length;
  return (
    <div className="grp">
      <div className="grp__head">
        <span className="grp__who">{group.agentName}</span>
        {allRepos && <span className="task__repo">{group.repo}</span>}
        {tag && <span className="grp__tag">{tag}</span>}
        <span className="grp__count">{`· ${total} active`}</span>
        <span className="grp__dot" title="live" />
      </div>
      <div className="claims">
        {group.primaries.map((c) => (
          <div key={claimKey(c)} className="claim">
            <ClaimBody task={c} nowMs={nowMs} />
          </div>
        ))}
      </div>
      {n > 0 && (
        <details className="fold">
          <summary>
            <span className="tw">▶</span>
            {` +${n} narrower claim${n > 1 ? "s" : ""}`}
          </summary>
          <div className="fold__body">
            {group.narrower.map((c) => (
              <div key={claimKey(c)} className="claim">
                <ClaimBody task={c} nowMs={nowMs} />
                <div className="covered">⊂ covered by a claim above</div>
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

/**
 * The Active column. Ported from app.js `renderActive`. Filters tasks to active
 * + selected-repo, groups them by agent via {@link groupActiveClaims}, then
 * renders a {@link PlainCard} for a lone claim or a {@link GroupCard} otherwise.
 * Shows an empty-state message when nothing is active. In All-repos mode each
 * card carries a repo tag; in single-repo mode it does not.
 *
 * @param props - The tasks, the server "now", and the repo filter.
 * @returns The active list element.
 */
export function ActiveList({
  tasks,
  nowMs,
  selectedRepo,
}: ActiveListProps): ReactElement {
  const allRepos = isAllRepos(selectedRepo);
  const active = tasks.filter(
    (t) => t.status === "active" && matchesRepo(t, selectedRepo),
  );

  if (active.length === 0) {
    const msg = allRepos
      ? "Nothing active right now."
      : `Nothing active in ${selectedRepo}.`;
    return (
      <div id="active-list">
        <div className="empty">{msg}</div>
      </div>
    );
  }

  return (
    <div id="active-list">
      {groupActiveClaims(active).map((g) => {
        const single = g.primaries.length === 1 && g.narrower.length === 0;
        // Key on the group's newest claim — stable across polls per agent.
        const key = claimKey(g.primaries.concat(g.narrower)[0]);
        return single ? (
          <PlainCard
            key={key}
            task={g.primaries[0]}
            nowMs={nowMs}
            allRepos={allRepos}
          />
        ) : (
          <GroupCard key={key} group={g} nowMs={nowMs} allRepos={allRepos} />
        );
      })}
    </div>
  );
}
