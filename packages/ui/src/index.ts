/**
 * Public `.` entry for `@korso/shepherd-ui` — the auth-agnostic surface hosted
 * consumers import. It deliberately does NOT export {@link SelfHostApp} (the
 * token-gated self-host root lives behind the `./selfhost` export) and does NOT
 * import `styles.css` — hosted consumers opt into styling via
 * `@korso/shepherd-ui/styles.css`. This keeps the token gate out of `.` so the
 * core stays auth-neutral.
 */

export {
  createShepherdClient,
  ShepherdClientError,
  describeError,
} from "./client.js";
export type { ShepherdClient, ShepherdClientConfig } from "./client.js";

export { ShepherdClientProvider, useShepherdClient } from "./context.js";

export { ShepherdRoot } from "./ShepherdRoot.js";
export type { ShepherdRootProps } from "./ShepherdRoot.js";

// The invite-link landing surface — auto-redeems a code and reports the joined
// workspace so the host can navigate to the board.
export { JoinWorkspace } from "./JoinWorkspace.js";
export type { JoinWorkspaceProps } from "./JoinWorkspace.js";

export { Dashboard } from "./components/Dashboard.js";
export type { DashboardProps } from "./components/Dashboard.js";

// The first-run setup checklist is deliberately NOT exported: it is only
// usable with the stage policy in onboarding/useSetupStage, and no consumer
// composes it standalone today. Dashboard/ShepherdRoot are the surface; export
// the full kit (component + stage hook + logic) if a real consumer appears.

// Config screens — re-exported so consumers can compose the management surface
// directly without the full ShepherdRoot shell.
export {
  ConfigPanel,
  WorkspaceSwitcher,
  WorkspaceSettings,
  AccountSettings,
  Members,
  Invites,
  ConnectAgent,
  EmptyState,
} from "./config/index.js";
export type {
  ConfigPanelProps,
  ConfigSectionRequest,
  ExtraConfigSection,
  WorkspaceSwitcherProps,
  WorkspaceSettingsProps,
  AccountSettingsProps,
  MembersProps,
  InvitesProps,
  ConnectAgentProps,
  EmptyStateProps,
} from "./config/index.js";

// Tenancy contract types consumers need to type the props above.
export type {
  WorkspaceLandscapeResponseT,
  WorkspaceSummaryT,
  TokenSummaryT,
  MemberSummaryT,
  InviteResponseT,
} from "@shepherd/shared";
