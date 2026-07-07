import type { ReactElement } from "react";
import type { WorkspaceAgentT, WorkspaceTaskT } from "@shepherd/shared";
import { colorForName, initialsFor, matchesRepo } from "../logic.js";

/** Props for {@link Crew}. */
export interface CrewProps {
  /** All known agents; only live ones in the selected repo are shown. */
  agents: WorkspaceAgentT[];
  /** Active/history tasks, used to mark which agents are currently working. */
  tasks: WorkspaceTaskT[];
  /** The selected repo, or `null`/`"__all__"` for all repos. */
  selectedRepo: string | null;
}

/**
 * The crew rail: live agents in the current repo view. Ported from app.js
 * `renderCrew`. An agent is "active" when they own an active task in view;
 * active agents sort first, then alphabetical, and idle (non-active) agents are
 * greyed via `.person--idle`. Each avatar shows {@link initialsFor} on a
 * {@link colorForName} background.
 *
 * @param props - The agents, the tasks that determine activity, and the repo
 *   filter.
 * @returns The crew rail element.
 */
export function Crew({ agents, tasks, selectedRepo }: CrewProps): ReactElement {
  const live = agents.filter(
    (a) =>
      a.presence === "live" &&
      matchesRepo({ repo: a.repo ?? "" }, selectedRepo),
  );

  // An agent is "active" iff they own an active task — mirrors app.js, which
  // builds an intent-by-agent map from the active tasks.
  const activeAgents = new Set<string>();
  for (const t of tasks)
    if (t.status === "active") activeAgents.add(t.agentName);
  const isActive = (a: WorkspaceAgentT): boolean => activeAgents.has(a.name);

  const ordered = [...live].sort((x, y) => {
    const ax = isActive(x);
    const ay = isActive(y);
    if (ax !== ay) return ax ? -1 : 1; // active agents first
    return x.name.localeCompare(y.name);
  });

  return (
    <div className="crew" id="crew">
      {ordered.map((a) => (
        <div
          key={a.name}
          className={"person" + (isActive(a) ? "" : " person--idle")}
        >
          <div className="avatar" style={{ background: colorForName(a.name) }}>
            {initialsFor(a.name)}
          </div>
          <span className="person__name">{a.name}</span>
        </div>
      ))}
    </div>
  );
}
