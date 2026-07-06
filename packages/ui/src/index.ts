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

export {
  ShepherdClientProvider,
  useShepherdClient,
} from "./context.js";

export { ShepherdRoot } from "./ShepherdRoot.js";
export type { ShepherdRootProps } from "./ShepherdRoot.js";

// The invite-link landing surface — auto-redeems a code and reports the joined
// workspace so the host can navigate to the board.
export { JoinWorkspace } from "./JoinWorkspace.js";
export type { JoinWorkspaceProps } from "./JoinWorkspace.js";

export { Dashboard } from "./components/Dashboard.js";
export type { DashboardProps } from "./components/Dashboard.js";

// The first-run setup checklist — re-exported so hosted consumers can compose
// the onboarding surface directly without the full Dashboard/ShepherdRoot shell.
export { SetupChecklist } from "./onboarding/SetupChecklist.js";
export type { SetupChecklistProps } from "./onboarding/SetupChecklist.js";

// Config screens — re-exported so consumers can compose the management surface
// directly without the full ShepherdRoot shell.
export {
  ConfigPanel,
  WorkspaceSwitcher,
  GeneralSettings,
  Members,
  Invites,
  ConnectAgent,
  EmptyState,
} from "./config/index.js";
export type {
  ConfigPanelProps,
  WorkspaceSwitcherProps,
  GeneralSettingsProps,
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
