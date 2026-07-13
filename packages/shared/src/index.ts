// Re-export name generation utilities
export { generateName, adjectives, nouns } from "./names.js";

// Re-export repo identity canonicalization (single source of truth for the
// coordination key — used by both the MCP client and the hub).
export { canonicalizeRepo, normalizeRemoteUrl } from "./repo.js";

// Re-export all zod schemas from the wire contract
export {
  ChangeRecord,
  ChangeReport,
  Claim,
  Announcement,
  Landscape,
  JoinRequest,
  JoinResponse,
  WorkRequest,
  WorkResponse,
  DoneRequest,
  DoneResponse,
  AnnounceRequest,
  AnnounceResponse,
  SyncRequest,
  SyncResponse,
  HeartbeatRequest,
  HeartbeatResponse,
  LeaveRequest,
  LeaveResponse,
  WorkAgentInput,
  AnnounceAgentInput,
  DoneAgentInput,
  JoinAgentInput,
  SyncAgentInput,
  WorkspaceAgent,
  WorkspaceTask,
  TaskStatus,
  WorkspaceAnnouncement,
  WorkspaceLandscapeResponse,
  WorkspaceAnnounceRequest,
  WorkspaceAnnounceResponse,
  Role,
  WorkspaceSummary,
  CreateWorkspaceRequest,
  CreateWorkspaceResponse,
  ListWorkspacesResponse,
  DeleteWorkspaceResponse,
  DeleteAccountResponse,
  MintTokenRequest,
  MintTokenResponse,
  TokenSummary,
  ListTokensResponse,
  CreateInviteRequest,
  InviteResponse,
  InviteByEmailRequest,
  InviteByEmailResponse,
  EmailInviteSummary,
  ListEmailInvitesResponse,
  RedeemInviteResponse,
  MemberSummary,
  ListMembersResponse,
  SetMemberRoleRequest,
  SetMemberRoleResponse,
  TransferOwnershipRequest,
  TransferOwnershipResponse,
  FeedbackType,
  FeedbackContext,
  FeedbackRequest,
  FeedbackResponse,
  AnalyticsRange,
  DEFAULT_ANALYTICS_RANGE,
  AnalyticsBucket,
  PeriodMetric,
  DurationPercentiles,
  TrendPoint,
  TrendSeries,
  TopWorkspace,
  ShepherdAnalyticsResponse,
  EntitlementLimits,
  LimitExceededErrorBody,
  WorkspaceEntitlements,
  PutEntitlementsRequest,
  EntitlementsStatusResponse,
} from "./contract.js";

// Inferred TypeScript types — consumers import these instead of z.infer<...>
import type { z } from "zod";
import type {
  ChangeRecord,
  ChangeReport,
  Claim,
  Announcement,
  Landscape,
  JoinRequest,
  JoinResponse,
  WorkRequest,
  WorkResponse,
  DoneRequest,
  DoneResponse,
  AnnounceRequest,
  AnnounceResponse,
  SyncRequest,
  SyncResponse,
  HeartbeatRequest,
  HeartbeatResponse,
  LeaveRequest,
  LeaveResponse,
  WorkAgentInput,
  AnnounceAgentInput,
  DoneAgentInput,
  JoinAgentInput,
  SyncAgentInput,
  WorkspaceAgent,
  WorkspaceTask,
  TaskStatus,
  WorkspaceAnnouncement,
  WorkspaceLandscapeResponse,
  WorkspaceAnnounceRequest,
  WorkspaceAnnounceResponse,
  Role,
  WorkspaceSummary,
  CreateWorkspaceRequest,
  CreateWorkspaceResponse,
  ListWorkspacesResponse,
  DeleteWorkspaceResponse,
  DeleteAccountResponse,
  MintTokenRequest,
  MintTokenResponse,
  TokenSummary,
  ListTokensResponse,
  CreateInviteRequest,
  InviteResponse,
  InviteByEmailRequest,
  InviteByEmailResponse,
  EmailInviteSummary,
  ListEmailInvitesResponse,
  RedeemInviteResponse,
  MemberSummary,
  ListMembersResponse,
  SetMemberRoleRequest,
  SetMemberRoleResponse,
  TransferOwnershipRequest,
  TransferOwnershipResponse,
  FeedbackType,
  FeedbackContext,
  FeedbackRequest,
  FeedbackResponse,
  AnalyticsRange,
  AnalyticsBucket,
  PeriodMetric,
  DurationPercentiles,
  TrendPoint,
  TrendSeries,
  TopWorkspace,
  ShepherdAnalyticsResponse,
  EntitlementLimits,
  LimitExceededErrorBody,
  WorkspaceEntitlements,
  PutEntitlementsRequest,
  EntitlementsStatusResponse,
} from "./contract.js";

export type ChangeRecordT = z.infer<typeof ChangeRecord>;
export type ChangeReportT = z.infer<typeof ChangeReport>;

export type ClaimT = z.infer<typeof Claim>;
export type AnnouncementT = z.infer<typeof Announcement>;
export type LandscapeT = z.infer<typeof Landscape>;

export type JoinRequestT = z.infer<typeof JoinRequest>;
export type JoinResponseT = z.infer<typeof JoinResponse>;

export type WorkRequestT = z.infer<typeof WorkRequest>;
export type WorkResponseT = z.infer<typeof WorkResponse>;

export type DoneRequestT = z.infer<typeof DoneRequest>;
export type DoneResponseT = z.infer<typeof DoneResponse>;

export type AnnounceRequestT = z.infer<typeof AnnounceRequest>;
export type AnnounceResponseT = z.infer<typeof AnnounceResponse>;

export type SyncRequestT = z.infer<typeof SyncRequest>;
export type SyncResponseT = z.infer<typeof SyncResponse>;

export type HeartbeatRequestT = z.infer<typeof HeartbeatRequest>;
export type HeartbeatResponseT = z.infer<typeof HeartbeatResponse>;

export type LeaveRequestT = z.infer<typeof LeaveRequest>;
export type LeaveResponseT = z.infer<typeof LeaveResponse>;

export type WorkAgentInputT = z.infer<typeof WorkAgentInput>;
export type AnnounceAgentInputT = z.infer<typeof AnnounceAgentInput>;
export type DoneAgentInputT = z.infer<typeof DoneAgentInput>;
export type JoinAgentInputT = z.infer<typeof JoinAgentInput>;
export type SyncAgentInputT = z.infer<typeof SyncAgentInput>;

export type WorkspaceAgentT = z.infer<typeof WorkspaceAgent>;
export type WorkspaceTaskT = z.infer<typeof WorkspaceTask>;
export type TaskStatusT = z.infer<typeof TaskStatus>;
export type WorkspaceAnnouncementT = z.infer<typeof WorkspaceAnnouncement>;
export type WorkspaceLandscapeResponseT = z.infer<
  typeof WorkspaceLandscapeResponse
>;
export type WorkspaceAnnounceRequestT = z.infer<
  typeof WorkspaceAnnounceRequest
>;
export type WorkspaceAnnounceResponseT = z.infer<
  typeof WorkspaceAnnounceResponse
>;

export type RoleT = z.infer<typeof Role>;
export type WorkspaceSummaryT = z.infer<typeof WorkspaceSummary>;
export type CreateWorkspaceRequestT = z.infer<typeof CreateWorkspaceRequest>;
export type CreateWorkspaceResponseT = z.infer<typeof CreateWorkspaceResponse>;
export type ListWorkspacesResponseT = z.infer<typeof ListWorkspacesResponse>;
export type DeleteWorkspaceResponseT = z.infer<typeof DeleteWorkspaceResponse>;
export type DeleteAccountResponseT = z.infer<typeof DeleteAccountResponse>;
export type MintTokenRequestT = z.infer<typeof MintTokenRequest>;
export type MintTokenResponseT = z.infer<typeof MintTokenResponse>;
export type TokenSummaryT = z.infer<typeof TokenSummary>;
export type ListTokensResponseT = z.infer<typeof ListTokensResponse>;
export type CreateInviteRequestT = z.infer<typeof CreateInviteRequest>;
export type InviteResponseT = z.infer<typeof InviteResponse>;
export type InviteByEmailRequestT = z.infer<typeof InviteByEmailRequest>;
export type InviteByEmailResponseT = z.infer<typeof InviteByEmailResponse>;
export type EmailInviteSummaryT = z.infer<typeof EmailInviteSummary>;
export type ListEmailInvitesResponseT = z.infer<
  typeof ListEmailInvitesResponse
>;
export type RedeemInviteResponseT = z.infer<typeof RedeemInviteResponse>;
export type MemberSummaryT = z.infer<typeof MemberSummary>;
export type ListMembersResponseT = z.infer<typeof ListMembersResponse>;
export type SetMemberRoleRequestT = z.infer<typeof SetMemberRoleRequest>;
export type SetMemberRoleResponseT = z.infer<typeof SetMemberRoleResponse>;
export type TransferOwnershipRequestT = z.infer<
  typeof TransferOwnershipRequest
>;
export type TransferOwnershipResponseT = z.infer<
  typeof TransferOwnershipResponse
>;
export type FeedbackTypeT = z.infer<typeof FeedbackType>;
export type FeedbackContextT = z.infer<typeof FeedbackContext>;
export type FeedbackRequestT = z.infer<typeof FeedbackRequest>;
export type FeedbackResponseT = z.infer<typeof FeedbackResponse>;

export type AnalyticsRangeT = z.infer<typeof AnalyticsRange>;
export type AnalyticsBucketT = z.infer<typeof AnalyticsBucket>;
export type PeriodMetricT = z.infer<typeof PeriodMetric>;
export type DurationPercentilesT = z.infer<typeof DurationPercentiles>;
export type TrendPointT = z.infer<typeof TrendPoint>;
export type TrendSeriesT = z.infer<typeof TrendSeries>;
export type TopWorkspaceT = z.infer<typeof TopWorkspace>;
export type ShepherdAnalyticsResponseT = z.infer<
  typeof ShepherdAnalyticsResponse
>;

export type EntitlementLimitsT = z.infer<typeof EntitlementLimits>;
export type LimitExceededErrorBodyT = z.infer<typeof LimitExceededErrorBody>;
export type WorkspaceEntitlementsT = z.infer<typeof WorkspaceEntitlements>;
export type PutEntitlementsRequestT = z.infer<typeof PutEntitlementsRequest>;
export type EntitlementsStatusResponseT = z.infer<
  typeof EntitlementsStatusResponse
>;
