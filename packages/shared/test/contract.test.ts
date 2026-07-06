import { describe, it, expect } from "vitest";
import {
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
  Claim,
  Announcement,
  Landscape,
  WorkAgentInput,
  AnnounceAgentInput,
  DoneAgentInput,
  JoinAgentInput,
  SyncAgentInput,
  ChangeRecord,
  ChangeReport,
  HeartbeatRequest,
  HeartbeatResponse,
  LeaveRequest,
  LeaveResponse,
  WorkspaceTask,
  WorkspaceLandscapeResponse,
  WorkspaceAnnouncement,
  WorkspaceAnnounceRequest,
  CreateInviteRequest,
  MintTokenResponse,
  WorkspaceSummary,
  TokenSummary,
  InviteResponse,
  FeedbackRequest,
  FeedbackResponse,
} from "../src/contract.js";

const VALID_UUID = "550e8400-e29b-41d4-a716-446655440000";
const VALID_UUID2 = "660e8400-e29b-41d4-a716-446655440001";

// ---------------------------------------------------------------------------
// Happy path: WorkRequest
// ---------------------------------------------------------------------------
describe("WorkRequest", () => {
  it("parses a valid request with required fields only (ttlSeconds absent)", () => {
    const result = WorkRequest.parse({
      sessionId: VALID_UUID,
      intent: "x",
      pathGlobs: ["src/**"],
    });
    expect(result.sessionId).toBe(VALID_UUID);
    expect(result.intent).toBe("x");
    expect(result.pathGlobs).toEqual(["src/**"]);
    expect(result.ttlSeconds).toBeUndefined();
  });

  it("parses with optional ttlSeconds present", () => {
    const result = WorkRequest.parse({
      sessionId: VALID_UUID,
      intent: "do something",
      pathGlobs: ["**/*.ts"],
      ttlSeconds: 300,
    });
    expect(result.ttlSeconds).toBe(300);
  });

  // Edge: empty pathGlobs array throws
  it("throws when pathGlobs is empty", () => {
    expect(() =>
      WorkRequest.parse({
        sessionId: VALID_UUID,
        intent: "x",
        pathGlobs: [],
      })
    ).toThrow();
  });

  // Edge: pathGlobs length 65 throws
  it("throws when pathGlobs has 65 entries", () => {
    const globs = Array.from({ length: 65 }, (_, i) => `src/file${i}.ts`);
    expect(() =>
      WorkRequest.parse({ sessionId: VALID_UUID, intent: "x", pathGlobs: globs })
    ).toThrow();
  });

  // Edge: ttlSeconds must be positive integer
  it("throws when ttlSeconds is 0", () => {
    expect(() =>
      WorkRequest.parse({
        sessionId: VALID_UUID,
        intent: "x",
        pathGlobs: ["src/**"],
        ttlSeconds: 0,
      })
    ).toThrow();
  });

  it("throws when ttlSeconds is negative", () => {
    expect(() =>
      WorkRequest.parse({
        sessionId: VALID_UUID,
        intent: "x",
        pathGlobs: ["src/**"],
        ttlSeconds: -5,
      })
    ).toThrow();
  });

  it("throws when sessionId is not a uuid", () => {
    expect(() =>
      WorkRequest.parse({ sessionId: "not-a-uuid", intent: "x", pathGlobs: ["src/**"] })
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Edge: body over 8192 chars throws
// ---------------------------------------------------------------------------
describe("AnnounceRequest", () => {
  it("parses successfully for a broadcast (no targetAgentName)", () => {
    const result = AnnounceRequest.parse({
      sessionId: VALID_UUID,
      body: "hello world",
    });
    expect(result.targetAgentName).toBeUndefined();
    expect(result.body).toBe("hello world");
  });

  it("parses with a specific targetAgentName", () => {
    const result = AnnounceRequest.parse({
      sessionId: VALID_UUID,
      body: "targeted message",
      targetAgentName: "GreenCastle",
    });
    expect(result.targetAgentName).toBe("GreenCastle");
  });

  it("parses with targetAgentName: null (explicit broadcast)", () => {
    const result = AnnounceRequest.parse({
      sessionId: VALID_UUID,
      body: "broadcast",
      targetAgentName: null,
    });
    expect(result.targetAgentName).toBeNull();
  });

  it("parses with the unified target (agent, member, or operator label)", () => {
    const result = AnnounceRequest.parse({
      sessionId: VALID_UUID,
      body: "for alice",
      target: "Alice Chen",
    });
    expect(result.target).toBe("Alice Chen");
    // Absent => broadcast, same as the legacy fields.
    expect(AnnounceRequest.parse({ sessionId: VALID_UUID, body: "b" }).target).toBeUndefined();
    // Empty target is malformed (broadcast is expressed by omission/null).
    expect(() =>
      AnnounceRequest.parse({ sessionId: VALID_UUID, body: "b", target: "" })
    ).toThrow();
  });

  it("throws when body exceeds 8192 characters", () => {
    const body = "a".repeat(8193);
    expect(() => AnnounceRequest.parse({ sessionId: VALID_UUID, body })).toThrow();
  });

  it("throws when body is empty", () => {
    expect(() => AnnounceRequest.parse({ sessionId: VALID_UUID, body: "" })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Error: JoinRequest.parse({}) throws listing missing required fields
// ---------------------------------------------------------------------------
describe("JoinRequest", () => {
  it("throws with an empty object, reporting missing required fields", () => {
    let error: unknown;
    try {
      JoinRequest.parse({});
    } catch (e) {
      error = e;
    }
    expect(error).toBeDefined();
    // Zod error should describe the missing fields
    const message = String(error);
    expect(message).toMatch(/workspace|repo|branch|human|program|model/i);
  });

  it("parses a fully specified join request", () => {
    const result = JoinRequest.parse({
      workspace: "my-workspace",
      repo: "my-repo",
      branch: "main",
      human: "alice",
      program: "vscode",
      model: "claude-opus-4",
    });
    expect(result.workspace).toBe("my-workspace");
  });
});

// ---------------------------------------------------------------------------
// DoneRequest
// ---------------------------------------------------------------------------
describe("DoneRequest", () => {
  it("parses a valid done request", () => {
    const result = DoneRequest.parse({
      sessionId: VALID_UUID,
      workItemId: VALID_UUID2,
    });
    expect(result.workItemId).toBe(VALID_UUID2);
  });

  it("throws when workItemId is not a uuid", () => {
    expect(() =>
      DoneRequest.parse({ sessionId: VALID_UUID, workItemId: "not-a-uuid" })
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// SyncRequest / SyncResponse
// ---------------------------------------------------------------------------
describe("SyncRequest", () => {
  it("parses a valid sync request", () => {
    const result = SyncRequest.parse({ sessionId: VALID_UUID });
    expect(result.sessionId).toBe(VALID_UUID);
  });
});

// ---------------------------------------------------------------------------
// Claim and Landscape
// ---------------------------------------------------------------------------
describe("Claim", () => {
  it("parses a valid claim", () => {
    const result = Claim.parse({
      workItemId: VALID_UUID,
      agentName: "RedDragon",
      human: "alice",
      intent: "build the feature",
      pathGlobs: ["src/**"],
      expiresAt: "2026-06-22T12:00:00.000Z",
    });
    expect(result.agentName).toBe("RedDragon");
  });
});

describe("Announcement", () => {
  it("parses a valid announcement", () => {
    const result = Announcement.parse({
      id: 42,
      fromAgentName: "RedDragon",
      fromHuman: "alice",
      body: "heads up",
      targetAgentName: null,
      createdAt: "2026-06-22T12:00:00.000Z",
    });
    expect(result.id).toBe(42);
    expect(result.targetAgentName).toBeNull();
  });
});

describe("Landscape", () => {
  it("parses an empty landscape", () => {
    const result = Landscape.parse({
      conflicts: [],
      activeClaims: [],
      announcements: [],
    });
    expect(result.conflicts).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Agent input shapes (derived via .omit)
// ---------------------------------------------------------------------------
describe("Agent input shapes", () => {
  it("WorkAgentInput excludes sessionId", () => {
    const result = WorkAgentInput.parse({
      intent: "build",
      pathGlobs: ["src/**"],
    });
    expect(result.intent).toBe("build");
    // @ts-expect-error sessionId should not exist on this type
    expect((result as Record<string, unknown>).sessionId).toBeUndefined();
  });

  it("AnnounceAgentInput excludes sessionId", () => {
    const result = AnnounceAgentInput.parse({ body: "hello" });
    expect(result.body).toBe("hello");
  });

  it("DoneAgentInput excludes sessionId", () => {
    const result = DoneAgentInput.parse({ workItemId: VALID_UUID });
    expect(result.workItemId).toBe(VALID_UUID);
  });

  it("JoinAgentInput is empty object schema", () => {
    const result = JoinAgentInput.parse({});
    expect(result).toEqual({});
  });

  it("SyncAgentInput is empty object schema", () => {
    const result = SyncAgentInput.parse({});
    expect(result).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// Response schemas
// ---------------------------------------------------------------------------
describe("JoinResponse", () => {
  it("parses a valid join response", () => {
    const result = JoinResponse.parse({ agentName: "RedDragon", sessionId: VALID_UUID });
    expect(result.agentName).toBe("RedDragon");
  });
});

describe("WorkResponse", () => {
  it("parses a valid work response", () => {
    const result = WorkResponse.parse({
      workItemId: VALID_UUID,
      landscape: {
        conflicts: [],
        activeClaims: [],
        announcements: [],
      },
    });
    expect(result.workItemId).toBe(VALID_UUID);
  });
});

describe("DoneResponse", () => {
  it("parses { ok: true }", () => {
    const result = DoneResponse.parse({ ok: true });
    expect(result.ok).toBe(true);
  });
});

describe("AnnounceResponse", () => {
  it("parses { ok: true, announcementId: 7 }", () => {
    const result = AnnounceResponse.parse({ ok: true, announcementId: 7 });
    expect(result.announcementId).toBe(7);
  });
});

describe("SyncResponse", () => {
  it("parses a valid sync response", () => {
    const result = SyncResponse.parse({
      landscape: { conflicts: [], activeClaims: [], announcements: [] },
    });
    expect(result.landscape.conflicts).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Task 1.2: ChangeRecord and ChangeReport
// ---------------------------------------------------------------------------

const VALID_ISO = "2026-06-24T12:00:00.000Z";

describe("ChangeRecord", () => {
  const validChangeRecord = {
    agentName: "GreenCastle",
    human: "alice",
    branch: "feat/my-feature",
    kind: "committed" as const,
    commitSha: "abc123def456",
    message: "feat: add new thing",
    paths: ["src/foo.ts", "src/bar.ts"],
    authorIsLive: true,
    authorLastActiveAt: VALID_ISO,
    updatedAt: VALID_ISO,
  };

  it("parses a fully-populated committed ChangeRecord", () => {
    const result = ChangeRecord.parse(validChangeRecord);
    expect(result.agentName).toBe("GreenCastle");
    expect(result.kind).toBe("committed");
    expect(result.paths).toHaveLength(2);
  });

  it("parses an uncommitted ChangeRecord with null sha and message", () => {
    const result = ChangeRecord.parse({
      ...validChangeRecord,
      kind: "uncommitted",
      commitSha: null,
      message: null,
    });
    expect(result.kind).toBe("uncommitted");
    expect(result.commitSha).toBeNull();
    expect(result.message).toBeNull();
  });

  it("throws when kind is outside the enum", () => {
    expect(() =>
      ChangeRecord.parse({ ...validChangeRecord, kind: "staged" })
    ).toThrow();
  });

  it("throws when paths is an empty array", () => {
    expect(() =>
      ChangeRecord.parse({ ...validChangeRecord, paths: [] })
    ).toThrow();
  });
});

describe("ChangeReport", () => {
  const oneCommitted = {
    kind: "committed" as const,
    sha: "abc123",
    message: "fix: something",
    paths: ["src/foo.ts"],
  };
  const oneUncommitted = {
    kind: "uncommitted" as const,
    sha: null,
    message: null,
    paths: ["src/bar.ts"],
  };

  it("parses a ChangeReport with one committed and one uncommitted entry", () => {
    const result = ChangeReport.parse({
      branch: "feat/x",
      baseBranch: "main",
      head: "abc123",
      entries: [oneCommitted, oneUncommitted],
    });
    expect(result.entries).toHaveLength(2);
    expect(result.truncated).toBe(false);
  });

  it("truncated defaults to false when omitted", () => {
    const result = ChangeReport.parse({
      branch: "feat/x",
      baseBranch: "main",
      head: "abc123",
      entries: [],
    });
    expect(result.truncated).toBe(false);
  });

  it("truncated can be set to true", () => {
    const result = ChangeReport.parse({
      branch: "feat/x",
      baseBranch: "main",
      head: "abc123",
      truncated: true,
      entries: [],
    });
    expect(result.truncated).toBe(true);
  });

  it("throws when entries exceeds 600", () => {
    const entries = Array.from({ length: 601 }, () => oneCommitted);
    expect(() =>
      ChangeReport.parse({ branch: "b", baseBranch: "main", head: "h", entries })
    ).toThrow();
  });

  it("throws when an entry has paths with more than 500 items", () => {
    const bigPaths = Array.from({ length: 501 }, (_, i) => `src/file${i}.ts`);
    expect(() =>
      ChangeReport.parse({
        branch: "b",
        baseBranch: "main",
        head: "h",
        entries: [{ kind: "committed", sha: "abc", message: "m", paths: bigPaths }],
      })
    ).toThrow();
  });

  it("throws when an entry has an empty paths array", () => {
    expect(() =>
      ChangeReport.parse({
        branch: "b",
        baseBranch: "main",
        head: "h",
        entries: [{ kind: "committed", sha: "abc", message: "m", paths: [] }],
      })
    ).toThrow();
  });

  it("throws when entry kind is outside the enum", () => {
    expect(() =>
      ChangeReport.parse({
        branch: "b",
        baseBranch: "main",
        head: "h",
        entries: [{ kind: "staged", sha: null, message: null, paths: ["f.ts"] }],
      })
    ).toThrow();
  });

  it("rejects a non-hex / flag-like commit sha (argument-injection guard, SEC-1)", () => {
    for (const badSha of ["--output=/tmp/pwn", "-rf", "HEAD", "abc;rm", "z".repeat(8), "ab"]) {
      expect(() =>
        ChangeReport.parse({
          branch: "b",
          baseBranch: "main",
          head: "h",
          entries: [{ kind: "committed", sha: badSha, message: "m", paths: ["f.ts"] }],
        })
      ).toThrow();
    }
  });

  it("accepts a valid lowercase-hex commit sha", () => {
    const result = ChangeReport.parse({
      branch: "b",
      baseBranch: "main",
      head: "h",
      entries: [
        { kind: "committed", sha: "deadbeef", message: "m", paths: ["f.ts"] },
        { kind: "committed", sha: "a".repeat(40), message: "m", paths: ["g.ts"] },
      ],
    });
    expect(result.entries).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Task 1.3: JoinRequest.model optional; Landscape.changeRecords; WorkRequest/
//           SyncRequest.changeReport; HeartbeatRequest/Response; WorkAgentInput guard
// ---------------------------------------------------------------------------

describe("JoinRequest - model optional", () => {
  it("parses without model field", () => {
    const result = JoinRequest.parse({
      workspace: "ws",
      repo: "repo",
      branch: "main",
      human: "alice",
      program: "vscode",
    });
    expect(result.model).toBeUndefined();
  });

  it("parses with model field present", () => {
    const result = JoinRequest.parse({
      workspace: "ws",
      repo: "repo",
      branch: "main",
      human: "alice",
      program: "vscode",
      model: "claude-opus-4",
    });
    expect(result.model).toBe("claude-opus-4");
  });
});

describe("Landscape - changeRecords field", () => {
  it("defaults changeRecords to [] when absent", () => {
    const result = Landscape.parse({
      conflicts: [],
      activeClaims: [],
      announcements: [],
    });
    expect(result.changeRecords).toEqual([]);
  });

  it("parses with changeRecords populated", () => {
    const record = {
      agentName: "GreenCastle",
      human: "alice",
      branch: "feat/x",
      kind: "committed",
      commitSha: "abc",
      message: "m",
      paths: ["src/foo.ts"],
      authorIsLive: true,
      authorLastActiveAt: VALID_ISO,
      updatedAt: VALID_ISO,
    };
    const result = Landscape.parse({
      conflicts: [],
      activeClaims: [],
      announcements: [],
      changeRecords: [record],
    });
    expect(result.changeRecords).toHaveLength(1);
  });

  it("back-compat: old-shaped Landscape (no changeRecords) validates", () => {
    const result = Landscape.parse({
      conflicts: [],
      activeClaims: [],
      announcements: [],
    });
    expect(result.changeRecords).toEqual([]);
  });
});

describe("WorkRequest - changeReport optional", () => {
  it("parses without changeReport (back-compat)", () => {
    const result = WorkRequest.parse({
      sessionId: VALID_UUID,
      intent: "build",
      pathGlobs: ["src/**"],
    });
    expect(result.changeReport).toBeUndefined();
  });

  it("parses with changeReport present", () => {
    const result = WorkRequest.parse({
      sessionId: VALID_UUID,
      intent: "build",
      pathGlobs: ["src/**"],
      changeReport: {
        branch: "feat/x",
        baseBranch: "main",
        head: "abc",
        entries: [],
      },
    });
    expect(result.changeReport).toBeDefined();
    expect(result.changeReport!.branch).toBe("feat/x");
  });
});

describe("SyncRequest - changeReport optional", () => {
  it("parses without changeReport (back-compat)", () => {
    const result = SyncRequest.parse({ sessionId: VALID_UUID });
    expect(result.changeReport).toBeUndefined();
  });

  it("parses with changeReport present", () => {
    const result = SyncRequest.parse({
      sessionId: VALID_UUID,
      changeReport: {
        branch: "main",
        baseBranch: "main",
        head: "xyz",
        entries: [],
      },
    });
    expect(result.changeReport).toBeDefined();
  });
});

describe("WorkAgentInput - changeReport guard", () => {
  it("WorkRequest.shape contains changeReport", () => {
    expect("changeReport" in WorkRequest.shape).toBe(true);
  });

  it("WorkAgentInput.shape does NOT contain changeReport", () => {
    expect("changeReport" in WorkAgentInput.shape).toBe(false);
  });

  it("WorkAgentInput.shape does NOT contain sessionId", () => {
    expect("sessionId" in WorkAgentInput.shape).toBe(false);
  });
});

describe("HeartbeatRequest", () => {
  it("parses a valid heartbeat request", () => {
    const result = HeartbeatRequest.parse({ sessionId: VALID_UUID });
    expect(result.sessionId).toBe(VALID_UUID);
  });

  it("throws when sessionId is not a uuid", () => {
    expect(() => HeartbeatRequest.parse({ sessionId: "not-uuid" })).toThrow();
  });

  it("accepts an optional deliverAnnouncements flag", () => {
    const on = HeartbeatRequest.parse({ sessionId: VALID_UUID, deliverAnnouncements: true });
    expect(on.deliverAnnouncements).toBe(true);
    // Absent by default (old clients never send it).
    const off = HeartbeatRequest.parse({ sessionId: VALID_UUID });
    expect(off.deliverAnnouncements).toBeUndefined();
  });
});

describe("HeartbeatResponse", () => {
  it("parses { ok: true } and defaults announcements to []", () => {
    const result = HeartbeatResponse.parse({ ok: true });
    expect(result.ok).toBe(true);
    expect(result.announcements).toEqual([]);
  });

  it("carries delivered announcements when present", () => {
    const result = HeartbeatResponse.parse({
      ok: true,
      announcements: [
        {
          id: 1,
          fromAgentName: "RedDragon",
          fromHuman: "alice",
          body: "heads up",
          targetAgentName: null,
          createdAt: VALID_ISO,
        },
      ],
    });
    expect(result.announcements).toHaveLength(1);
    expect(result.announcements[0]!.body).toBe("heads up");
  });

  it("throws when ok is false", () => {
    expect(() => HeartbeatResponse.parse({ ok: false })).toThrow();
  });
});

describe("LeaveRequest", () => {
  it("parses a valid leave request", () => {
    const result = LeaveRequest.parse({ sessionId: VALID_UUID });
    expect(result.sessionId).toBe(VALID_UUID);
  });

  it("throws when sessionId is not a uuid", () => {
    expect(() => LeaveRequest.parse({ sessionId: "not-uuid" })).toThrow();
  });
});

describe("LeaveResponse", () => {
  it("parses { ok: true }", () => {
    const result = LeaveResponse.parse({ ok: true });
    expect(result.ok).toBe(true);
  });

  it("throws when ok is false", () => {
    expect(() => LeaveResponse.parse({ ok: false })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Wallboard: WorkspaceLandscapeResponse (read-only whole-workspace view)
// ---------------------------------------------------------------------------

describe("WorkspaceLandscapeResponse", () => {
  const liveAgent = {
    name: "RedDragon",
    human: "alice",
    program: "claude",
    model: "claude-opus-4",
    repo: "org/repo",
    branch: "main",
    lastHeartbeatAt: VALID_ISO,
    presence: "live" as const,
  };
  const offlineAgentNoSession = {
    name: "BlueWolf",
    human: "bob",
    program: "vscode",
    model: null,
    repo: null,
    branch: null,
    lastHeartbeatAt: null,
    presence: "offline" as const,
  };
  const task = {
    agentName: "RedDragon",
    program: "claude",
    model: "claude-opus-4",
    repo: "org/repo",
    intent: "build the feature",
    pathGlobs: ["src/**"],
    status: "active" as const,
    createdAt: VALID_ISO,
    endedAt: null,
  };
  const announcement = {
    fromAgentName: "RedDragon",
    fromHuman: "alice",
    body: "heads up",
    targetAgentName: null,
    repo: "org/repo",
    createdAt: VALID_ISO,
  };

  it("round-trips a fully-populated workspace landscape", () => {
    const result = WorkspaceLandscapeResponse.parse({
      agents: [liveAgent, offlineAgentNoSession],
      tasks: [task],
      announcements: [announcement],
      serverTime: VALID_ISO,
    });
    expect(result.agents).toHaveLength(2);
    expect(result.agents[1]!.model).toBeNull();
    expect(result.agents[1]!.repo).toBeNull();
    expect(result.agents[1]!.presence).toBe("offline");
    expect(result.tasks[0]!.status).toBe("active");
    expect(result.announcements[0]!.targetAgentName).toBeNull();
    expect(result.announcements[0]!.repo).toBe("org/repo");
    expect(result.serverTime).toBe(VALID_ISO);
  });

  it("parses an empty landscape", () => {
    const result = WorkspaceLandscapeResponse.parse({
      agents: [],
      tasks: [],
      announcements: [],
      serverTime: VALID_ISO,
    });
    expect(result.agents).toHaveLength(0);
  });

  it("throws when presence is outside the enum", () => {
    expect(() =>
      WorkspaceLandscapeResponse.parse({
        agents: [{ ...liveAgent, presence: "busy" }],
        tasks: [],
        announcements: [],
        serverTime: VALID_ISO,
      })
    ).toThrow();
  });

  it("throws when serverTime is missing", () => {
    expect(() =>
      WorkspaceLandscapeResponse.parse({
        agents: [],
        tasks: [],
        announcements: [],
      })
    ).toThrow();
  });
});

describe("WorkspaceTask", () => {
  it("parses a valid active task", () => {
    const parsed = WorkspaceTask.parse({
      agentName: "RedDragon",
      program: "claude-code",
      model: "opus",
      repo: "my-repo",
      intent: "refactor auth",
      pathGlobs: ["src/auth/**"],
      status: "active",
      createdAt: "2026-06-25T12:00:00.000Z",
      endedAt: null,
    });
    expect(parsed.status).toBe("active");
    expect(parsed.endedAt).toBeNull();
  });

  it("rejects an unknown status", () => {
    expect(() =>
      WorkspaceTask.parse({
        agentName: "x", program: "p", model: null, repo: "r",
        intent: "i", pathGlobs: [], status: "paused",
        createdAt: "2026-06-25T12:00:00.000Z", endedAt: null,
      })
    ).toThrow();
  });

  it("WorkspaceAnnouncement defaults fromAdmin to false and parses true", () => {
    const agentMsg = WorkspaceAnnouncement.parse({
      fromAgentName: "alice", fromHuman: "Alice", body: "hi",
      targetAgentName: null, repo: "r", createdAt: "2026-06-25T12:00:00.000Z",
    });
    expect(agentMsg.fromAdmin).toBe(false);

    const adminMsg = WorkspaceAnnouncement.parse({
      fromAgentName: "admin@x.com", fromHuman: "admin@x.com", body: "hi",
      targetAgentName: "alice", repo: "r", fromAdmin: true,
      createdAt: "2026-06-25T12:00:00.000Z",
    });
    expect(adminMsg.fromAdmin).toBe(true);
    // Version skew: an older hub omits targetMemberName → defaults to null.
    expect(adminMsg.targetMemberName).toBeNull();
  });

  describe("WorkspaceAnnounceRequest", () => {
    it("accepts a bare broadcast (body only)", () => {
      const r = WorkspaceAnnounceRequest.parse({ body: "hello team" });
      expect(r.body).toBe("hello team");
      expect(r.targetAgentName).toBeUndefined();
      expect(r.repo).toBeUndefined();
    });

    it("accepts a DM with a target and a repo-scoped broadcast", () => {
      expect(WorkspaceAnnounceRequest.parse({ body: "hi", targetAgentName: "alice" }).targetAgentName).toBe("alice");
      expect(WorkspaceAnnounceRequest.parse({ body: "hi", repo: "org/repo" }).repo).toBe("org/repo");
    });

    it("rejects an empty body", () => {
      expect(() => WorkspaceAnnounceRequest.parse({ body: "" })).toThrow();
    });
  });

  it("round-trips a landscape response with tasks + repo on announcements", () => {
    const payload = {
      agents: [],
      tasks: [{
        agentName: "alice", program: "human", model: null, repo: "my-repo",
        intent: "fix login", pathGlobs: ["src/login/**"], status: "done",
        createdAt: "2026-06-25T11:00:00.000Z", endedAt: "2026-06-25T11:22:00.000Z",
      }],
      announcements: [{
        fromAgentName: "alice", fromHuman: "Alice", body: "heads up",
        targetAgentName: null, repo: "my-repo", fromAdmin: false, toAdmin: false,
        targetMemberName: null,
        createdAt: "2026-06-25T11:30:00.000Z",
      }],
      serverTime: "2026-06-25T12:00:00.000Z",
    };
    expect(WorkspaceLandscapeResponse.parse(payload)).toEqual(payload);
  });
});

// ---------------------------------------------------------------------------
// Task 3.2: Management endpoint contracts (workspaces, tokens, invites, members)
// ---------------------------------------------------------------------------

describe("CreateInviteRequest", () => {
  it("accepts a bare request (all fields optional)", () => {
    const r = CreateInviteRequest.parse({});
    expect(r.expiresInDays).toBeUndefined();
    expect(r.maxUses).toBeUndefined();
  });

  it("accepts expiresInDays + maxUses", () => {
    const r = CreateInviteRequest.parse({ expiresInDays: 7, maxUses: 10 });
    expect(r.expiresInDays).toBe(7);
    expect(r.maxUses).toBe(10);
  });

  it("ignores a role field — invites are member-only for now (P2.7)", () => {
    // The selectable-role surface was removed; a stray `role` is simply stripped
    // (Zod's default object behavior) rather than honored, so callers cannot mint
    // admin invites through the contract.
    const r = CreateInviteRequest.parse({ role: "admin" } as Record<string, unknown>);
    expect((r as Record<string, unknown>)["role"]).toBeUndefined();
  });

  it("rejects a non-positive / non-integer maxUses", () => {
    expect(CreateInviteRequest.safeParse({ maxUses: 0 }).success).toBe(false);
    expect(CreateInviteRequest.safeParse({ expiresInDays: -1 }).success).toBe(false);
    expect(CreateInviteRequest.safeParse({ maxUses: 1.5 }).success).toBe(false);
  });
});

describe("MintTokenResponse", () => {
  it("parses a raw token + id", () => {
    const r = MintTokenResponse.parse({ token: "shp_abc123", id: "tok_1" });
    expect(r.token).toBe("shp_abc123");
    expect(r.id).toBe("tok_1");
  });

  it("rejects a response missing the raw token", () => {
    expect(MintTokenResponse.safeParse({ id: "tok_1" }).success).toBe(false);
  });

  it("rejects a non-string token", () => {
    expect(MintTokenResponse.safeParse({ token: 123, id: "tok_1" }).success).toBe(false);
  });
});

describe("WorkspaceSummary", () => {
  it("parses a workspace summary with a valid role", () => {
    const r = WorkspaceSummary.parse({ id: "w1", slug: "acme", name: "Acme", role: "member" });
    expect(r.role).toBe("member");
  });

  it("rejects a role outside the enum", () => {
    expect(WorkspaceSummary.safeParse({ id: "w1", slug: "acme", name: "Acme", role: "guest" }).success).toBe(false);
  });
});

describe("TokenSummary", () => {
  it("parses with nullable lastUsedAt / revokedAt", () => {
    const r = TokenSummary.parse({
      id: "t1", name: null, lastUsedAt: null, createdAt: VALID_ISO, revokedAt: null,
    });
    expect(r.name).toBeNull();
    expect(r.lastUsedAt).toBeNull();
    expect(r.revokedAt).toBeNull();
  });

  it("never carries a hash or raw token (excess keys are stripped, not surfaced)", () => {
    const r = TokenSummary.parse({
      id: "t1", name: "ci", lastUsedAt: VALID_ISO, createdAt: VALID_ISO, revokedAt: null,
      hash: "secret", token: "shp_leak",
    } as Record<string, unknown>);
    expect("hash" in r).toBe(false);
    expect("token" in r).toBe(false);
  });
});

describe("InviteResponse", () => {
  it("parses with a null expiresAt (never-expiring invite)", () => {
    const r = InviteResponse.parse({ code: "INV123", expiresAt: null, maxUses: 5, useCount: 0 });
    expect(r.expiresAt).toBeNull();
    expect(r.useCount).toBe(0);
  });

  it("parses with an ISO expiresAt", () => {
    const r = InviteResponse.parse({ code: "INV123", expiresAt: VALID_ISO, maxUses: 1, useCount: 1 });
    expect(r.expiresAt).toBe(VALID_ISO);
  });
});

describe("FeedbackRequest", () => {
  it("parses a valid bug report", () => {
    const r = FeedbackRequest.parse({ type: "bug", body: "the button is broken" });
    expect(r.type).toBe("bug");
    expect(r.body).toBe("the button is broken");
  });

  it("accepts suggestion and other types", () => {
    expect(FeedbackRequest.parse({ type: "suggestion", body: "x" }).type).toBe("suggestion");
    expect(FeedbackRequest.parse({ type: "other", body: "x" }).type).toBe("other");
  });

  it("rejects a type outside the enum", () => {
    expect(FeedbackRequest.safeParse({ type: "praise", body: "x" }).success).toBe(false);
  });

  it("rejects an empty body", () => {
    expect(FeedbackRequest.safeParse({ type: "bug", body: "" }).success).toBe(false);
  });

  it("rejects a whitespace-only body", () => {
    expect(FeedbackRequest.safeParse({ type: "bug", body: "   " }).success).toBe(false);
  });

  it("trims the body", () => {
    const r = FeedbackRequest.parse({ type: "bug", body: "  hi  " });
    expect(r.body).toBe("hi");
  });

  it("rejects a body over 4000 characters", () => {
    expect(FeedbackRequest.safeParse({ type: "bug", body: "a".repeat(4001) }).success).toBe(false);
  });
});

describe("FeedbackResponse", () => {
  it("parses { ok: true, id }", () => {
    const r = FeedbackResponse.parse({ ok: true, id: VALID_UUID });
    expect(r.ok).toBe(true);
    expect(r.id).toBe(VALID_UUID);
  });

  it("throws when ok is false", () => {
    expect(() => FeedbackResponse.parse({ ok: false, id: VALID_UUID })).toThrow();
  });
});
