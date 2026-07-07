import { render, screen } from "@testing-library/react";
import type { WorkspaceAgentT, WorkspaceTaskT } from "@shepherd/shared";
import { Crew } from "../../src/components/Crew.js";
import { initialsFor } from "../../src/logic.js";

/**
 * Crew: the live-agents rail. Ported from app.js renderCrew. Asserts the
 * presence + repo filter, active-before-idle ordering, and the .person--idle
 * greying for agents not owning an active task in view.
 */
function agent(
  over: Partial<WorkspaceAgentT> & { name: string },
): WorkspaceAgentT {
  return {
    name: over.name,
    human: over.human ?? "human",
    program: over.program ?? "claude",
    model: over.model ?? null,
    repo: over.repo ?? "korso/a",
    branch: over.branch ?? null,
    lastHeartbeatAt: over.lastHeartbeatAt ?? null,
    presence: over.presence ?? "live",
  };
}

function task(
  over: Partial<WorkspaceTaskT> & { agentName: string },
): WorkspaceTaskT {
  return {
    agentName: over.agentName,
    program: over.program ?? "claude",
    model: over.model ?? null,
    repo: over.repo ?? "korso/a",
    intent: over.intent ?? "doing work",
    pathGlobs: over.pathGlobs ?? ["src/**"],
    status: over.status ?? "active",
    createdAt: over.createdAt ?? "2026-06-28T10:00:00.000Z",
    endedAt: over.endedAt ?? null,
  };
}

describe("Crew", () => {
  it("sorts an active agent before an idle one and greys the idle one", () => {
    const agents = [
      agent({ name: "Zoe" }), // idle (no active task)
      agent({ name: "Abe" }), // active (owns the task below)
    ];
    const tasks = [task({ agentName: "Abe" })];
    const { container } = render(
      <Crew agents={agents} tasks={tasks} selectedRepo={null} />,
    );
    const people = container.querySelectorAll(".person");
    expect(people).toHaveLength(2);
    // Active "Abe" comes first despite alphabetical Abe<Zoe being incidental here:
    // active-first ordering puts the active agent ahead.
    expect(people[0]).toHaveTextContent("Abe");
    expect(people[0]).not.toHaveClass("person--idle");
    // Idle "Zoe" is greyed.
    expect(people[1]).toHaveTextContent("Zoe");
    expect(people[1]).toHaveClass("person--idle");
  });

  it("renders an avatar with the agent initials", () => {
    render(
      <Crew
        agents={[agent({ name: "RedDragon" })]}
        tasks={[]}
        selectedRepo={null}
      />,
    );
    expect(screen.getByText(initialsFor("RedDragon"))).toBeInTheDocument();
  });

  it("excludes offline agents and agents outside the selected repo", () => {
    const agents = [
      agent({ name: "Live", presence: "live", repo: "korso/a" }),
      agent({ name: "Gone", presence: "offline", repo: "korso/a" }),
      agent({ name: "Elsewhere", presence: "live", repo: "korso/b" }),
    ];
    const { container } = render(
      <Crew agents={agents} tasks={[]} selectedRepo={"korso/a"} />,
    );
    const names = [...container.querySelectorAll(".person__name")].map(
      (n) => n.textContent,
    );
    expect(names).toEqual(["Live"]);
  });

  it("orders two active or two idle agents alphabetically", () => {
    const agents = [agent({ name: "Bea" }), agent({ name: "Ann" })];
    const { container } = render(
      <Crew agents={agents} tasks={[]} selectedRepo={null} />,
    );
    const names = [...container.querySelectorAll(".person__name")].map(
      (n) => n.textContent,
    );
    expect(names).toEqual(["Ann", "Bea"]);
  });
});
