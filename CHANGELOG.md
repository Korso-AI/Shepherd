# Changelog

All notable changes to the published packages are documented here. The hub
(`@shepherd/hub`) and shared contract (`@shepherd/shared`) are private
monorepo packages and are not versioned independently on npm.

The format is based on [Keep a Changelog](https://keepachangelog.com/).

## Unreleased

## [@korso/shepherd 0.11.2](https://www.npmjs.com/package/@korso/shepherd/v/0.11.2) — 2026-07-12

### Fixed

- Codex hook setup now installs `UserPromptSubmit`, `SessionStart`, and wildcard
  `PreToolUse` handlers, and safely migrates Shepherd-owned legacy configs.

## [@korso/shepherd 0.11.1](https://www.npmjs.com/package/@korso/shepherd/v/0.11.1) — 2026-07-10

### Fixed

- A transient hub fault at startup (an unreachable hub or a 5xx on `/join`) no
  longer leaves the session uncoordinated until a restart: the coordination
  gate now lazily re-joins on the next tool call, with concurrent calls
  sharing a single retry. Permanent rejections (bad token, disallowed
  workspace) still fail fast and are never retried.

## [@korso/shepherd 0.11.0](https://www.npmjs.com/package/@korso/shepherd/v/0.11.0) — 2026-07-09

### Added

- Update nudge. The hub now advertises the latest published client version on
  join (baked from the monorepo at deploy time, plus an optional
  `MIN_CLIENT_VERSION` floor), and an out-of-date client appends a one-line
  note to the first coordination tool result of the session asking the agent
  to let their human know — suggesting the update command that matches how
  Shepherd is installed on that machine. At most once per session, with a
  ~24-hour per-machine cooldown; a client below the minimum supported version
  is warned every session.

## [@korso/shepherd 0.10.0](https://www.npmjs.com/package/@korso/shepherd/v/0.10.0) — 2026-07-09

### Added

- Per-session announcement mailboxes. The heartbeat's out-of-band delivery
  now targets a mailbox owned by each MCP server process, and the client hook
  pairs itself to its session's mailbox by process ancestry — so two agents
  working in the same directory can no longer consume each other's messages,
  and an agent that moves into a worktree mid-session no longer strands its
  inbox under the launch directory. Hook (passive) delivery stays enabled in
  shared directories.

### Fixed

- Announcement age stamps on every delivery path, and a 48-hour delivery
  freshness bound, so a replayed backlog can't masquerade as current
  coordination state.
- Hub-side: an agent name is not recycled to a new joiner while announcements
  sent by (or targeted at) it are still within the delivery window, so pending
  messages can't be attributed to the wrong agent.
- A hot `link` of the already-active workspace reuses the live session instead
  of re-joining under a fresh (possibly recycled) identity.
- On Windows, the auto-installed Claude Code hook command is written with
  forward slashes (`node "C:/…"`) — hook commands run through a POSIX shell,
  which ate backslash paths and broke every hook invocation.

## [@korso/shepherd-ui 0.17.0](https://www.npmjs.com/package/@korso/shepherd-ui/v/0.17.0) — 2026-07-07

### Fixed

- Sync `SHEPHERD_UI_VERSION` with package version for feedback metadata.

## [@korso/shepherd 0.9.1](https://www.npmjs.com/package/@korso/shepherd/v/0.9.1) — 2026-07-07

### Fixed

- Pi's MCP adapter discards the `initialize` `instructions` field, so Pi
  agents had the coordination tools wired up but no guidance on when to use
  them. The Pi extension now injects the same standing procedure into the
  agent's system prompt on every turn, scoped to repos with a `.shepherd`
  marker.

## [@korso/shepherd 0.9.0](https://www.npmjs.com/package/@korso/shepherd/v/0.9.0) — 2026-07-07

### Added

- Initial public npm release of the Shepherd MCP server (`shepherd-mcp` bin).
- Advisory coordination tools: `work`, `done`, `announce`, `sync`.
- Repo lifecycle tools: `link`, `unlink`, `decline`.
- Auto hook installation for Claude Code, Codex, Cursor, and Pi (opt-out via
  `SHEPHERD_NO_AUTO_HOOKS`).
