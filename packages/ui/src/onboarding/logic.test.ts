/**
 * Exhaustive stage-derivation matrix for the setup checklist.
 *
 * The behavioral invariant lives here: "never block, never mis-hide". These
 * tests pin every input-tuple outcome so the pure `deriveSetupStage` can be
 * trusted by the hook that reads/writes storage.
 */

import { describe, it, expect } from "vitest";
import { deriveSetupStage, setupSkipKey, type SetupStage } from "./logic.js";

type Input = Parameters<typeof deriveSetupStage>[0];

const input = (
  hasWorkspace: boolean,
  agentsEverSeen: boolean | null,
  skipped: boolean,
  forcedOpen: boolean,
  engaged = false,
): Input => ({ hasWorkspace, agentsEverSeen, skipped, forcedOpen, engaged });

describe("deriveSetupStage", () => {
  describe("named scenarios", () => {
    it("no workspace → create (full checklist, step 1 active)", () => {
      expect(deriveSetupStage(input(false, null, false, false))).toBe("create");
    });

    it("workspace + agents never seen + not skipped → connect (invited user)", () => {
      expect(deriveSetupStage(input(true, false, false, false))).toBe("connect");
    });

    it("workspace + agents seen → hidden (returning user with working setup)", () => {
      expect(deriveSetupStage(input(true, true, false, false))).toBe("hidden");
    });

    it("workspace + no agents + skipped → hidden", () => {
      expect(deriveSetupStage(input(true, false, true, false))).toBe("hidden");
    });

    it("workspace + no agents + skipped + forcedOpen → connect", () => {
      expect(deriveSetupStage(input(true, false, true, true))).toBe("connect");
    });

    it("workspace + first snapshot pending (null) → hidden (no flash for established users)", () => {
      expect(deriveSetupStage(input(true, null, false, false))).toBe("hidden");
    });

    it("engaged holds connect across the post-create snapshot gap (agents null)", () => {
      expect(deriveSetupStage(input(true, null, false, false, true))).toBe("connect");
    });

    it("engaged holds connect after the first agent checks in (agents seen)", () => {
      expect(deriveSetupStage(input(true, true, false, false, true))).toBe("connect");
    });

    it("skip beats engaged: dismissing an engaged guide hides it", () => {
      expect(deriveSetupStage(input(true, true, true, false, true))).toBe("hidden");
      expect(deriveSetupStage(input(true, false, true, false, true))).toBe("hidden");
    });

    it("engaged with no workspace still derives create (never block)", () => {
      expect(deriveSetupStage(input(false, null, false, false, true))).toBe("create");
    });
  });

  describe("full 4-tuple matrix (engaged=false)", () => {
    // [hasWorkspace, agentsEverSeen, skipped, forcedOpen] → expected
    const cases: Array<[boolean, boolean | null, boolean, boolean, SetupStage]> = [
      // forcedOpen = false ---------------------------------------------------
      // no workspace always → create (never block signup)
      [false, null, false, false, "create"],
      [false, null, true, false, "create"],
      [false, false, false, false, "create"],
      [false, false, true, false, "create"],
      [false, true, false, false, "create"],
      [false, true, true, false, "create"],
      // workspace + agents pending (null) → hidden (avoid flash)
      [true, null, false, false, "hidden"],
      [true, null, true, false, "hidden"],
      // workspace + agents never seen: connect unless skipped
      [true, false, false, false, "connect"],
      [true, false, true, false, "hidden"],
      // workspace + agents seen → hidden regardless of skip
      [true, true, false, false, "hidden"],
      [true, true, true, false, "hidden"],

      // forcedOpen = true ----------------------------------------------------
      // no workspace → create regardless of everything else
      [false, null, false, true, "create"],
      [false, null, true, true, "create"],
      [false, false, false, true, "create"],
      [false, false, true, true, "create"],
      [false, true, false, true, "create"],
      [false, true, true, true, "create"],
      // workspace → connect regardless of agents/skipped
      [true, null, false, true, "connect"],
      [true, null, true, true, "connect"],
      [true, false, false, true, "connect"],
      [true, false, true, true, "connect"],
      [true, true, false, true, "connect"],
      [true, true, true, true, "connect"],
    ];

    for (const [hasWorkspace, agentsEverSeen, skipped, forcedOpen, expected] of cases) {
      it(`{hasWorkspace:${hasWorkspace}, agentsEverSeen:${agentsEverSeen}, skipped:${skipped}, forcedOpen:${forcedOpen}} → ${expected}`, () => {
        expect(deriveSetupStage(input(hasWorkspace, agentsEverSeen, skipped, forcedOpen))).toBe(
          expected,
        );
      });
    }
  });

  describe("full matrix with engaged=true", () => {
    // engaged only changes outcomes for a workspace that is NOT skipped and
    // NOT already connect: those rows hold at "connect" instead of "hidden".
    // Skips still win; no-workspace still always derives "create".
    const cases: Array<[boolean, boolean | null, boolean, boolean, SetupStage]> = [
      [false, null, false, false, "create"],
      [false, null, true, false, "create"],
      [false, true, false, true, "create"],
      [true, null, false, false, "connect"],
      [true, null, true, false, "hidden"],
      [true, false, false, false, "connect"],
      [true, false, true, false, "hidden"],
      [true, true, false, false, "connect"],
      [true, true, true, false, "hidden"],
      [true, true, true, true, "connect"], // forcedOpen beats skip
    ];

    for (const [hasWorkspace, agentsEverSeen, skipped, forcedOpen, expected] of cases) {
      it(`engaged {hasWorkspace:${hasWorkspace}, agentsEverSeen:${agentsEverSeen}, skipped:${skipped}, forcedOpen:${forcedOpen}} → ${expected}`, () => {
        expect(
          deriveSetupStage(input(hasWorkspace, agentsEverSeen, skipped, forcedOpen, true)),
        ).toBe(expected);
      });
    }
  });
});

describe("setupSkipKey", () => {
  it("namespaces the skip flag by workspace id", () => {
    expect(setupSkipKey("ws_123")).toBe("shepherd.setup.skipped.ws_123");
  });

  it("produces distinct keys per workspace", () => {
    expect(setupSkipKey("a")).not.toBe(setupSkipKey("b"));
  });
});
