import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import type {
  CreateInviteRequestT,
  CreateWorkspaceRequestT,
  InviteResponseT,
  MemberSummaryT,
  MintTokenRequestT,
  TokenSummaryT,
  WorkspaceAnnounceRequestT,
  WorkspaceSummaryT,
} from "@shepherd/shared";
import "./styles.css";
import { ShepherdClientProvider } from "./context.js";
import type { ShepherdClient } from "./client.js";
import { ShepherdRoot } from "./ShepherdRoot.js";

// ---------------------------------------------------------------------------
// Dev-only visual preview of the Config surface. NOT part of the published
// library or the self-host build (vite.config.app.ts's build:app only bundles
// index.html) — `npm run dev` serves this alongside it at /preview.html. Backs
// every ShepherdClient method with in-memory state instead of a real Hub, so
// the redesign can be clicked through without Postgres or a minted token.
// ---------------------------------------------------------------------------

const EMPTY_LANDSCAPE = {
  agents: [],
  tasks: [],
  announcements: [],
  serverTime: new Date().toISOString(),
};
const EMPTY_ANNOUNCE = { ok: true as const, announcementIds: [] };

let members: MemberSummaryT[] = [
  { accountId: "acc_admin", displayName: "Preview Admin", githubLogin: "preview-admin", email: null, avatarUrl: null, role: "admin" },
  { accountId: "acc_1", displayName: "Alex Rivera", githubLogin: "arivera", email: null, avatarUrl: null, role: "member" },
  { accountId: "acc_2", displayName: "Sam Okafor", githubLogin: "sokafor", email: null, avatarUrl: null, role: "member" },
];

let tokens: TokenSummaryT[] = [
  {
    id: "tok_1",
    name: "laptop",
    createdAt: "2026-06-01T00:00:00.000Z",
    lastUsedAt: "2026-06-29T10:00:00.000Z",
    revokedAt: null,
  },
  {
    id: "tok_2",
    name: null,
    createdAt: "2026-06-20T00:00:00.000Z",
    lastUsedAt: null,
    revokedAt: null,
  },
];

let nextTokenId = 3;
let lastInvite: InviteResponseT | null = null;

// A small mutable list so the app-bar workspace switcher (switch / create /
// join) can be clicked through — create/join append here, listWorkspaces reads it.
let workspaces: WorkspaceSummaryT[] = [
  { id: "ws_preview", slug: "design", name: "Design Review", role: "admin" },
  { id: "ws_acme", slug: "acme", name: "Acme Engineering", role: "member" },
];
let nextWsId = 1;

const previewClient: ShepherdClient = {
  baseUrl: "https://hub.example.run.app",

  listWorkspaces: async () => ({ workspaces }),
  createWorkspace: async (body: CreateWorkspaceRequestT) => {
    const ws: WorkspaceSummaryT = {
      id: `ws_new_${nextWsId++}`,
      slug: "new",
      name: body.name,
      role: "admin",
    };
    workspaces = [...workspaces, ws];
    return ws;
  },
  deleteWorkspace: async (workspaceId: string) => {
    workspaces = workspaces.filter((w) => w.id !== workspaceId);
    return { deleted: true as const };
  },

  mintToken: async (_workspaceId, body: MintTokenRequestT) => {
    const id = `tok_${nextTokenId++}`;
    tokens = [
      ...tokens,
      { id, name: body.name ?? null, createdAt: new Date().toISOString(), lastUsedAt: null, revokedAt: null },
    ];
    return { token: `shp_previewtoken${id}`, id };
  },
  listTokens: async () => ({ tokens }),
  revokeToken: async (_workspaceId, tokenId) => {
    tokens = tokens.map((t) => (t.id === tokenId ? { ...t, revokedAt: new Date().toISOString() } : t));
  },

  mintAccountToken: async (body: MintTokenRequestT) => {
    const id = `tok_${nextTokenId++}`;
    tokens = [
      ...tokens,
      { id, name: body.name ?? null, createdAt: new Date().toISOString(), lastUsedAt: null, revokedAt: null },
    ];
    return { token: `shp_previewtoken${id}`, id };
  },
  listAccountTokens: async () => ({ tokens }),
  revokeAccountToken: async (tokenId) => {
    tokens = tokens.map((t) => (t.id === tokenId ? { ...t, revokedAt: new Date().toISOString() } : t));
  },

  createInvite: async (_workspaceId, body: CreateInviteRequestT) => {
    lastInvite = {
      code: "PREVIEW-CODE",
      expiresAt: null,
      maxUses: body.maxUses ?? null,
      useCount: 0,
    };
    return lastInvite;
  },
  inviteByEmail: async (_workspaceId, email: string) => ({
    email,
    sentAt: new Date().toISOString(),
  }),
  revokeInvite: async () => {
    lastInvite = null;
  },
  redeemInvite: async () => {
    const joined: WorkspaceSummaryT = {
      id: `ws_joined_${nextWsId++}`,
      slug: "joined",
      name: "Joined workspace",
      role: "member",
    };
    workspaces = [...workspaces, joined];
    return { workspace: joined };
  },

  listMembers: async () => ({ members }),
  removeMember: async (_workspaceId, accountId) => {
    members = members.filter((m) => m.accountId !== accountId);
  },
  leave: async () => {},

  landscape: async () => EMPTY_LANDSCAPE,
  announceTo: async (_workspaceId, _body: WorkspaceAnnounceRequestT) => EMPTY_ANNOUNCE,

  getLandscape: async () => EMPTY_LANDSCAPE,
  announce: async (_body: WorkspaceAnnounceRequestT) => EMPTY_ANNOUNCE,

  submitFeedback: async () => ({ ok: true, id: "fb_preview" }),
};

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ShepherdClientProvider client={previewClient}>
      <ShepherdRoot hubUrl="https://hub.example.run.app" />
    </ShepherdClientProvider>
  </StrictMode>,
);
