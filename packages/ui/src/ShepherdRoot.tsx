import { useCallback, useEffect, useState, type ReactNode } from "react";
import type { WorkspaceSummaryT } from "@shepherd/shared";
import { Dashboard } from "./components/Dashboard.js";
import { WorkspaceSwitcher } from "./config/WorkspaceSwitcher.js";
import {
  ConfigPanel,
  type ExtraConfigSection,
} from "./config/ConfigPanel.js";
import { AccountSettings } from "./config/AccountSettings.js";
import { useShepherdClient } from "./context.js";
import { describeError } from "./client.js";

// ---------------------------------------------------------------------------
// ShepherdRoot — the mountable hosted application shell.
//
// It is purely a DATA + COMPOSITION layer: it loads the account's workspaces,
// tracks the selected one, and builds two hosted-shell nodes for <Dashboard>:
//   • `switcher` — the app-bar <WorkspaceSwitcher>, shown on every tab so the
//     active workspace is always visible and switch/create/join have one home.
//   • `config`  — the <ConfigPanel> sidebar (General · Members · Agent), scoped
//     to the selected workspace, rendered in the third peer Config tab.
// The flat tab strip (Tasks | Chat | Config) and all board chrome live in
// <Dashboard>; ShepherdRoot renders no header or tabs of its own.
//
// Landing: a brand-new account with no workspace lands on Tasks showing the
// first-run setup checklist — decided inside <Dashboard> from `hasWorkspace`,
// which also keeps the no-workspace board from polling. With no workspace the
// switcher degrades to a "Get started" menu (create/join) and the Config tab
// shows a prompt instead of the sidebar. It reads its data through
// useShepherdClient() (provided by the host), so it stays auth-agnostic.
// ---------------------------------------------------------------------------

export interface ShepherdRootProps {
  /**
   * Optional host brand node for the dashboard header (e.g. the Korso product
   * switcher). Replaces the default "Shepherd" title when supplied.
   */
  brand?: ReactNode;
  /**
   * The DIRECT Hub URL embedded in the agent install command (planning decision
   * #2: the headless agent connects straight to the Hub, not the BFF). Defaults
   * to the client's baseUrl, which is correct for self-host.
   */
  hubUrl?: string;
  /**
   * Hosted session logout hook. The embedding frontend/BFF owns cookies,
   * session state, and OIDC cleanup; Shepherd only renders the Config action.
   */
  onLogout?: () => void;
  /**
   * Embedder-provided settings sections, appended after the built-in
   * ConfigPanel sections and scoped to the selected workspace.
   */
  extraSections?: ReadonlyArray<ExtraConfigSection>;
}

type LoadState =
  | { status: "loading" }
  | { status: "ready"; workspaces: WorkspaceSummaryT[] }
  | { status: "error"; message: string };

export function ShepherdRoot({
  brand,
  hubUrl,
  onLogout,
  extraSections,
}: ShepherdRootProps) {
  const client = useShepherdClient();

  const [load, setLoad] = useState<LoadState>({ status: "loading" });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Bumped whenever a mutation may have changed the selected workspace's
  // roster (an invite created, a code redeemed), so <Members> refetches.
  const [membersRefreshKey, setMembersRefreshKey] = useState(0);

  // Loads the workspace list and keeps the selection valid: a still-present
  // selection is preserved (so a create/join refresh never yanks the user off
  // their current workspace), otherwise it falls back to the first workspace.
  const fetchWorkspaces = useCallback(async () => {
    try {
      const res = await client.listWorkspaces();
      setLoad({ status: "ready", workspaces: res.workspaces });
      setSelectedId((prev) =>
        prev && res.workspaces.some((w) => w.id === prev)
          ? prev
          : (res.workspaces[0]?.id ?? null),
      );
    } catch (err) {
      setLoad({ status: "error", message: describeError(err) });
    }
  }, [client]);

  useEffect(() => {
    void fetchWorkspaces();
  }, [fetchWorkspaces]);

  const workspaces = load.status === "ready" ? load.workspaces : [];
  const selected = workspaces.find((w) => w.id === selectedId) ?? null;

  if (load.status === "loading") {
    return (
      <div className="shepherd-root">
        <p role="status">Loading…</p>
      </div>
    );
  }

  if (load.status === "error") {
    return (
      <div className="shepherd-root">
        <p role="alert">{load.message}</p>
      </div>
    );
  }

  const hasWorkspace = workspaces.length > 0;

  // The app-bar switcher: the active-workspace indicator + the one home for
  // switch/create/join, shown on every tab. The membersRefreshKey is bumped
  // after a join (which drops the caller onto a new roster).
  const switcher = (
    <WorkspaceSwitcher
      workspaces={workspaces}
      selected={selected}
      onSelect={setSelectedId}
      onChanged={() => {
        void fetchWorkspaces();
      }}
      onMembersChanged={() => setMembersRefreshKey((k) => k + 1)}
    />
  );

  // The Config tab's content. With a workspace selected it's the sidebar
  // <ConfigPanel>; with none it's a prompt pointing at the switcher, since
  // create/join now live there (the sidebar has nothing to configure).
  const configSection = (
    <section className="shepherd-config" aria-labelledby="config-heading">
      <h2 id="config-heading">Configuration</h2>
      {selected ? (
        <ConfigPanel
          workspace={selected}
          hubUrl={hubUrl}
          membersRefreshKey={membersRefreshKey}
          onMembersChanged={() => setMembersRefreshKey((k) => k + 1)}
          onWorkspaceChanged={() => void fetchWorkspaces()}
          onLeft={() => void fetchWorkspaces()}
          onDeleted={() => void fetchWorkspaces()}
          onLogout={onLogout}
          extraSections={extraSections}
        />
      ) : (
        <>
          <p className="config-none">
            You&apos;re not in a workspace yet. Use the <b>Get started ▾</b>{" "}
            menu at the top to create one or join with an invite code.
          </p>
          {/* Account actions still need a home with no workspace selected —
              rendered as the same Account card as the Config → Account tab. */}
          <AccountSettings onLogout={onLogout} />
        </>
      )}
    </section>
  );

  return (
    <div className="shepherd-root">
      <Dashboard
        workspaceId={selected?.id}
        workspace={selected ?? undefined}
        config={configSection}
        brand={brand}
        switcher={switcher}
        hasWorkspace={hasWorkspace}
        hubUrl={hubUrl}
        onWorkspacesChanged={() => {
          void fetchWorkspaces();
        }}
      />
    </div>
  );
}
