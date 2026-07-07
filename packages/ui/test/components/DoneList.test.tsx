import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { WorkspaceTaskT } from "@shepherd/shared";
import { DoneList } from "../../src/components/DoneList.js";

/**
 * DoneList: the Done column. Ported from app.js renderDone. Asserts the
 * non-active + repo filter, day-bucket headers, dropped vs done chips/meta, the
 * cumulative-slice paging via onLoadMore, and the All-repos repo tag.
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
    intent: over.intent ?? "did work",
    pathGlobs: over.pathGlobs ?? ["src/**"],
    status: over.status ?? "done",
    createdAt: over.createdAt ?? "2026-06-28T10:00:00.000Z",
    endedAt: over.endedAt ?? "2026-06-28T11:00:00.000Z",
  };
}

describe("DoneList", () => {
  it("renders day-bucket headers (Today / Yesterday)", () => {
    const today = task({
      agentName: "Abe",
      intent: "today task",
      createdAt: "2026-06-28T09:00:00.000Z",
      endedAt: "2026-06-28T10:00:00.000Z",
    });
    const yesterday = task({
      agentName: "Bo",
      intent: "yesterday task",
      createdAt: "2026-06-27T09:00:00.000Z",
      endedAt: "2026-06-27T10:00:00.000Z",
    });
    const { container } = render(
      <DoneList
        tasks={[today, yesterday]}
        nowMs={NOW}
        selectedRepo={"korso/a"}
        doneShown={10}
        onLoadMore={() => {}}
      />,
    );
    const days = [...container.querySelectorAll(".day")].map(
      (d) => d.textContent,
    );
    expect(days).toContain("Today");
    expect(days).toContain("Yesterday");
  });

  it("shows a 'dropped' chip + offline meta for a dropped task and a 'done' chip otherwise", () => {
    const dropped = task({
      agentName: "Abe",
      intent: "dropped task",
      status: "dropped",
      endedAt: "2026-06-28T11:00:00.000Z",
    });
    const done = task({
      agentName: "Bo",
      intent: "done task",
      status: "done",
      createdAt: "2026-06-28T10:30:00.000Z",
      endedAt: "2026-06-28T11:00:00.000Z",
    });
    const { container } = render(
      <DoneList
        tasks={[dropped, done]}
        nowMs={NOW}
        selectedRepo={"korso/a"}
        doneShown={10}
        onLoadMore={() => {}}
      />,
    );
    const droppedCard = screen
      .getByText("dropped task")
      .closest(".task") as HTMLElement;
    const dropChip = within(droppedCard).getByText("dropped");
    expect(dropChip).toHaveClass("task__stat--drop");
    expect(within(droppedCard).getByText(/no done signal/)).toBeInTheDocument();

    const doneCard = screen
      .getByText("done task")
      .closest(".task") as HTMLElement;
    const doneChip = within(doneCard).getByText("done");
    expect(doneChip).not.toHaveClass("task__stat--drop");
    expect(within(doneCard).getByText(/finished/)).toBeInTheDocument();
    expect(within(doneCard).getByText(/active 30m/)).toBeInTheDocument();

    // sanity: only meaningful day headers, no crash
    expect(container.querySelector(".day")).not.toBeNull();
  });

  it("slices to doneShown and reveals the next page via onLoadMore", async () => {
    const user = userEvent.setup();
    const tasks: WorkspaceTaskT[] = Array.from({ length: 12 }, (_, i) =>
      task({
        agentName: `A${i}`,
        intent: `task ${i}`,
        createdAt: `2026-06-28T09:${String(i).padStart(2, "0")}:00.000Z`,
        endedAt: `2026-06-28T10:${String(i).padStart(2, "0")}:00.000Z`,
      }),
    );
    const onLoadMore = vi.fn();
    render(
      <DoneList
        tasks={tasks}
        nowMs={NOW}
        selectedRepo={"korso/a"}
        doneShown={10}
        onLoadMore={onLoadMore}
      />,
    );
    // only 10 of 12 task intents shown
    expect(screen.getAllByText(/^task \d+$/)).toHaveLength(10);
    const more = screen.getByText(/Load older · 10 of 12/);
    expect(more).toBeInTheDocument();
    await user.click(more);
    expect(onLoadMore).toHaveBeenCalledTimes(1);
  });

  it("hides the Load older button when everything fits", () => {
    render(
      <DoneList
        tasks={[task({ agentName: "Abe", intent: "only" })]}
        nowMs={NOW}
        selectedRepo={"korso/a"}
        doneShown={10}
        onLoadMore={() => {}}
      />,
    );
    expect(screen.queryByText(/Load older/)).toBeNull();
  });

  it("filters out active tasks and other repos", () => {
    render(
      <DoneList
        tasks={[
          task({ agentName: "Abe", intent: "done-here", repo: "korso/a" }),
          task({
            agentName: "Bo",
            intent: "still-active",
            status: "active",
            endedAt: null,
            repo: "korso/a",
          }),
          task({ agentName: "Cy", intent: "other-repo", repo: "korso/b" }),
        ]}
        nowMs={NOW}
        selectedRepo={"korso/a"}
        doneShown={10}
        onLoadMore={() => {}}
      />,
    );
    expect(screen.getByText("done-here")).toBeInTheDocument();
    expect(screen.queryByText("still-active")).toBeNull();
    expect(screen.queryByText("other-repo")).toBeNull();
  });

  it("shows a repo tag per card in All-repos mode and hides it in single-repo mode", () => {
    const { container, rerender } = render(
      <DoneList
        tasks={[task({ agentName: "Abe", repo: "korso/a" })]}
        nowMs={NOW}
        selectedRepo={null}
        doneShown={10}
        onLoadMore={() => {}}
      />,
    );
    expect(container.querySelector(".task__repo")).not.toBeNull();

    rerender(
      <DoneList
        tasks={[task({ agentName: "Abe", repo: "korso/a" })]}
        nowMs={NOW}
        selectedRepo={"korso/a"}
        doneShown={10}
        onLoadMore={() => {}}
      />,
    );
    expect(container.querySelector(".task__repo")).toBeNull();
  });
});
