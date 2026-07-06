import { useCallback, useRef, useState } from "react";
import type { WorkspaceLandscapeResponseT } from "@shepherd/shared";
import { readStored, writeStored } from "../storage.js";
import { deriveSetupStage, setupSkipKey, type SetupStage } from "./logic.js";

// ---------------------------------------------------------------------------
// useSetupStage — the Dashboard's first-run checklist policy, in one hook.
//
// Owns the in-memory flags (`forcedOpen`, the `engaged` latch), the persisted
// per-workspace skip (read ONCE per workspace, not per render — the board
// re-renders every second on the freshness tick), and the stage derivation.
// All policy stays in the pure `deriveSetupStage`; this hook only resolves the
// facts and hands them in.
//
// Two correctness rules live here rather than in the caller:
//
//  1. Stale-snapshot gating. `useLandscapePolling` retains the last-good
//     snapshot across a `workspaceId` switch so the board never blanks — but
//     the checklist must never derive its stage from ANOTHER workspace's
//     agents (a switch could flash the checklist over an established board, or
//     name the previous workspace's agent). A snapshot only counts when
//     `snapshotWorkspaceId` matches the current `workspaceId`; otherwise
//     `agentsEverSeen` is `null` ("unknown"), which derives `"hidden"`.
//
//  2. Render-time reset. The Dashboard stays mounted across workspace
//     switches, so the flags reset synchronously during the first render with
//     the new `workspaceId` (React's "adjust state when a prop changes"
//     pattern) — never an effect, which would commit one wrong frame first.
// ---------------------------------------------------------------------------

/** Facts the hook needs from the caller each render. */
export interface UseSetupStageOptions {
  /** Whether this is the hosted shell (self-host never shows the checklist). */
  hosted: boolean;
  /** Whether the account currently has a workspace. */
  hasWorkspace: boolean;
  /** The selected workspace id (undefined with no workspace). */
  workspaceId: string | undefined;
  /** The polling hook's last-good snapshot. */
  snapshot: WorkspaceLandscapeResponseT | null;
  /** Which workspace that snapshot was fetched for (stale-snapshot gate). */
  snapshotWorkspaceId: string | undefined;
}

/** The checklist policy surface {@link useSetupStage} returns. */
export interface SetupStageApi {
  /** The stage to render this frame (see {@link deriveSetupStage}). */
  stage: SetupStage;
  /** Re-open the guide (the header "Setup guide" button). Overrides skips. */
  openSetupGuide: () => void;
  /** Dismiss the guide; persists the skip for the current workspace. */
  skip: () => void;
  /**
   * Record that the checklist just created a workspace, so the guide stays
   * engaged (at the connect step) across the switch onto the new workspace —
   * without this the post-create re-list would reset the flags and the
   * checklist would vanish until the new workspace's first poll lands.
   */
  noteWorkspaceCreated: () => void;
}

interface Flags {
  /** The workspace these flags belong to (render-time reset key). */
  workspaceId: string | undefined;
  /** Guide explicitly re-opened; wins over skips. */
  forcedOpen: boolean;
  /**
   * The guide has been visible this session for THIS workspace — once
   * engaged it holds at "connect" (through the post-create snapshot gap and
   * the first agent check-in) until the operator dismisses it.
   */
  engaged: boolean;
  /** The operator dismissed the guide (persisted copy read once, then state). */
  skipped: boolean;
}

/** The persisted skip for a workspace (false with no workspace to key by). */
function readSkip(workspaceId: string | undefined): boolean {
  return workspaceId ? readStored(setupSkipKey(workspaceId)) !== null : false;
}

export function useSetupStage(opts: UseSetupStageOptions): SetupStageApi {
  const { hosted, hasWorkspace, workspaceId, snapshot, snapshotWorkspaceId } =
    opts;

  // Set (and cleared) when the checklist reports a successful create, consumed
  // by the reset below so the NEW workspace starts engaged. A ref: it must
  // survive into the reset without itself scheduling a render.
  const createdPending = useRef(false);

  const [flags, setFlags] = useState<Flags>(() => ({
    workspaceId,
    forcedOpen: false,
    engaged: false,
    skipped: readSkip(workspaceId),
  }));

  // Render-time reset on workspace switch: no stale-flag frame, and the
  // persisted skip is re-read exactly once per workspace.
  if (flags.workspaceId !== workspaceId) {
    setFlags({
      workspaceId,
      forcedOpen: false,
      engaged: createdPending.current,
      skipped: readSkip(workspaceId),
    });
    createdPending.current = false;
  }

  const snapshotIsCurrent =
    snapshot !== null && snapshotWorkspaceId === workspaceId;

  const stage: SetupStage = hosted
    ? deriveSetupStage({
        hasWorkspace,
        agentsEverSeen: snapshotIsCurrent ? snapshot.agents.length > 0 : null,
        skipped: flags.skipped,
        forcedOpen: flags.forcedOpen,
        engaged: flags.engaged,
      })
    : "hidden";

  // Latch engagement the first render a stage is visible (converges in one
  // extra render pass). Once engaged, the guide never self-hides mid-flow —
  // the operator sees step 2 complete and leaves on their own terms.
  if (stage !== "hidden" && !flags.engaged) {
    setFlags((f) => ({ ...f, engaged: true }));
  }

  const openSetupGuide = useCallback(() => {
    setFlags((f) => ({ ...f, forcedOpen: true }));
  }, []);

  const skip = useCallback(() => {
    if (workspaceId) writeStored(setupSkipKey(workspaceId), "1");
    // `skipped` also flips in state so the dismissal holds this session even
    // where localStorage writes silently fail (private/quota modes).
    setFlags((f) => ({ ...f, forcedOpen: false, engaged: false, skipped: true }));
  }, [workspaceId]);

  const noteWorkspaceCreated = useCallback(() => {
    createdPending.current = true;
  }, []);

  return { stage, openSetupGuide, skip, noteWorkspaceCreated };
}
