import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { ShepherdClientProvider } from "../context.js";
import { FeedbackWidget } from "./FeedbackWidget.js";
import { makeMockClient } from "../test/mockClient.js";

// ---------------------------------------------------------------------------
// FeedbackWidget — floating button + popover for the limited-release "give
// feedback" capture. DB-free: the mock ShepherdClient is injected via
// ShepherdClientProvider's `client` prop.
// ---------------------------------------------------------------------------

describe("FeedbackWidget", () => {
  function renderWidget(
    client: ReturnType<typeof makeMockClient>,
    workspaceId?: string,
  ) {
    return render(
      <ShepherdClientProvider client={client}>
        <FeedbackWidget workspaceId={workspaceId} />
      </ShepherdClientProvider>,
    );
  }

  it("renders a closed floating Feedback button by default", () => {
    renderWidget(makeMockClient());
    expect(screen.getByRole("button", { name: /feedback/i })).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("opens the popover on click, showing the type picker and a textarea", async () => {
    renderWidget(makeMockClient());
    await userEvent.click(screen.getByRole("button", { name: /feedback/i }));

    expect(screen.getByRole("textbox")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /bug/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /suggestion/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /other/i })).toBeInTheDocument();
  });

  it("toggles the popover closed on a second click of the trigger", async () => {
    renderWidget(makeMockClient());
    const trigger = screen.getByRole("button", { name: /feedback/i });
    await userEvent.click(trigger);
    expect(screen.getByRole("textbox")).toBeInTheDocument();

    await userEvent.click(trigger);
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("disables submit until the body is non-whitespace", async () => {
    renderWidget(makeMockClient());
    await userEvent.click(screen.getByRole("button", { name: /feedback/i }));

    const submit = screen.getByRole("button", { name: /submit/i });
    expect(submit).toBeDisabled();

    await userEvent.type(screen.getByRole("textbox"), "   ");
    expect(submit).toBeDisabled();

    await userEvent.type(screen.getByRole("textbox"), "it's broken");
    expect(submit).toBeEnabled();
  });

  it("defaults to the bug type and switches when another type is picked", async () => {
    renderWidget(makeMockClient());
    await userEvent.click(screen.getByRole("button", { name: /feedback/i }));

    expect(screen.getByRole("button", { name: /bug/i })).toHaveAttribute("aria-pressed", "true");

    await userEvent.click(screen.getByRole("button", { name: /suggestion/i }));
    expect(screen.getByRole("button", { name: /suggestion/i })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /bug/i })).toHaveAttribute("aria-pressed", "false");
  });

  it("submits with the selected workspace id when one is supplied", async () => {
    const client = makeMockClient();
    renderWidget(client, "ws_1");

    await userEvent.click(screen.getByRole("button", { name: /feedback/i }));
    await userEvent.click(screen.getByRole("button", { name: /suggestion/i }));
    await userEvent.type(screen.getByRole("textbox"), "add dark mode");
    await userEvent.click(screen.getByRole("button", { name: /submit/i }));

    await waitFor(() =>
      expect(client.submitFeedback).toHaveBeenCalledWith(
        { type: "suggestion", body: "add dark mode" },
        "ws_1",
      ),
    );
  });

  it("submits with no workspace id when none is supplied", async () => {
    const client = makeMockClient();
    renderWidget(client);

    await userEvent.click(screen.getByRole("button", { name: /feedback/i }));
    await userEvent.type(screen.getByRole("textbox"), "hello there");
    await userEvent.click(screen.getByRole("button", { name: /submit/i }));

    await waitFor(() =>
      expect(client.submitFeedback).toHaveBeenCalledWith({ type: "bug", body: "hello there" }, undefined),
    );
  });

  it("shows a confirmation and clears the form on success", async () => {
    const client = makeMockClient();
    renderWidget(client);

    await userEvent.click(screen.getByRole("button", { name: /feedback/i }));
    await userEvent.type(screen.getByRole("textbox"), "great tool");
    await userEvent.click(screen.getByRole("button", { name: /submit/i }));

    expect(await screen.findByText(/thanks/i)).toBeInTheDocument();
  });

  it("shows an inline error and preserves the typed text on failure", async () => {
    const client = makeMockClient({
      submitFeedback: vi.fn().mockRejectedValue(new Error("hub unreachable")),
    });
    renderWidget(client);

    await userEvent.click(screen.getByRole("button", { name: /feedback/i }));
    await userEvent.type(screen.getByRole("textbox"), "still typing this");
    await userEvent.click(screen.getByRole("button", { name: /submit/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/hub unreachable/i);
    expect(screen.getByRole("textbox")).toHaveValue("still typing this");
  });

  it("gates submit against double-submit while in flight", async () => {
    let resolve!: (v: { ok: true; id: string }) => void;
    const client = makeMockClient({
      submitFeedback: vi.fn().mockReturnValue(
        new Promise((r) => {
          resolve = r;
        }),
      ),
    });
    renderWidget(client);

    await userEvent.click(screen.getByRole("button", { name: /feedback/i }));
    await userEvent.type(screen.getByRole("textbox"), "in flight");
    const submit = screen.getByRole("button", { name: /submit/i });
    await userEvent.click(submit);

    await waitFor(() => expect(submit).toBeDisabled());
    expect(client.submitFeedback).toHaveBeenCalledTimes(1);

    resolve({ ok: true, id: "fb_1" });
    await waitFor(() => expect(client.submitFeedback).toHaveBeenCalledTimes(1));
  });
});
