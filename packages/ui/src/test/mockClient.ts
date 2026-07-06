import { vi } from "vitest";
import type { ShepherdClient } from "../client.js";

// ---------------------------------------------------------------------------
// makeMockClient — a fully-stubbed ShepherdClient for component tests. Every
// method is a vi.fn() resolving to an empty/benign default, so a test only has
// to override the methods it exercises. DB-free: nothing hits the network.
//
// The mapped type tracks the real ShepherdClient interface, so adding a method
// to the interface turns this into a type error until a default is supplied —
// keeping the mock honest against both the singular self-host methods
// (getLandscape/announce) AND the plural workspace-scoped surface.
// ---------------------------------------------------------------------------

export type MockClient = {
  -readonly [K in keyof ShepherdClient]: ShepherdClient[K] extends (...a: infer A) => infer R
    ? ReturnType<typeof vi.fn<(...a: A) => R>>
    : ShepherdClient[K];
};

/** A schema-valid empty landscape, shared by getLandscape and landscape(). */
const EMPTY_LANDSCAPE = {
  agents: [],
  tasks: [],
  announcements: [],
  serverTime: "2026-06-29T00:00:00.000Z",
};

/** A schema-valid empty announce result, shared by announce and announceTo. */
const EMPTY_ANNOUNCE = { ok: true, announcementIds: [] };

export function makeMockClient(overrides: Partial<MockClient> = {}): MockClient {
  const base: MockClient = {
    baseUrl: "https://hub.example.run.app",

    // --- multi-workspace management surface --------------------------------
    listWorkspaces: vi.fn().mockResolvedValue({ workspaces: [] }),
    createWorkspace: vi.fn().mockResolvedValue({
      id: "ws_new",
      slug: "new",
      name: "New",
      role: "admin",
    }),
    deleteWorkspace: vi.fn().mockResolvedValue({ deleted: true }),
    deleteAccount: vi.fn().mockResolvedValue({ deleted: true }),
    mintToken: vi.fn().mockResolvedValue({ token: "shp_mock", id: "tok_mock" }),
    listTokens: vi.fn().mockResolvedValue({ tokens: [] }),
    revokeToken: vi.fn().mockResolvedValue(undefined),
    mintAccountToken: vi.fn().mockResolvedValue({ token: "shp_mock", id: "tok_mock" }),
    listAccountTokens: vi.fn().mockResolvedValue({ tokens: [] }),
    revokeAccountToken: vi.fn().mockResolvedValue(undefined),
    createInvite: vi.fn().mockResolvedValue({
      code: "INV-MOCK",
      expiresAt: null,
      maxUses: null,
      useCount: 0,
    }),
    inviteByEmail: vi.fn().mockResolvedValue({
      email: "mock@example.com",
      sentAt: "2026-06-29T00:00:00.000Z",
    }),
    listEmailInvites: vi.fn().mockResolvedValue({ invites: [] }),
    revokeInvite: vi.fn().mockResolvedValue(undefined),
    redeemInvite: vi.fn().mockResolvedValue({
      workspace: { id: "ws_joined", slug: "joined", name: "Joined", role: "member" },
    }),
    listMembers: vi.fn().mockResolvedValue({ members: [] }),
    removeMember: vi.fn().mockResolvedValue(undefined),
    leave: vi.fn().mockResolvedValue(undefined),
    landscape: vi.fn().mockResolvedValue(EMPTY_LANDSCAPE),
    announceTo: vi.fn().mockResolvedValue(EMPTY_ANNOUNCE),
    submitFeedback: vi.fn().mockResolvedValue({ ok: true, id: "fb_mock" }),

    // --- self-host singular aliases ----------------------------------------
    getLandscape: vi.fn().mockResolvedValue(EMPTY_LANDSCAPE),
    announce: vi.fn().mockResolvedValue(EMPTY_ANNOUNCE),
  };
  return Object.assign(base, overrides);
}
