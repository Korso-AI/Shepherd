import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { WorkspaceTaskT } from "@shepherd/shared";
import { ActiveList } from "../../src/components/ActiveList.js";

/**
 * ActiveList: the Active column. Ported from app.js renderActive/plainCard/
 * groupCard/taskTerritory. Asserts plain vs grouped cards, the narrower-claim
 * fold, territory inline-vs-collapsed, and the All-repos repo tag.
 */
const NOW = Date.parse("2026-06-28T12:00:00.000Z");

function task(
  over: Partial<WorkspaceTaskT> & { agentName: string },
): WorkspaceTaskT {
  return {
    agentName: over.agentName,
    program: over.program ?? "claude",
    model: over.model ?? "opus",
    repo: over.repo ?? "korso/a",
    intent: over.intent ?? "doing work",
    pathGlobs: over.pathGlobs ?? ["src/**"],
    status: over.status ?? "active",
    createdAt: over.createdAt ?? "2026-06-28T11:30:00.000Z",
    endedAt: over.endedAt ?? null,
  };
}

describe("ActiveList", () => {
  it("renders a plain card for one agent with a single claim", () => {
    render(
      <ActiveList
        tasks={[
          task({
            agentName: "Abe",
            intent: "refactor auth",
            pathGlobs: ["src/auth/**"],
          }),
        ]}
        nowMs={NOW}
        selectedRepo={"korso/a"}
      />,
    );
    expect(screen.getByText("Abe")).toBeInTheDocument();
    expect(screen.getByText("refactor auth")).toBeInTheDocument();
    expect(screen.getByText("src/auth/**")).toBeInTheDocument();
    // plain card has a livedot, not a group head
    const card = screen.getByText("refactor auth").closest(".task");
    expect(card).not.toBeNull();
    expect(card?.querySelector(".livedot")).not.toBeNull();
  });

  it("filters out non-active tasks and tasks outside the selected repo", () => {
    render(
      <ActiveList
        tasks={[
          task({ agentName: "Abe", intent: "active-here", repo: "korso/a" }),
          task({
            agentName: "Bo",
            intent: "done-task",
            status: "done",
            repo: "korso/a",
          }),
          task({ agentName: "Cy", intent: "other-repo", repo: "korso/b" }),
        ]}
        nowMs={NOW}
        selectedRepo={"korso/a"}
      />,
    );
    expect(screen.getByText("active-here")).toBeInTheDocument();
    expect(screen.queryByText("done-task")).toBeNull();
    expect(screen.queryByText("other-repo")).toBeNull();
  });

  it("groups a broad and a fully-covered claim with a '+1 narrower claim' fold", async () => {
    const user = userEvent.setup();
    const broad = task({
      agentName: "Abe",
      intent: "own the source tree",
      pathGlobs: ["src/**"],
      createdAt: "2026-06-28T11:00:00.000Z",
    });
    const narrow = task({
      agentName: "Abe",
      intent: "tune the auth slice",
      pathGlobs: ["src/auth/login.ts"],
      createdAt: "2026-06-28T11:30:00.000Z",
    });
    render(
      <ActiveList
        tasks={[broad, narrow]}
        nowMs={NOW}
        selectedRepo={"korso/a"}
      />,
    );

    // grouped header shows total active count
    expect(screen.getByText(/2 active/)).toBeInTheDocument();
    // narrower fold present (singular form for 1)
    const fold = screen.getByText(/\+1 narrower claim(?!s)/);
    expect(fold).toBeInTheDocument();

    // The narrower claim's intent lives inside the fold body; expand it.
    const details = fold.closest("details");
    expect(details).not.toBeNull();
    await user.click(
      within(details as HTMLElement).getByText(/narrower claim/),
    );
    expect(screen.getByText("tune the auth slice")).toBeInTheDocument();
    expect(screen.getByText(/covered by a claim above/)).toBeInTheDocument();
  });

  it("renders a single-glob territory inline and a 3-glob territory as a collapsible '3 paths' toggle", async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <ActiveList
        tasks={[task({ agentName: "Solo", pathGlobs: ["only/path.ts"] })]}
        nowMs={NOW}
        selectedRepo={"korso/a"}
      />,
    );
    // single glob — inline, no <details>
    expect(screen.getByText("only/path.ts")).toBeInTheDocument();
    expect(document.querySelector("details.terrx")).toBeNull();

    rerender(
      <ActiveList
        tasks={[
          task({
            agentName: "Solo",
            pathGlobs: ["a/x.ts", "b/y.ts", "c/z.ts"],
          }),
        ]}
        nowMs={NOW}
        selectedRepo={"korso/a"}
      />,
    );
    const toggle = screen.getByText(/3 paths/);
    expect(toggle).toBeInTheDocument();
    const details = toggle.closest("details");
    expect(details).not.toBeNull();
    await user.click(toggle);
    expect(screen.getByText("a/x.ts")).toBeInTheDocument();
    expect(screen.getByText("b/y.ts")).toBeInTheDocument();
    expect(screen.getByText("c/z.ts")).toBeInTheDocument();
  });

  it("shows a repo tag per card in All-repos mode and hides it in single-repo mode", () => {
    const { container, rerender } = render(
      <ActiveList
        tasks={[task({ agentName: "Abe", repo: "korso/a" })]}
        nowMs={NOW}
        selectedRepo={null}
      />,
    );
    expect(container.querySelector(".task__repo")).not.toBeNull();
    expect(screen.getByText("korso/a")).toBeInTheDocument();

    rerender(
      <ActiveList
        tasks={[task({ agentName: "Abe", repo: "korso/a" })]}
        nowMs={NOW}
        selectedRepo={"korso/a"}
      />,
    );
    expect(container.querySelector(".task__repo")).toBeNull();
  });
});
