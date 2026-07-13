import { z } from "zod";

// ---------------------------------------------------------------------------
// Shared sub-schemas
// ---------------------------------------------------------------------------

/**
 * ISO 8601 timestamp strings are used for expiresAt and createdAt fields so
 * that all values remain plain JSON-serialisable strings over the wire, rather
 * than requiring Date objects or special transport encodings.
 */
const IsoTimestamp = z.string(); // ISO 8601, e.g. "2026-06-22T12:00:00.000Z"

/**
 * Database identity columns are BIGINT; they fit safely in JS Number at the
 * scale of this application (< 2^53), so z.number() is used instead of
 * z.bigint() to avoid serialisation friction over JSON.
 */
const DbId = z.number(); // bigint PK serialised as number for JSON transport

// ---------------------------------------------------------------------------
// ChangeRecord — hub → client, inside Landscape
// ---------------------------------------------------------------------------
export const ChangeRecord = z.object({
  agentName: z.string(),
  human: z.string(),
  branch: z.string(),
  kind: z.enum(["committed", "uncommitted"]),
  commitSha: z.string().nullable(),
  message: z.string().nullable(),
  paths: z.array(z.string()).min(1),
  authorIsLive: z.boolean(),
  authorLastActiveAt: IsoTimestamp,
  updatedAt: IsoTimestamp,
});

// ---------------------------------------------------------------------------
// ChangeReport — client → hub, on work/sync
// ---------------------------------------------------------------------------
const ChangeReportEntry = z.object({
  kind: z.enum(["committed", "uncommitted"]),
  // A git object id (lowercase hex, 4–64 chars) for `committed` entries, or null
  // for `uncommitted`. This value is forwarded by the hub to OTHER clients, which
  // feed it straight into local `git` argument vectors (isAncestor/hasCommit/
  // changedLineRanges). Validating the shape at the wire boundary stops an
  // attacker-controlled, flag-like value (e.g. "--output=...") from being parsed
  // by git as an option on a teammate's machine (argument injection). gitContext
  // re-validates defensively as well.
  sha: z
    .string()
    .regex(/^[0-9a-f]{4,64}$/)
    .nullable(),
  // Length caps here and below are DB-bloat guards, not semantic limits: they
  // sit 10-100x above any real value (commit subjects, branch names, paths),
  // bounding what one authenticated caller can persist per field.
  message: z.string().max(4096).nullable(),
  paths: z.array(z.string().min(1).max(1024)).min(1).max(500),
});

export const ChangeReport = z.object({
  branch: z.string().max(512),
  baseBranch: z.string().max(512),
  head: z.string().max(512),
  truncated: z.boolean().default(false),
  // The only producer (gitContext.unlandedCommits) emits at most MAX_COMMITS
  // (100) committed entries + 1 uncommitted, so this ceiling is generous. If
  // MAX_COMMITS is ever raised above ~599, raise this in lockstep or the hub
  // will start 400-rejecting otherwise-valid reports.
  entries: z.array(ChangeReportEntry).max(600),
});

// ---------------------------------------------------------------------------
// Claim
// ---------------------------------------------------------------------------
export const Claim = z.object({
  workItemId: z.string().uuid(),
  agentName: z.string(),
  human: z.string().min(1),
  intent: z.string().min(1).max(2048),
  pathGlobs: z.array(z.string().min(1).max(512)).min(1).max(64),
  // ISO timestamp string; see IsoTimestamp note above
  expiresAt: IsoTimestamp,
});

// ---------------------------------------------------------------------------
// Announcement
// ---------------------------------------------------------------------------
export const Announcement = z.object({
  // bigint PK serialised as number; see DbId note above
  id: DbId,
  fromAgentName: z.string(),
  fromHuman: z.string().min(1),
  body: z.string().min(1).max(8192),
  targetAgentName: z.string().nullable(),
  // ISO timestamp string; see IsoTimestamp note above
  createdAt: IsoTimestamp,
});

// ---------------------------------------------------------------------------
// Landscape
// ---------------------------------------------------------------------------
export const Landscape = z.object({
  conflicts: z.array(Claim),
  activeClaims: z.array(Claim),
  // The caller's OWN active claims. `activeClaims` deliberately excludes the
  // caller's session, so without this an agent has no way to confirm its own
  // claim is live. Optional with a default so an older client talking to a
  // newer hub (or vice-versa) never fails validation on its absence.
  yourClaims: z.array(Claim).default([]),
  announcements: z.array(Announcement),
  // Per-agent change records for the workspace. Defaulted for version-skew safety.
  changeRecords: z.array(ChangeRecord).default([]),
});

// ---------------------------------------------------------------------------
// Wallboard — read-only whole-workspace view (GET /workspace/landscape)
//
// Unlike Landscape (which is scoped to a caller's session, repo, and own globs),
// this is the UNFILTERED view a wallboard needs: every agent in the configured
// workspace, every live claim, and recent announcements. It has no request
// counterpart — the endpoint takes no body. Fields are version-skew safe via
// the same ISO-string / nullable conventions as the other contract schemas.
// ---------------------------------------------------------------------------

/** One agent in the workspace, joined to its most-recent session (if any). */
export const WorkspaceAgent = z.object({
  name: z.string(),
  human: z.string(),
  program: z.string(),
  // model is nullable in the DB (may be unknown when an agent first joins).
  model: z.string().nullable(),
  // repo/branch/lastHeartbeatAt come from the agent's most-recent session and
  // are null when the agent has no session yet.
  repo: z.string().nullable(),
  branch: z.string().nullable(),
  lastHeartbeatAt: IsoTimestamp.nullable(),
  presence: z.enum(["live", "offline"]),
});

/** A task's lifecycle status, derived by the hub at read time. */
export const TaskStatus = z.enum(["active", "done", "dropped"]);

/**
 * One task = one `work` claim (an agent's stated intent). Durable & append-only.
 * `status` is derived from owner presence + release:
 *   active  — not released, owner live
 *   done    — released_at set (agent called `done`)
 *   dropped — not released, owner went offline (stale heartbeat)
 * `endedAt` is null for active; release time for done; owner's last heartbeat
 * for dropped.
 */
export const WorkspaceTask = z.object({
  agentName: z.string(),
  program: z.string(),
  model: z.string().nullable(),
  repo: z.string(),
  intent: z.string(),
  pathGlobs: z.array(z.string()),
  status: TaskStatus,
  createdAt: IsoTimestamp,
  endedAt: IsoTimestamp.nullable(),
});

/** One announcement in the workspace feed (broadcast or @targeted). */
export const WorkspaceAnnouncement = z.object({
  fromAgentName: z.string(),
  fromHuman: z.string(),
  body: z.string(),
  targetAgentName: z.string().nullable(),
  repo: z.string(),
  // True when the message was sent by the human operator from the dashboard
  // (no agent session). The dashboard renders these as "me" (right-aligned).
  // Defaulted for version-skew safety with older hubs.
  fromAdmin: z.boolean().default(false),
  // True when an agent addressed the message TO the operator side (the
  // dashboard) — collectively (legacy) or a specific member (see
  // targetMemberName). Not delivered to other agents. Defaulted for
  // version-skew safety with older hubs.
  toAdmin: z.boolean().default(false),
  // When an agent addressed a SPECIFIC workspace member, the member's display
  // name snapshotted at send time — the dashboard renders "→ <name>" instead of
  // the collective "→ admin". Null for legacy/collective operator messages and
  // everything else. Defaulted for version-skew safety with older hubs.
  targetMemberName: z.string().nullable().default(null),
  createdAt: IsoTimestamp,
});

export const WorkspaceLandscapeResponse = z.object({
  agents: z.array(WorkspaceAgent),
  tasks: z.array(WorkspaceTask),
  announcements: z.array(WorkspaceAnnouncement),
  // The server's clock, so the client computes "expires in / last seen" against
  // the hub rather than the (possibly skewed) browser clock.
  serverTime: IsoTimestamp,
});

// ---------------------------------------------------------------------------
// Operator → hub: send an announcement from the dashboard (POST /workspace/announce)
//
// Unlike `announce` (agent → hub, carries a sessionId), this is the HUMAN
// operator's surface: authenticated at the route layer, no session. The hub
// stamps the sender as the calling member's profile name (falling back to the
// configured admin label for self-host / profile-less callers) and records the
// message with no `from_session_id`.
// ---------------------------------------------------------------------------
export const WorkspaceAnnounceRequest = z.object({
  body: z.string().min(1).max(8192),
  // Direct-message a single agent (by the exact name shown in the landscape).
  // Absent/null => broadcast. The hub resolves the target's repo server-side.
  targetAgentName: z.string().min(1).max(256).nullable().optional(),
  // For a broadcast, the repo to scope the message to (matches the dashboard's
  // selected repo). Absent/null => fan out to every repo in the workspace.
  // Ignored for a DM (the target's own repo is used).
  repo: z.string().min(1).max(256).nullable().optional(),
});

export const WorkspaceAnnounceResponse = z.object({
  ok: z.literal(true),
  // One id per inserted row: a single id for a DM or repo-scoped broadcast, or
  // several when an all-repos broadcast fans out across repos.
  announcementIds: z.array(DbId),
});

// ---------------------------------------------------------------------------
// join(workspace, repo, branch, human, program, model) -> { agentName, sessionId }
// ---------------------------------------------------------------------------
// max(256) on the identity fields is a DB-bloat guard (persisted to agents/
// sessions rows), far above any real slug/name/branch — not a semantic limit.
export const JoinRequest = z.object({
  workspace: z.string().min(1).max(256),
  repo: z.string().min(1).max(256),
  branch: z.string().min(1).max(256),
  human: z.string().min(1).max(256),
  program: z.string().min(1).max(256),
  model: z.string().min(1).max(256).optional(),
});

export const JoinResponse = z.object({
  agentName: z.string(),
  sessionId: z.string().uuid(),
  // Advertised so clients can nudge their humans to update. Optional: older
  // hubs omit them, and a hub that cannot determine its bundled client
  // version fails open by leaving them out.
  latestClientVersion: z.string().optional(),
  minimumClientVersion: z.string().optional(),
});

// ---------------------------------------------------------------------------
// work(sessionId, intent, pathGlobs[], ttlSeconds?) -> { workItemId, landscape }
// ---------------------------------------------------------------------------
export const WorkRequest = z.object({
  sessionId: z.string().uuid(),
  intent: z.string().min(1).max(2048),
  pathGlobs: z.array(z.string().min(1).max(512)).min(1).max(64),
  ttlSeconds: z.number().int().positive().optional(),
  changeReport: ChangeReport.optional(),
});

export const WorkResponse = z.object({
  workItemId: z.string().uuid(),
  landscape: Landscape,
});

// ---------------------------------------------------------------------------
// done(sessionId, workItemId) -> { ok: true }
// ---------------------------------------------------------------------------
export const DoneRequest = z.object({
  sessionId: z.string().uuid(),
  workItemId: z.string().uuid(),
});

export const DoneResponse = z.object({
  ok: z.literal(true),
  // Pending announcements for the caller, delivered as a side effect of done so
  // a message lands the moment a teammate finishes a unit of work (not only on
  // their next work/sync). Defaulted for version-skew safety with older hubs.
  announcements: z.array(Announcement).default([]),
});

// ---------------------------------------------------------------------------
// announce(sessionId, body, target?) -> { ok: true, announcementId }
// ---------------------------------------------------------------------------
export const AnnounceRequest = z.object({
  sessionId: z.string().uuid(),
  body: z.string().min(1).max(8192),
  // THE preferred addressing field: one name that reaches either kind of
  // teammate. The hub resolves it in order — a LIVE AGENT in the sender's repo
  // (exact landscape name, e.g. "alex-rivera-2"), else the operator label
  // ("admin" by default => the dashboard collectively), else a WORKSPACE MEMBER
  // (a dashboard user, matched case-insensitively on display name, GitHub
  // login, or email). No match => 400 listing both sets. Absent/null =>
  // broadcast to all agents. Mutually exclusive with the legacy fields below.
  target: z.string().min(1).max(256).nullable().optional(),
  // LEGACY (kept for older clients; prefer `target`): the exact live-agent name.
  targetAgentName: z.string().max(256).nullable().optional(),
  // LEGACY (kept for older clients; prefer `target` with a member's name):
  // true => address the human operators (the dashboard) collectively. Shows in
  // the workspace feed as "<agent> → admin" and is NOT delivered to other
  // agents. Mutually exclusive with targetAgentName and target.
  toAdmin: z.boolean().optional(),
});

export const AnnounceResponse = z.object({
  ok: z.literal(true),
  // bigint PK serialised as number; see DbId note above
  announcementId: DbId,
  // Pending announcements for the caller, delivered as a side effect of announce
  // (a turn where the agent is already reading hub output) so inbound messages
  // surface promptly. Excludes the just-sent one. Defaulted for version skew.
  announcements: z.array(Announcement).default([]),
});

// ---------------------------------------------------------------------------
// sync(sessionId) -> { landscape }
// ---------------------------------------------------------------------------
export const SyncRequest = z.object({
  sessionId: z.string().uuid(),
  changeReport: ChangeReport.optional(),
});

export const SyncResponse = z.object({
  landscape: Landscape,
});

// ---------------------------------------------------------------------------
// Agent-facing input shapes — derived via .omit so they cannot drift from the
// request schemas.  Task 15 will register MCP tools using these shapes' .shape.
// ---------------------------------------------------------------------------

/** Input shape an agent provides for work(); sessionId and changeReport are added/handled by the hub. */
export const WorkAgentInput = WorkRequest.omit({
  sessionId: true,
  changeReport: true,
});

/** Input shape an agent provides for announce(); sessionId is added by the hub. */
export const AnnounceAgentInput = AnnounceRequest.omit({ sessionId: true });

/** Input shape an agent provides for done(); sessionId is added by the hub. */
export const DoneAgentInput = DoneRequest.omit({ sessionId: true });

/** join() requires no agent-supplied input beyond the MCP session context. */
export const JoinAgentInput = z.object({});

/** sync() requires no agent-supplied input beyond the MCP session context. */
export const SyncAgentInput = z.object({});

// ---------------------------------------------------------------------------
// heartbeat(sessionId) -> { ok: true }
// ---------------------------------------------------------------------------
export const HeartbeatRequest = z.object({
  sessionId: z.string().uuid(),
  // Optional change report so the BACKGROUND heartbeat keeps an agent's durable
  // change records fresh (commits surface within ~one heartbeat interval, not
  // only when it next calls work/sync). Processed presence-style: it refreshes
  // change records but, like the rest of heartbeat, does NOT renew claim TTLs.
  changeReport: ChangeReport.optional(),
  // Opt-in: when set, the heartbeat returns any pending announcements for the
  // caller in the response. Delivery is now TWO-PHASE and crash-safe: this fetch
  // phase does NOT mark them delivered — the client persists them to its
  // model-visible sink (the local inbox file drained by a hook) FIRST, then acks
  // via `ackAnnouncementIds` so the hub records the delivery only after the local
  // write is confirmed. The MCP client only sets this when it actually has such a
  // sink. Absent for older clients, so default behaviour (no delivery) is
  // unchanged.
  deliverAnnouncements: z.boolean().optional(),
  // Phase-two ack of a previous `deliverAnnouncements` fetch: the ids the client
  // has now durably written to its model-visible sink. The hub marks exactly
  // these delivered to the caller's session. Decoupling the mark from the fetch
  // guarantees a message is never recorded delivered before the client holds it
  // (a lost response or a failed local append simply leaves it pending for the
  // next beat). Absent on a plain presence/fetch beat.
  ackAnnouncementIds: z.array(DbId).optional(),
});

export const HeartbeatResponse = z.object({
  ok: z.literal(true),
  // Pending announcements for the caller, delivered only when the request set
  // `deliverAnnouncements`. Defaulted to [] for version-skew safety with older
  // hubs (which return just { ok: true }).
  announcements: z.array(Announcement).default([]),
});

// ---------------------------------------------------------------------------
// leave(sessionId) -> { ok: true }
//
// Clean-shutdown signal sent by the MCP client when its process exits. It marks
// the session's PRESENCE offline immediately (no waiting out the staleness
// window) so the agent's live claims stop surfacing to teammates the moment it
// disconnects. It deliberately does NOT release claims or clear change records:
// those are durable, presence-independent signals that must outlive the session.
// Idempotent — an unknown/already-departed session still returns { ok: true }.
// ---------------------------------------------------------------------------
export const LeaveRequest = z.object({
  sessionId: z.string().uuid(),
});

export const LeaveResponse = z.object({
  ok: z.literal(true),
});

// ---------------------------------------------------------------------------
// Management endpoints — workspaces, tokens, invites, members
//
// These are the operator/dashboard surface (authenticated by the account
// session, not an agent session). Requests and responses are plain JSON; dates
// follow the same ISO-string convention as the rest of this file and nullable
// fields use .nullable() so the hub and the dashboard client agree on shape.
// ---------------------------------------------------------------------------

/**
 * A member's role within a workspace. Shared across every management schema so
 * the admin/member vocabulary stays consistent; consumers import the inferred
 * `RoleT` rather than re-declaring the literal union.
 */
export const Role = z.enum(["admin", "member"]);

/** One workspace as seen by an account, with that account's role in it. */
export const WorkspaceSummary = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  role: Role,
  // Whether this account is the workspace's OWNER — the original creator
  // (workspaces.created_by), a flag layered on top of the admin role rather than
  // a third role value. The owner is always an admin; only the owner may change
  // members' roles or transfer ownership. Self-host workspaces (created_by =
  // "self-host", no account) surface this false for every member.
  isOwner: z.boolean(),
});

// ---------------------------------------------------------------------------
// createWorkspace({ name }) -> WorkspaceSummary
// ---------------------------------------------------------------------------
export const CreateWorkspaceRequest = z.object({
  // Cap the name like every other persisted string field (256), so a workspace
  // name (and the slug candidate derived from it) can't be inflated toward the
  // request body limit. min(1) keeps the "non-empty" contract.
  name: z.string().min(1).max(256),
});

export const CreateWorkspaceResponse = WorkspaceSummary;

// ---------------------------------------------------------------------------
// listWorkspaces() -> { workspaces: WorkspaceSummary[] }
// ---------------------------------------------------------------------------
export const ListWorkspacesResponse = z.object({
  workspaces: z.array(WorkspaceSummary),
});

// ---------------------------------------------------------------------------
// deleteWorkspace(id) -> { deleted: true }
//
// Permanently deletes the workspace named by the route `:id` and every
// workspace-scoped row (agents, sessions, tasks, announcements, change records,
// api tokens, invites, memberships). Admin-only and irreversible; the id travels
// in the path, so the request carries no body (mirroring the bodyless leave/
// revoke routes). `{ deleted: true }` follows the `{ ok: true }` success-marker
// convention used elsewhere in this file.
// ---------------------------------------------------------------------------
export const DeleteWorkspaceResponse = z.object({
  deleted: z.literal(true),
});

// ---------------------------------------------------------------------------
// deleteAccount() -> { deleted: true } (DELETE /account)
//
// Permanently deletes the CALLER's account: every membership is removed, every
// token the account owns is revoked, workspaces where the caller was the sole
// member are deleted outright, and the profile row is erased. Refused with 409
// when the caller is the last admin of a workspace that still has other
// members — they must promote another admin (or delete that workspace) first,
// mirroring the leave/remove last-admin guard. Browser-session only (an agent
// token must never be able to erase its owning account).
// ---------------------------------------------------------------------------
export const DeleteAccountResponse = z.object({
  deleted: z.literal(true),
});

// ---------------------------------------------------------------------------
// mintToken({ name? }) -> { token, id }
//
// The raw `shp_`-prefixed token is returned exactly ONCE, at mint time; the hub
// stores only its hash. Callers must surface/save it immediately — it is never
// retrievable again (see ListTokensResponse, which never carries it).
// ---------------------------------------------------------------------------
export const MintTokenRequest = z.object({
  name: z.string().min(1).optional(),
});

export const MintTokenResponse = z.object({
  // The raw shp_ token, shown once at creation and never returned again.
  token: z.string(),
  id: z.string(),
});

// ---------------------------------------------------------------------------
// listTokens() -> token summaries
//
// Deliberately omits the hash and the raw token: this is the listing surface,
// so it carries only non-secret metadata about each token.
// ---------------------------------------------------------------------------
export const TokenSummary = z.object({
  id: z.string(),
  name: z.string().nullable(),
  // ISO timestamp string (see IsoTimestamp note above) or null when unused / not revoked.
  lastUsedAt: IsoTimestamp.nullable(),
  createdAt: IsoTimestamp,
  revokedAt: IsoTimestamp.nullable(),
});

export const ListTokensResponse = z.object({
  tokens: z.array(TokenSummary),
});

// ---------------------------------------------------------------------------
// createInvite({ expiresInDays?, maxUses? }) -> InviteResponse
// ---------------------------------------------------------------------------
// Invites grant the `member` role only. The selectable-role surface was removed
// (review finding P2.7): no UI ever sent a role and InviteResponse never returned
// the granted role, so admin-vs-member invites were unreachable. Re-add a `role`
// field here (and a roleGranted in InviteResponse + a selector in the Config UI)
// when admin invites become a real feature.
export const CreateInviteRequest = z.object({
  expiresInDays: z.number().int().positive().optional(),
  // Omitted = unlimited, redeemable until explicitly revoked. Pass a positive
  // integer to cap it instead.
  maxUses: z.number().int().positive().optional(),
});

export const InviteResponse = z.object({
  code: z.string(),
  // ISO timestamp string, or null when the invite never expires.
  expiresAt: IsoTimestamp.nullable(),
  // null = unlimited (redeemable until revoked).
  maxUses: z.number().int().positive().nullable(),
  useCount: z.number().int().nonnegative(),
});

// ---------------------------------------------------------------------------
// inviteByEmail({ email }) -> { email, sentAt }
//
// Mints a one-time-use invite (maxUses: 1 — the existing use-cap guard already
// stops it dead after the first redemption, no separate expiry logic needed)
// and emails the join link directly to `email`. Admin only.
// ---------------------------------------------------------------------------
export const InviteByEmailRequest = z.object({
  email: z.string().email(),
});

export const InviteByEmailResponse = z.object({
  email: z.string(),
  sentAt: IsoTimestamp,
});

// ---------------------------------------------------------------------------
// listEmailInvites() -> { invites: EmailInviteSummary[] }
//
// The PENDING email invites of a workspace (admin only): sent by email, not yet
// redeemed, not revoked, not expired. A redeemed one-time invite (use_count
// reached max_uses) drops out of this list, so the Config UI's "sent invites"
// roster empties itself as people join. Deliberately omits the invite code —
// the join link already left by email; the dashboard list is status-only.
// ---------------------------------------------------------------------------
export const EmailInviteSummary = z.object({
  id: z.string(),
  email: z.string(),
  sentAt: IsoTimestamp,
  // ISO timestamp string, or null when the invite never expires.
  expiresAt: IsoTimestamp.nullable(),
});

export const ListEmailInvitesResponse = z.object({
  invites: z.array(EmailInviteSummary),
});

// ---------------------------------------------------------------------------
// redeemInvite(code) -> { workspace }
// ---------------------------------------------------------------------------
export const RedeemInviteResponse = z.object({
  // The workspace the caller just joined.
  workspace: WorkspaceSummary,
});

// ---------------------------------------------------------------------------
// listMembers() -> { members: MemberSummary[] }
// ---------------------------------------------------------------------------
export const MemberSummary = z.object({
  accountId: z.string(),
  displayName: z.string().nullable(),
  githubLogin: z.string().nullable(),
  email: z.string().nullable(),
  avatarUrl: z.string().nullable(),
  role: Role,
  // Whether this member is the workspace OWNER (workspaces.created_by). Surfaced
  // so the roster can badge them "owner" and gate the owner-only role controls;
  // see WorkspaceSummary.isOwner for the model.
  isOwner: z.boolean(),
});

export const ListMembersResponse = z.object({
  members: z.array(MemberSummary),
});

// ---------------------------------------------------------------------------
// setMemberRole({ role }) -> { ok: true, role } (PATCH /workspaces/:id/members/:accountId/role)
//
// OWNER-ONLY. Promotes a member to admin or demotes an admin back to member. The
// owner cannot change their OWN role (they are always an admin) and no one may
// demote the last admin (409) — though with the owner always an admin that guard
// is naturally satisfied. Restricting role changes to the owner is what stops a
// promoted admin from demoting everyone else and seizing the workspace.
// ---------------------------------------------------------------------------
export const SetMemberRoleRequest = z.object({
  role: Role,
});

export const SetMemberRoleResponse = z.object({
  ok: z.literal(true),
  role: Role,
});

// ---------------------------------------------------------------------------
// transferOwnership({ accountId }) -> { ok: true } (POST /workspaces/:id/transfer-ownership)
//
// OWNER-ONLY. Hands the owner flag to another MEMBER of the workspace: the target
// becomes the new owner (workspaces.created_by) and is promoted to admin if they
// weren't already; the former owner stays an admin. The only way to change who
// the owner is.
// ---------------------------------------------------------------------------
export const TransferOwnershipRequest = z.object({
  accountId: z.string().min(1),
});

export const TransferOwnershipResponse = z.object({
  ok: z.literal(true),
});

// ---------------------------------------------------------------------------
// submitFeedback({ type, body, context? }) -> { ok: true, id }
// ---------------------------------------------------------------------------
export const FeedbackType = z.enum(["bug", "suggestion", "other"]);

// Optional client-gathered context attached by the feedback widget. Every
// field optional and length-capped: old clients that omit `context` entirely
// keep working, and no field is trusted beyond being a short string.
export const FeedbackContext = z.object({
  route: z.string().max(256).optional(),
  appVersion: z.string().max(256).optional(),
  userAgent: z.string().max(512).optional(),
  viewport: z.string().max(256).optional(),
});

export const FeedbackRequest = z.object({
  type: FeedbackType,
  body: z.string().trim().min(1).max(4000),
  context: FeedbackContext.optional(),
});

export const FeedbackResponse = z.object({
  ok: z.literal(true),
  // uuid PK (the feedback table, like workspaces, uses gen_random_uuid()).
  id: z.string(),
});

// ---------------------------------------------------------------------------
// Workspace entitlements — per-workspace numeric caps
//
// A neutral limits primitive: each cap bounds one dimension of a workspace
// (members, distinct repos, announcement history age). `null` means unlimited
// for that dimension. A deployment that wants enforcement configures default
// caps via ENTITLEMENTS_DEFAULT_LIMITS (hub config); a per-workspace record
// (migration 020) can override them. With no defaults configured the hub
// enforces nothing.
// ---------------------------------------------------------------------------

/** A positive integer cap, or null = unlimited for that dimension. */
const NullableCap = z.number().int().positive().nullable();

export const EntitlementLimits = z.object({
  seatsLimit: NullableCap,
  reposLimit: NullableCap,
  retentionDays: NullableCap,
});

/**
 * The 402 body the hub sends when an action would exceed a workspace cap
 * (LimitExceededError in the hub's errors.ts). `code` is the machine
 * discriminator clients switch on; `error` is the user-facing message.
 */
export const LimitExceededErrorBody = z.object({
  error: z.string(),
  code: z.literal("limit_exceeded"),
  limit: z.enum(["seats", "repos"]),
  current: z.number().int(),
  max: z.number().int(),
});

/**
 * A workspace's stored entitlements record on the wire (GET body / PUT
 * response). `expiresAt` in the past means the record is inert and the
 * deployment defaults apply — see the hub's effectiveLimits.
 */
export const WorkspaceEntitlements = EntitlementLimits.extend({
  expiresAt: IsoTimestamp.nullable(),
  updatedAt: IsoTimestamp,
});

/** PUT /internal/workspaces/:id/entitlements request body. */
export const PutEntitlementsRequest = EntitlementLimits.extend({
  expiresAt: IsoTimestamp.nullable(),
});

/**
 * GET /internal/workspaces/:id/entitlements response: the stored record (or
 * null), the caps that actually apply right now, and current usage so the
 * caller can render headroom without extra round-trips.
 */
export const EntitlementsStatusResponse = z.object({
  record: WorkspaceEntitlements.nullable(),
  effective: EntitlementLimits,
  usage: z.object({
    seatsUsed: z.number().int(),
    reposUsed: z.number().int(),
  }),
});

// ---------------------------------------------------------------------------
// platformAnalytics({ range? }) -> ShepherdAnalyticsResponse
// (GET /admin/analytics?range=24h|7d|30d|90d)
//
// The cross-tenant, read-only product analytics rollup behind the Korso console
// "Shepherd" tab. Operator-gated at the hub (see requireOperator in the hub's
// tenant.ts for the trust model). This is the canonical wire contract; the
// hub's repo/operation layers type against it so drift is caught at compile
// time (and the operation parse-validates the payload at runtime).
//
// The rollup is range-aware: the caller picks one of four preset windows and
// every period-scoped number (period KPIs, trend series, workspace rollup
// activity) is computed over that window plus the equal-length window
// immediately before it, so the UI can render "vs previous period" deltas
// without a second request.
// ---------------------------------------------------------------------------

/**
 * The supported analytics windows. A closed enum (not a free-form duration)
 * so the hub can bind exact timestamps per preset, cache per range, and
 * reject anything else with a 400 instead of running an unbounded query.
 */
export const AnalyticsRange = z.enum(["24h", "7d", "30d", "90d"]);

/** The window used when the caller omits or sends an invalid `range`. */
export const DEFAULT_ANALYTICS_RANGE: z.infer<typeof AnalyticsRange> = "30d";

/**
 * Trend-bucket granularity, echoed on the response so the client never has
 * to re-derive it from the range: `hour` for the 24h window, `day` otherwise.
 */
export const AnalyticsBucket = z.enum(["hour", "day"]);

/**
 * A comparison-aware KPI: the count observed in the current window, the count
 * in the aligned previous window, and the percentage change between them.
 * `changePct` is null when the previous period is 0 (a percentage would be
 * undefined/infinite) — the UI renders "new" instead of a false number.
 * Counts are non-negative integers by construction (they are row counts).
 */
export const PeriodMetric = z.object({
  current: z.number().int().nonnegative(),
  previous: z.number().int().nonnegative(),
  changePct: z.number().nullable(),
});

/**
 * Observed duration percentiles in seconds. Both are null when there are no
 * source rows in the window — the contract forces the "no data" case to be
 * explicit rather than surfacing a misleading 0s percentile.
 */
export const DurationPercentiles = z.object({
  p50: z.number().nonnegative().nullable(),
  p95: z.number().nonnegative().nullable(),
});

/**
 * One bucket in a trend series (zero-filled across the window). `date` is
 * `YYYY-MM-DD` for daily buckets and an ISO timestamp for hourly buckets.
 */
export const TrendPoint = z.object({
  date: z.string(),
  count: z.number(),
});

/**
 * A trend series with its aligned prior-period twin: `previous` covers the
 * equal-length window immediately before `current` (same bucket count, so the
 * chart can overlay them point-for-point).
 */
export const TrendSeries = z.object({
  current: z.array(TrendPoint),
  previous: z.array(TrendPoint),
});

/**
 * One workspace in the analytics rollup table. Identity/size fields (name,
 * slug, members, agents, liveSessions) describe current state; the activity
 * fields (activeAgents, sessions, commits, claimsReleased, medianClaimSeconds,
 * lastActivityAt) are scoped to the requested range. `medianClaimSeconds` and
 * `lastActivityAt` are null when the workspace has no observed data in the
 * window.
 */
export const TopWorkspace = z.object({
  name: z.string(),
  slug: z.string(),
  members: z.number().int().nonnegative(),
  agents: z.number().int().nonnegative(),
  liveSessions: z.number().int().nonnegative(),
  // Distinct agents with any session activity inside the window.
  activeAgents: z.number().int().nonnegative(),
  sessions: z.number().int().nonnegative(),
  commits: z.number().int().nonnegative(),
  claimsReleased: z.number().int().nonnegative(),
  // Median released-claim duration (created_at -> released_at), seconds.
  medianClaimSeconds: z.number().nonnegative().nullable(),
  // ISO timestamp of the most recent observed activity, or null if none.
  lastActivityAt: IsoTimestamp.nullable(),
});

export const ShepherdAnalyticsResponse = z.object({
  generatedAt: IsoTimestamp,
  // Echo of the (validated) requested window plus the bucket granularity and
  // the exact half-open window [windowStart, windowEnd) the hub computed
  // against — clients label charts from these instead of re-deriving time math.
  range: AnalyticsRange,
  bucket: AnalyticsBucket,
  windowStart: IsoTimestamp,
  windowEnd: IsoTimestamp,
  // Current-state totals: whole-platform counts as of `generatedAt`,
  // independent of the requested range.
  totals: z.object({
    accounts: z.number(),
    workspaces: z.number(),
    memberships: z.number(),
    agents: z.number(),
    liveSessions: z.number(),
    activeTokens: z.number(),
    revokedTokens: z.number(),
    activeInvites: z.number(),
    feedback: z.number(),
    changeRecords: z.number(),
    activeWorkItems: z.number(),
  }),
  engagement: z.object({
    activeWorkspaces7d: z.number(),
    activeWorkspaces30d: z.number(),
    avgMembersPerWorkspace: z.number(),
    largestWorkspace: z.number(),
  }),
  // Range-scoped KPIs, each with its aligned previous-period comparison.
  period: z.object({
    activeWorkspaces: PeriodMetric,
    newAccounts: PeriodMetric,
    newSessions: PeriodMetric,
    commits: PeriodMetric,
    claimsReleased: PeriodMetric,
  }),
  // Observed timing diagnostics over the current window: session span is
  // created_at -> last_heartbeat_at; claim duration is created_at ->
  // released_at (released claims only).
  timing: z.object({
    sessionSpanSeconds: DurationPercentiles,
    claimDurationSeconds: DurationPercentiles,
  }),
  feedbackByType: z.array(z.object({ type: z.string(), count: z.number() })),
  // Bucketed activity series (hourly for 24h, daily otherwise), each carrying
  // its aligned previous-period twin for chart overlays.
  trends: z.object({
    newAccounts: TrendSeries,
    newWorkspaces: TrendSeries,
    newSessions: TrendSeries,
    commits: TrendSeries,
    claimsReleased: TrendSeries,
  }),
  topWorkspaces: z.array(TopWorkspace),
});
