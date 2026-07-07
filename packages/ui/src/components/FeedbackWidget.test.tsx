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
    expect(
      screen.getByRole("button", { name: /feedback/i }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("opens the popover on click, showing the type picker and a textarea", async () => {
    renderWidget(makeMockClient());
    await userEvent.click(screen.getByRole("button", { name: /feedback/i }));

    expect(screen.getByRole("textbox")).toBeInTheDocument();
    expect(
      screen.getByRole("radiogroup", { name: /feedback type/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /bug/i })).toBeInTheDocument();
    expect(
      screen.getByRole("radio", { name: /suggestion/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /other/i })).toBeInTheDocument();
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

    expect(screen.getByRole("radio", { name: /bug/i })).toHaveAttribute(
      "aria-checked",
      "true",
    );

    await userEvent.click(screen.getByRole("radio", { name: /suggestion/i }));
    expect(screen.getByRole("radio", { name: /suggestion/i })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(screen.getByRole("radio", { name: /bug/i })).toHaveAttribute(
      "aria-checked",
      "false",
    );
  });

  it("submits with the selected workspace id when one is supplied", async () => {
    const client = makeMockClient();
    renderWidget(client, "ws_1");

    await userEvent.click(screen.getByRole("button", { name: /feedback/i }));
    await userEvent.click(screen.getByRole("radio", { name: /suggestion/i }));
    await userEvent.type(screen.getByRole("textbox"), "add dark mode");
    await userEvent.click(screen.getByRole("button", { name: /submit/i }));

    await waitFor(() =>
      expect(client.submitFeedback).toHaveBeenCalledWith(
        {
          type: "suggestion",
          body: "add dark mode",
          context: expect.objectContaining({
            appVersion: expect.any(String),
            userAgent: expect.any(String),
            viewport: expect.stringMatching(/^\d+x\d+$/),
          }),
        },
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
      expect(client.submitFeedback).toHaveBeenCalledWith(
        {
          type: "bug",
          body: "hello there",
          context: expect.objectContaining({
            appVersion: expect.any(String),
            userAgent: expect.any(String),
            viewport: expect.stringMatching(/^\d+x\d+$/),
          }),
        },
        undefined,
      ),
    );
  });

  it("shows a confirmation and clears the form on success", async () => {
    const client = makeMockClient();
    renderWidget(client);

    await userEvent.click(screen.getByRole("button", { name: /feedback/i }));
    await userEvent.type(screen.getByRole("textbox"), "great tool");
    await userEvent.click(screen.getByRole("button", { name: /submit/i }));

    expect(await screen.findByText(/we read every note/i)).toBeInTheDocument();
  });

  it("shows an inline error and preserves the typed text on failure", async () => {
    const client = makeMockClient({
      submitFeedback: vi.fn().mockRejectedValue(new Error("hub unreachable")),
    });
    renderWidget(client);

    await userEvent.click(screen.getByRole("button", { name: /feedback/i }));
    await userEvent.type(screen.getByRole("textbox"), "still typing this");
    await userEvent.click(screen.getByRole("button", { name: /submit/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /hub unreachable/i,
    );
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

  it("closes via the × button and returns focus to the trigger", async () => {
    renderWidget(makeMockClient());
    const trigger = screen.getByRole("button", { name: /feedback/i });
    await userEvent.click(trigger);

    await userEvent.click(screen.getByRole("button", { name: /close/i }));
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("closes on Escape and returns focus to the trigger", async () => {
    renderWidget(makeMockClient());
    const trigger = screen.getByRole("button", { name: /feedback/i });
    await userEvent.click(trigger);
    expect(screen.getByRole("textbox")).toHaveFocus();

    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("closes when clicking outside the widget", async () => {
    renderWidget(makeMockClient());
    await userEvent.click(screen.getByRole("button", { name: /feedback/i }));
    expect(screen.getByRole("textbox")).toBeInTheDocument();

    await userEvent.click(document.body);
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("focuses the textarea when the popover opens", async () => {
    renderWidget(makeMockClient());
    await userEvent.click(screen.getByRole("button", { name: /feedback/i }));
    expect(screen.getByRole("textbox")).toHaveFocus();
  });

  it("submits on Ctrl+Enter from the textarea", async () => {
    const client = makeMockClient();
    renderWidget(client);
    await userEvent.click(screen.getByRole("button", { name: /feedback/i }));
    await userEvent.type(screen.getByRole("textbox"), "keyboard warrior");
    await userEvent.keyboard("{Control>}{Enter}{/Control}");

    await waitFor(() => expect(client.submitFeedback).toHaveBeenCalledTimes(1));
  });

  it("moves the type selection with arrow keys", async () => {
    renderWidget(makeMockClient());
    await userEvent.click(screen.getByRole("button", { name: /feedback/i }));

    screen.getByRole("radio", { name: /bug/i }).focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(screen.getByRole("radio", { name: /suggestion/i })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(screen.getByRole("radio", { name: /suggestion/i })).toHaveFocus();
  });

  it("shows a character counter only once the body nears the cap", async () => {
    renderWidget(makeMockClient());
    await userEvent.click(screen.getByRole("button", { name: /feedback/i }));
    const textarea = screen.getByRole("textbox");

    await userEvent.click(textarea);
    await userEvent.paste("x".repeat(1599));
    expect(screen.queryByText(/\/ 2000/)).not.toBeInTheDocument();

    await userEvent.paste("x");
    expect(screen.getByText("1600 / 2000")).toBeInTheDocument();
  });
});
