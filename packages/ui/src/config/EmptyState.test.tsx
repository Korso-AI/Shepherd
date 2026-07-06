import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { EmptyState } from "./EmptyState.js";

// ---------------------------------------------------------------------------
// EmptyState — the reusable "no workspace yet" prompt with an optional CTA.
// ---------------------------------------------------------------------------

describe("EmptyState", () => {
  it("renders the default title, copy, and CTA label", () => {
    render(<EmptyState onGetStarted={() => {}} />);
    expect(
      screen.getByRole("heading", { name: /no workspace yet/i }),
    ).toBeInTheDocument();
    expect(screen.getByText(/create a workspace or join one/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /go to config/i })).toBeInTheDocument();
  });

  it("invokes onGetStarted when the CTA is clicked", async () => {
    const onGetStarted = vi.fn();
    render(<EmptyState onGetStarted={onGetStarted} />);
    await userEvent.click(screen.getByRole("button", { name: /go to config/i }));
    expect(onGetStarted).toHaveBeenCalledTimes(1);
  });

  it("honours custom title, copy, and CTA label", () => {
    render(
      <EmptyState title="Nothing here" ctaLabel="Get going" onGetStarted={() => {}}>
        Custom supporting copy.
      </EmptyState>,
    );
    expect(screen.getByRole("heading", { name: "Nothing here" })).toBeInTheDocument();
    expect(screen.getByText("Custom supporting copy.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Get going" })).toBeInTheDocument();
  });

  it("omits the CTA when no handler is supplied", () => {
    render(<EmptyState />);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});
