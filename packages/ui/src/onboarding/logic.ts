/**
 * Pure stage-derivation for the first-run setup checklist.
 *
 * The checklist must "never block, never mis-hide": a brand-new operator is
 * always guided to create a workspace and connect their first agent, while an
 * established user with a working setup never sees a stray checklist (or a flash
 * of one before the first agent snapshot lands). All of that policy is encoded
 * in {@link deriveSetupStage} so it can be exhaustively unit-tested without a DOM.
 *
 * This module is intentionally free of React, the DOM, and storage access: the
 * caller reads/writes the skip flag (keyed via {@link setupSkipKey}) and passes
 * the resolved facts in. Keeping it pure follows the repo's code-style rule and
 * makes the skip-rule matrix trivially verifiable.
 */

/**
 * Which stage of the setup checklist should render.
 *
 * - `"create"` — the full checklist with "create a workspace" (step 1) active.
 * - `"connect"` — step 1 checked, "connect your first agent" (step 2) active.
 * - `"hidden"` — no checklist renders.
 */
export type SetupStage = "create" | "connect" | "hidden";

/** Facts the caller resolves (from state + storage) to derive the stage. */
interface SetupStageInput {
  /** Whether the operator currently has a workspace. */
  hasWorkspace: boolean;
  /**
   * Whether any agent has ever been seen in this workspace. `null` means the
   * first agent snapshot has not yet loaded — treated as "unknown" so we never
   * flash the checklist at an established user before their agents appear.
   */
  agentsEverSeen: boolean | null;
  /** Whether the operator dismissed the checklist for this workspace. */
  skipped: boolean;
  /** Whether the operator explicitly re-opened the guide (overrides skips). */
  forcedOpen: boolean;
}

/**
 * Decide which setup-checklist stage (if any) should render.
 *
 * `forcedOpen` wins over everything: with no workspace it returns `"create"`,
 * otherwise `"connect"` (the component renders the guide with completed steps
 * checked). When not forced open, the base matrix applies:
 *
 * - no workspace → `"create"`
 * - workspace + `agentsEverSeen === false` + not skipped → `"connect"`
 * - everything else (agents seen, skipped, or the first snapshot still pending
 *   with `agentsEverSeen === null`) → `"hidden"`.
 */
export function deriveSetupStage(input: SetupStageInput): SetupStage {
  const { hasWorkspace, agentsEverSeen, skipped, forcedOpen } = input;

  if (forcedOpen) {
    return hasWorkspace ? "connect" : "create";
  }

  if (!hasWorkspace) {
    return "create";
  }

  if (agentsEverSeen === false && !skipped) {
    return "connect";
  }

  return "hidden";
}

/**
 * Storage key for the per-workspace "setup dismissed" flag.
 *
 * Namespaced by workspace id so dismissing setup in one workspace never hides
 * the checklist in another.
 */
export function setupSkipKey(workspaceId: string): string {
  return "shepherd.setup.skipped." + workspaceId;
}
