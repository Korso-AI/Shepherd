import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import * as rootEntry from "../src/index.js";
import * as selfhostEntry from "../src/selfhost.js";

/**
 * Smoke test proving the jsdom + React Testing Library + jest-dom matcher
 * toolchain is wired and that `.tsx` suites are collected by the "ui" project.
 * If any leg (jsdom env, RTL render, jest-dom matcher, .tsx collection) is
 * misconfigured, this fails — making it a canary for the whole UI test setup.
 */
describe("ui test harness", () => {
  it("renders a component into the jsdom document", () => {
    render(<p>shepherd wallboard</p>);
    expect(screen.getByText("shepherd wallboard")).toBeInTheDocument();
  });
});

/**
 * Public entry surface. The `.` entry is the auth-agnostic hosted surface: it
 * exposes the client factory/provider, the hosted shell + config screens, the
 * board, and the error helper — but NEVER {@link SelfHostApp} (the token-gated
 * self-host root), which is the named exception behind `./selfhost` only.
 */
describe("public entry exports", () => {
  it("exports the auth-agnostic hosted surface from `.`", () => {
    // Client factory + provider/hook for consumers wiring their own auth.
    expect(typeof rootEntry.createShepherdClient).toBe("function");
    expect(typeof rootEntry.ShepherdClientError).toBe("function");
    expect(typeof rootEntry.describeError).toBe("function");
    expect(typeof rootEntry.ShepherdClientProvider).toBe("function");
    expect(typeof rootEntry.useShepherdClient).toBe("function");

    // The hosted shell + the board it routes to.
    expect(typeof rootEntry.ShepherdRoot).toBe("function");
    expect(typeof rootEntry.Dashboard).toBe("function");

    // The composable config screens.
    expect(typeof rootEntry.ConfigPanel).toBe("function");
    expect(typeof rootEntry.WorkspaceSwitcher).toBe("function");
    expect(typeof rootEntry.WorkspaceSettings).toBe("function");
    expect(typeof rootEntry.AccountSettings).toBe("function");
    expect(typeof rootEntry.Members).toBe("function");
    expect(typeof rootEntry.Invites).toBe("function");
    expect(typeof rootEntry.ConnectAgent).toBe("function");
    expect(typeof rootEntry.EmptyState).toBe("function");
  });

  it("does NOT export SelfHostApp from `.` (it is the token-handling exception)", () => {
    expect("SelfHostApp" in rootEntry).toBe(false);
  });

  it("exports SelfHostApp from `./selfhost` only", () => {
    expect(typeof selfhostEntry.SelfHostApp).toBe("function");
  });
});
