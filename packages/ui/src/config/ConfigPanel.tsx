import { useState } from "react";
import type { WorkspaceSummaryT } from "@shepherd/shared";
import { WorkspaceSettings } from "./WorkspaceSettings.js";
import { Members } from "./Members.js";
import { Invites } from "./Invites.js";
import { ConnectAgent } from "./ConnectAgent.js";
import { AccountSettings } from "./AccountSettings.js";

// ---------------------------------------------------------------------------
// ConfigPanel — the Config tab's body: a left sidebar of sections beside the
// active section's panel. Each section is scoped to the CURRENT workspace except
// Account, which is account-level:
//
//   • Workspace — workspace name, the caller's role (shown "owner" for the
//     creator), Leave/Delete workspace. (Was "General" — renamed so it reads as
//     workspace-scoped, and the account rows moved out to Account below.)
//   • Members   — the roster (admin-gated Remove, owner-gated role controls +
//     Transfer ownership) + admin-only Invites.
//   • Agent     — mint a token + the copy-paste install command.
//   • Account   — the account rows (Sign out · Delete account), split out of the
//     Workspace tab so account and workspace actions no longer mix.
//
// Sidebar nav uses aria-current for the active item (a settings-style nav, not
// a formal ARIA tablist). ConfigPanel renders only when a workspace is selected
// — the no-workspace shell shows an EmptyState and steers the user to the
// switcher's "Get started" menu instead.
// ---------------------------------------------------------------------------

type Section = "workspace" | "members" | "agent" | "account";

const SECTIONS: ReadonlyArray<{ id: Section; label: string }> = [
  { id: "workspace", label: "Workspace" },
  { id: "members", label: "Members" },
  { id: "agent", label: "Agent" },
  { id: "account", label: "Account" },
];

export interface ConfigPanelProps {
  /** The active workspace all sections configure. */
  workspace: WorkspaceSummaryT;
  /** The DIRECT Hub URL embedded in the agent install command. */
  hubUrl?: string;
  /** Bumped by the shell to force the roster to refetch (invite created/redeemed). */
  membersRefreshKey?: number;
  /** Called after an invite is created or a role changes, so the shell can refresh the roster. */
  onMembersChanged?: () => void;
  /**
   * Called after a change to the caller's OWN standing in the workspace (an
   * ownership transfer flips them owner→admin), so the shell re-lists its
   * workspaces and the "Your role" label + owner-only controls update.
   */
  onWorkspaceChanged?: () => void;
  /** Called after a successful leave, so the shell re-lists its workspaces. */
  onLeft?: () => void;
  /** Called after a successful delete, so the shell re-lists its workspaces. */
  onDeleted?: () => void;
  /**
   * Hosted session logout hook. Shepherd renders the control while the host owns
   * the authentication side effect.
   */
  onLogout?: () => void;
}

export function ConfigPanel({
  workspace,
  hubUrl,
  membersRefreshKey,
  onMembersChanged,
  onWorkspaceChanged,
  onLeft,
  onDeleted,
  onLogout,
}: ConfigPanelProps) {
  const [section, setSection] = useState<Section>("workspace");
  const isAdmin = workspace.role === "admin";

  return (
    <div className="config-layout">
      <nav className="config-nav" aria-label="Configuration sections">
        {SECTIONS.map(({ id, label }) => (
          <button
            key={id}
            type="button"
            className={
              "config-nav__item" +
              (section === id ? " config-nav__item--on" : "")
            }
            aria-current={section === id ? "page" : undefined}
            onClick={() => setSection(id)}
          >
            {label}
          </button>
        ))}
      </nav>

      <div className="config-panel">
        {section === "workspace" && (
          <WorkspaceSettings
            workspace={workspace}
            onLeft={onLeft}
            onDeleted={onDeleted}
          />
        )}

        {section === "members" && (
          <>
            <Members
              workspaceId={workspace.id}
              refreshKey={membersRefreshKey}
              canRemove={isAdmin}
              isOwner={workspace.isOwner}
              onMembersChanged={onMembersChanged}
              onWorkspaceChanged={onWorkspaceChanged}
            />
            {isAdmin && (
              <Invites
                workspaceId={workspace.id}
                onMembersChanged={onMembersChanged}
              />
            )}
          </>
        )}

        {section === "agent" && <ConnectAgent hubUrl={hubUrl} />}

        {section === "account" && <AccountSettings onLogout={onLogout} />}
      </div>
    </div>
  );
}
