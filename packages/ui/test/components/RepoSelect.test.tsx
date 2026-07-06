import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RepoSelect } from "../../src/components/RepoSelect.js";

/**
 * RepoSelect: the click-to-open repo filter. Ported from app.js renderRepoSelect.
 * Asserts the <2-repo hiding rule, the listbox/option roles + aria, the per-repo
 * "N active · N done" counts, and that choosing an option (incl. "All repos" ->
 * null) calls onSelect with the app.js-compatible value.
 */
describe("RepoSelect", () => {
  const counts = {
    "korso/a": { active: 2, done: 5 },
    "korso/b": { active: 1, done: 0 },
    __all__: { active: 3, done: 5 },
  };

  it("is absent when there are fewer than 2 repos", () => {
    const { container } = render(
      <RepoSelect repos={["korso/a"]} counts={counts} selected={null} onSelect={() => {}} />,
    );
    // Nothing rendered (no trigger button) — host hidden with a single repo.
    expect(container.querySelector("button")).toBeNull();
  });

  it("renders a trigger with two repos and exposes listbox roles when opened", async () => {
    const user = userEvent.setup();
    render(
      <RepoSelect
        repos={["korso/a", "korso/b"]}
        counts={counts}
        selected={null}
        onSelect={() => {}}
      />,
    );
    const trig = screen.getByRole("button", { name: /filter by repo/i });
    expect(trig).toHaveAttribute("aria-haspopup", "listbox");
    expect(trig).toHaveAttribute("aria-expanded", "false");

    await user.click(trig);
    expect(trig).toHaveAttribute("aria-expanded", "true");

    const listbox = screen.getByRole("listbox");
    const options = within(listbox).getAllByRole("option");
    // two repos + the trailing "All repos" option
    expect(options).toHaveLength(3);
    expect(within(listbox).getByText("korso/a")).toBeInTheDocument();
    expect(within(listbox).getByText("2 active · 5 done")).toBeInTheDocument();
    expect(within(listbox).getByText("All repos")).toBeInTheDocument();
    // "All repos" carries the aggregate counts row
    expect(within(listbox).getByText("3 active · 5 done")).toBeInTheDocument();
  });

  it("marks the selected repo option aria-selected", async () => {
    const user = userEvent.setup();
    render(
      <RepoSelect
        repos={["korso/a", "korso/b"]}
        counts={counts}
        selected={"korso/b"}
        onSelect={() => {}}
      />,
    );
    await user.click(screen.getByRole("button", { name: /filter by repo/i }));
    const opt = screen.getByRole("option", { name: /korso\/b/ });
    expect(opt).toHaveAttribute("aria-selected", "true");
  });

  it("calls onSelect with the repo string when a repo is chosen", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(
      <RepoSelect
        repos={["korso/a", "korso/b"]}
        counts={counts}
        selected={null}
        onSelect={onSelect}
      />,
    );
    await user.click(screen.getByRole("button", { name: /filter by repo/i }));
    await user.click(screen.getByRole("option", { name: /korso\/a/ }));
    expect(onSelect).toHaveBeenCalledWith("korso/a");
  });

  it("calls onSelect with null (All repos = __all__) when All repos is chosen", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(
      <RepoSelect
        repos={["korso/a", "korso/b"]}
        counts={counts}
        selected={"korso/a"}
        onSelect={onSelect}
      />,
    );
    await user.click(screen.getByRole("button", { name: /filter by repo/i }));
    await user.click(screen.getByRole("option", { name: /All repos/ }));
    expect(onSelect).toHaveBeenCalledWith(null);
  });

  it("closes the menu on Escape", async () => {
    const user = userEvent.setup();
    render(
      <RepoSelect
        repos={["korso/a", "korso/b"]}
        counts={counts}
        selected={null}
        onSelect={() => {}}
      />,
    );
    const trig = screen.getByRole("button", { name: /filter by repo/i });
    await user.click(trig);
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(trig).toHaveAttribute("aria-expanded", "false");
  });
});
