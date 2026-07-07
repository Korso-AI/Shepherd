import { describe, it, expect } from "vitest";
import { canonicalizeRepo, normalizeRemoteUrl } from "../src/repo.js";

describe("canonicalizeRepo", () => {
  // Every spelling of the same repo must reduce to the same bare, lowercased
  // name — this is the coordination key, and divergence silently splits a team.
  it.each([
    ["git@github.com:Org/App.git", "app"],
    ["https://github.com/Org/App", "app"],
    ["https://github.com/Org/App.git", "app"],
    ["Org/App", "app"],
    ["App", "app"],
    ["app", "app"],
    // Nested groups (e.g. GitLab subgroups) still reduce to the trailing name.
    ["https://gitlab.com/group/sub/App.git", "app"],
    ["  Org/App  ", "app"],
  ])("canonicalizes %j -> %j", (input, expected) => {
    expect(canonicalizeRepo(input)).toBe(expected);
  });

  it("is idempotent on an already-canonical bare name", () => {
    expect(
      canonicalizeRepo(canonicalizeRepo("git@github.com:Acme/widgets.git")),
    ).toBe("widgets");
  });

  it("converges an origin clone and a no-origin basename clone on one key", () => {
    expect(canonicalizeRepo("Acme/widgets")).toBe(canonicalizeRepo("widgets"));
  });
});

describe("normalizeRemoteUrl", () => {
  it.each([
    ["https://github.com/Org/App.git", "Org/App"],
    ["git@github.com:Org/App.git", "Org/App"],
    ["https://gitlab.com/group/sub/App.git", "sub/App"],
  ])("reduces %j -> %j", (input, expected) => {
    expect(normalizeRemoteUrl(input)).toBe(expected);
  });

  it("returns null when there is no owner/repo pair", () => {
    expect(normalizeRemoteUrl("App")).toBeNull();
    expect(normalizeRemoteUrl("")).toBeNull();
  });
});
