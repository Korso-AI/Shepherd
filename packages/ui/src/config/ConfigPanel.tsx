import { useState } from "react";
import type { WorkspaceSummaryT } from "@shepherd/shared";
import { GeneralSettings } from "./GeneralSettings.js";
import { Members } from "./Members.js";
import { Invites } from "./Invites.js";
import { ConnectAgent } from "./ConnectAgent.js";

// ---------------------------------------------------------------------------
// ConfigPanel — the Config tab's body: a left sidebar of sections (General ·
// Members · Agent) beside the active section's panel, replacing the old single
// long scroll. Scoping every section to the CURRENT workspace is what let the
// switch/create/join actions move out to the app-bar <WorkspaceSwitcher>.
//
//   • General — workspace name, the caller's role, Leave/Delete workspace, and
//     the account rows (Sign out · Delete account). Account actions live HERE —
//     as ordinary General fields — not as a footer trailing every section.
//   • Members — the roster (admin-gated Remove) + admin-only Invites.
//   • Agent   — mint a token + the copy-paste install command.
//
// Sidebar nav uses aria-current for the active item (a settings-style nav, not
// a formal ARIA tablist). ConfigPanel renders only when a workspace is selected
// — the no-workspace shell shows an EmptyState and steers the user to the
// switcher's "Get started" menu instead.
// ---------------------------------------------------------------------------

type Section = "general" | "members" | "agent";

const SECTIONS: ReadonlyArray<{ id: Section; label: string }> = [
  { id: "general", label: "General" },
  { id: "members", label: "Members" },
  { id: "agent", label: "Agent" },
];

export interface ConfigPanelProps {
  /** The active workspace all sections configure. */
  workspace: WorkspaceSummaryT;
  /** The DIRECT Hub URL embedded in the agent install command. */
  hubUrl?: string;
  /** Bumped by the shell to force the roster to refetch (invite created/redeemed). */
  membersRefreshKey?: number;
  /** Called after an invite is created, so the shell can refresh the roster. */
  onMembersChanged?: () => void;
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
  onLeft,
  onDeleted,
  onLogout,
}: ConfigPanelProps) {
  const [section, setSection] = useState<Section>("general");
  const isAdmin = workspace.role === "admin";

  return (
    <div className="config-layout">
      <nav className="config-nav" aria-label="Configuration sections">
        {SECTIONS.map(({ id, label }) => (
          <button
            key={id}
            type="button"
            className={"config-nav__item" + (section === id ? " config-nav__item--on" : "")}
            aria-current={section === id ? "page" : undefined}
            onClick={() => setSection(id)}
          >
            {label}
          </button>
        ))}
      </nav>

      <div className="config-panel">
        {section === "general" && (
          <GeneralSettings
            workspace={workspace}
            onLeft={onLeft}
            onDeleted={onDeleted}
            onLogout={onLogout}
          />
        )}

        {section === "members" && (
          <>
            <Members
              workspaceId={workspace.id}
              refreshKey={membersRefreshKey}
              canRemove={isAdmin}
            />
            {isAdmin && (
              <Invites workspaceId={workspace.id} onMembersChanged={onMembersChanged} />
            )}
          </>
        )}

        {section === "agent" && <ConnectAgent hubUrl={hubUrl} />}
      </div>
    </div>
  );
}
