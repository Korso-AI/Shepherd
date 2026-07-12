# @korso/shepherd — Shepherd MCP Server

Shepherd's stdio MCP server. Gives any MCP-capable agent (Claude Code, Codex, etc.) four advisory coordination tools backed by the shared hub — `work`, `done`, `announce`, and `sync` — plus three link-lifecycle tools (`link`, `unlink`, `decline`) that opt a repo in or out of coordination. In a linked repo the agent **joins the workspace automatically** (there is no `join` tool), and the server ships standing instructions so the agent self-coordinates without the user prompting it.

> **New here?** The [developer quickstart](https://github.com/Korso-AI/shepherd/blob/main/docs/shepherd-mcp-quickstart.md) is the fastest path. TL;DR: `npx -y --package=@korso/shepherd shepherd-mcp` with the env vars below.

---

## CRITICAL: repos opt in with a `.shepherd` marker (the `link` tool)

> **Without a committed `.shepherd` marker at the repo root, the server stays DORMANT in that repo — no join, no heartbeat, no presence.**

The server is installed once per client and loads for every repo, so each repo makes its own one-time opt-in decision: a committed `.shepherd` marker (JSON: `{ "workspace": "<slug>" }`). In an unlinked repo the coordination tools return a one-line "not linked" advisory and the agent is prompted (by the standing instructions, the client hook nudge, and — on clients that support elicitation — a popup) to run the **`link` tool**, which validates the workspace, writes the marker, and activates coordination **immediately — no restart**. `unlink` opts back out; `decline` records a local "don't ask again" without linking.

The marker names the workspace and wins over the `WORKSPACE` env var. `WORKSPACE` matters only for self-host (`TEAM_TOKEN`) setups: it defaults to `default` and, if overridden, must equal the hub's `ALLOWED_WORKSPACE` exactly (a mismatch degrades every call to "proceeding uncoordinated"). With a hosted `SHEPHERD_TOKEN` the token carries its own workspace identity, so `WORKSPACE` is ignored. Committing `.shepherd` is safe — it names only the workspace, never a token — and lets teammates who clone the repo coordinate with zero setup.

---

## 1. Install

The server is published to npm and runs via `npx` — no clone or build required
(Node 20+):

```sh
npx -y --package=@korso/shepherd shepherd-mcp
```

You won't normally run that by hand; you put it in your MCP client config (below)
with the required env vars. `npx` caches the package, so startup is fast after the
first fetch, and `@korso/shepherd@latest` picks up updates automatically.

> Hacking on the server itself? See **[Develop from source](#develop-from-source)**
> at the bottom.

---

## 2. Environment variables

**Two things are required — the hub URL and exactly one credential:**

| Variable         | Description                                                                                                                                                                                                                                                                              | Example                        |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| `HUB_URL`        | Base URL of the deployed hub. Must be a **full valid URL**; plain `http` to a **non-loopback** host is **refused** (the token would travel in cleartext) unless you set `SHEPHERD_ALLOW_INSECURE_HTTP=1` — loopback (`localhost`/`127.0.0.1`/`::1`) http is always allowed for local dev | `https://shepherd.example.com` |
| `SHEPHERD_TOKEN` | **Hosted-hub credential** — a minted `shp_…` token from the dashboard. It carries its own workspace identity (so `WORKSPACE` is ignored) and **wins over `TEAM_TOKEN`** when both are set                                                                                                | `shp_abc123`                   |
| `TEAM_TOKEN`     | **Self-host credential** — the shared bearer token matching the hub's `TEAM_TOKEN`                                                                                                                                                                                                       | `tok_abc123`                   |

A missing/invalid `HUB_URL`, or having neither token, causes an immediate
startup failure with a clear error on stderr listing what's wrong. (No other
var triggers this.)

**Everything else is optional** — each identity field is resolved at startup as
**env var → git detection → fallback**, so a plain `npx -y --package=@korso/shepherd shepherd-mcp` with
just `HUB_URL` and a token produces a valid, fully-identified session. Set an
override only to replace what's detected:

| Variable                       | If omitted                                                                                                                                                                                                                               | Example             |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| `WORKSPACE`                    | self-host only — defaults to `default` (**must match hub's `ALLOWED_WORKSPACE` if overridden**); ignored with `SHEPHERD_TOKEN`, and a repo's `.shepherd` marker wins over it                                                             | `shepherd`          |
| `REPO`                         | `git remote origin` → `owner/repo`, else repo folder name, else `unknown-repo`                                                                                                                                                           | `Korso-AI/shepherd` |
| `BRANCH`                       | `git rev-parse --abbrev-ref HEAD`, else `HEAD`                                                                                                                                                                                           | `main`              |
| `BASE_BRANCH`                  | `origin/HEAD`, else `origin/main` / `origin/master` (used for the change-awareness heads-up)                                                                                                                                             | `origin/main`       |
| `HUMAN`                        | git `user.name`, else local-part of `user.email`, else this device's **cached** last-detected name, else a generated name                                                                                                                | `alex`              |
| `PROGRAM`                      | defaults to `claude-code`                                                                                                                                                                                                                | `codex`             |
| `MODEL`                        | omitted — **never auto-detected**, so set it if you want it shown                                                                                                                                                                        | `claude-sonnet-4-6` |
| `HEARTBEAT_INTERVAL_SECONDS`   | defaults to `60`                                                                                                                                                                                                                         | `30`                |
| `SHEPHERD_INBOX_DIR`           | defaults to `~/.shepherd/inbox`. Override only to relocate the **announcement-push** inbox (see below); the background heartbeat writes incoming announcements here. If you set it, point your client hook/extension at the **same** dir | `~/.shepherd/inbox` |
| `SHEPHERD_NO_AUTO_HOOKS`       | unset — set to `1`/`true` to stop the server from auto-installing the client delivery hook on first run (see below)                                                                                                                      | `1`                 |
| `SHEPHERD_ALLOW_INSECURE_HTTP` | unset — set to `1`/`true` to permit a plain-`http` `HUB_URL` to a **non-loopback** host (otherwise refused; the token travels unencrypted). Loopback http never needs it                                                                 | `1`                 |

**Device-identity cache.** Whenever `HUMAN` is unset and git **does** detect a
name, that name is cached for your OS user at `~/.shepherd/identity.json`. A
later launch from a directory where git can't be read (e.g. a multi-repo
workspace root) then reuses the cached name instead of inventing a fresh random
one each time. The cache refreshes automatically the next time git reports a
different name, and an explicit `HUMAN` override always wins and never touches
the cache. It is best-effort: if the file can't be read or written, resolution
just falls back to a generated name.

---

## Announcement push (on by default)

Announcements reach an agent **without it having to ask**. The background
heartbeat pulls any pending announcements from the hub every beat and stages them
in a local **inbox file** (per working directory, under `SHEPHERD_INBOX_DIR`,
default `~/.shepherd/inbox`). That file is then drained by two paths:

1. **Universal drainer (always on, every client).** Whenever the agent calls any
   Shepherd tool (`work`/`sync`/`done`/`announce`), the result also includes
   anything sitting in the inbox. So even with no hook configured, no announcement
   is ever lost — the worst case is the old behaviour (delivered on the next
   Shepherd tool call), never silent drops.
2. **Passive client hook/extension (installed automatically, per client).** To
   get announcements **without** waiting for a Shepherd tool call — surfaced on
   the agent's next action of any kind — the client needs its hook wired up.
   **You normally don't do this by hand**: the first time the server runs under
   Claude Code, Codex, or Pi, it installs the hook itself (see _Automatic hook
   install_ below). The per-client sections that follow document exactly what
   gets installed, for auditing or manual setup.

### Automatic hook install

> **Consent disclosure — the server edits your client config on first run.**
> To deliver announcements passively, the **first time** the server runs under a
> given client on this machine it **writes to that client's own configuration
> file in your home directory**, without a separate prompt:
>
> | Client      | File it edits/creates                      | What it adds                                              |
> | ----------- | ------------------------------------------ | --------------------------------------------------------- |
> | Claude Code | `~/.claude/settings.json`                  | `SessionStart` + `PreToolUse` hook entries                |
> | Codex       | `~/.codex/config.toml`                     | the hooks feature plus all three canonical event handlers |
> | Cursor      | `~/.cursor/hooks.json`                     | a `beforeSubmitPrompt` entry                              |
> | Pi          | `~/.pi/agent/extensions/shepherd-inbox.js` | copies the bundled extension                              |
>
> Fresh installs are **additive only** (existing keys/entries are never removed
> or reordered), **record-guarded** under `~/.shepherd/hooks/`,
> **version-pinned** (the installed command runs the exact shipped build, not a
> floating `npx latest`), and **fail-open** (any file it can't confidently parse
> is left untouched with a stderr notice). Codex also has a one-time, versioned
> migration, but only when it finds both a legacy auto-install record at
> `~/.shepherd/hooks/codex.json` and the exact Shepherd-owned legacy block. It
> preserves that block and appends only the missing handlers after saving a
> persistent backup at
> `~/.shepherd/hooks/backups/codex-config-before-v2.toml`. Ambiguous or manually
> removed hooks are left alone. Existing users receive the migration after they
> update `@korso/shepherd` and restart Codex so the updated MCP server starts.
>
> **To opt out entirely, set `SHEPHERD_NO_AUTO_HOOKS=1`** — the server then never
> touches any client config, and you can wire the hook manually using the
> per-client snippets below.

On its first `initialize` handshake the server detects the connecting client
and installs the delivery hook **once per machine**:

- **Claude Code** — merges the `SessionStart` + `PreToolUse` hook entries into
  `~/.claude/settings.json` (additive JSON merge; an unparseable file is left
  untouched).
- **Codex** — enables `features.hooks` and appends canonical
  `UserPromptSubmit`, `SessionStart`, and wildcard `PreToolUse` handlers to
  `~/.codex/config.toml`. An explicit `hooks = false` is respected. Existing
  installs are migrated only when a legacy `~/.shepherd/hooks/codex.json`
  auto-install record and Shepherd's exact legacy `UserPromptSubmit` block are
  both present. The migration retains that block, appends the two missing
  handlers, and first writes a persistent backup. Update `@korso/shepherd` and
  restart Codex to run it.
- **Pi** — copies the bundled extension to
  `~/.pi/agent/extensions/shepherd-inbox.js`.
- **Cursor** — merges a `beforeSubmitPrompt` entry into `~/.cursor/hooks.json`
  (additive JSON merge). Only that event is wired: it is the one Cursor event
  verified to inject hook output into the agent's context, and wiring an
  unverified event would consume announcements without delivering them.

A record under `~/.shepherd/hooks/` guarantees at-most-once installation (and
tracks the current Codex migration version): if you remove the hook, Shepherd
won't re-add it. Everything is fail-open (an error just means no hook, never a
broken session), and `SHEPHERD_NO_AUTO_HOOKS=1` disables the whole mechanism.

Both paths read the **same** inbox file and de-duplicate by announcement id, so
running both is safe (the hub hands each announcement to exactly one drain; the
merge is just defensive). It's cheap: a **local file read — no network** (the
heartbeat already did the fetch), and it only adds to the model's context when
something is actually waiting.

It delivers to an agent **while it's active**; an idle agent picks messages up the
moment it next does anything. (Waking a fully-idle agent is out of scope — for
Claude Code that needs Channels; Codex/Pi have no equivalent.)

**The hook also carries the unlinked-repo nudge.** The server instructions tell
the agent to ask about linking on its first write in a new repo, but instructions
sitting passively in context don't trigger themselves — an agent focused on the
task can skip straight to editing. So on every invocation the hook also checks
this repo's link state and, when the repo is **neither linked (`.shepherd`
marker) nor declined**, injects a reminder to run `link`/`decline` — on
`SessionStart` (front-loads the ask), right before a file-writing tool
(`Edit`/`Write`/`MultiEdit`/`NotebookEdit`; read-only tools never nudge), and on
tool-less events like Codex's `UserPromptSubmit` or a Pi turn. The
nudge is advisory and self-extinguishing: the moment the repo is linked or
declined it goes quiet, and like everything else here it fails open.

**First-run ask (zero-setup).** Independently of the hook, the server watches an
unlinked, undeclined repo for its first file edit (a lightweight `git status`
poll) and — on clients that support MCP elicitation — asks the user directly via
a popup: _"Coordinate this repo with Shepherd?"_ with the workspace choices and
a "No — don't ask again" option. Only an explicitly **submitted** answer is
recorded (a dismissed or auto-declined popup means "ask again next session"), so
the question is answered at most once and never by accident. Linking activates
coordination live, mid-session; "don't ask again" hides the coordination tools
for that repo entirely. Clients without elicitation fall back to the
instructions + hook nudge above.

### Claude Code — `PreToolUse` + `SessionStart` hooks

_(Installed automatically on first run — shown for reference/manual setup.)_

`PreToolUse` fires before every tool, giving the most frequent passive delivery;
`SessionStart` surfaces the link ask at the top of a session in an unlinked repo.
The hook needs no arguments — it resolves the same default inbox dir the server
uses (override both with `SHEPHERD_INBOX_DIR` if you relocated it):

```json
{
  "mcpServers": {
    "shepherd": {
      "command": "npx",
      "args": ["-y", "--package=@korso/shepherd", "shepherd-mcp"],
      "env": {
        "HUB_URL": "https://shepherd.example.com",
        "TEAM_TOKEN": "tok_abc123"
      }
    }
  },
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "npx -y --package=@korso/shepherd shepherd-inbox-hook"
          }
        ]
      }
    ],
    "PreToolUse": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "npx -y --package=@korso/shepherd shepherd-inbox-hook"
          }
        ]
      }
    ]
  }
}
```

### Codex — `UserPromptSubmit` + `SessionStart` + `PreToolUse` hooks

_(Installed automatically, with legacy Shepherd configs migrated once — shown
for reference/manual setup.)_

Codex uses the **same** hook contract as Claude Code (JSON on stdin, a
`hookSpecificOutput.additionalContext` reply), so the **same bin** serves it.
`UserPromptSubmit` and `SessionStart` cover turn and session boundaries. In
local Codex testing, wildcard `PreToolUse` delivered before Bash,
`apply_patch`, and MCP calls. Other richer tool paths, including WebSearch, are
not guaranteed by the current Codex hook coverage. Hooks must be enabled with
`features.hooks = true`. In `~/.codex/config.toml`:

```toml
[features]
hooks = true

[[hooks.UserPromptSubmit]]
[[hooks.UserPromptSubmit.hooks]]
type = "command"
command = "npx -y --package=@korso/shepherd shepherd-inbox-hook"
timeout = 20

[[hooks.SessionStart]]
[[hooks.SessionStart.hooks]]
type = "command"
command = "npx -y --package=@korso/shepherd shepherd-inbox-hook"
timeout = 20

[[hooks.PreToolUse]]
matcher = "*"
[[hooks.PreToolUse.hooks]]
type = "command"
command = "npx -y --package=@korso/shepherd shepherd-inbox-hook"
timeout = 20
```

### Pi — extension

_(Installed automatically on first run — shown for reference/manual setup.)_

Pi has no stdin/stdout hook; it loads in-process extensions. The auto-install
copies the bundled extension into Pi's extensions dir; by hand:

```sh
# global, applies everywhere:
mkdir -p ~/.pi/agent/extensions
cp "$(npm root -g)/@korso/shepherd/dist/inboxExtension.js" ~/.pi/agent/extensions/shepherd-inbox.js
# …or per-project: copy into .pi/extensions/ in the repo root.
```

It runs on every user turn (`before_agent_start`), drains the same inbox, and
injects pending announcements plus the unlinked-repo nudge. (Or load it ad hoc
with `pi -e /abs/path/to/dist/inboxExtension.js`.)

### Cursor — `beforeSubmitPrompt` hook

_(Installed automatically on first run — shown for reference/manual setup.)_

Cursor runs hooks from `~/.cursor/hooks.json` with JSON on stdin and a JSON
reply on stdout; the same bin detects Cursor's dialect (BOM-prefixed payload,
`workspace_roots` instead of `cwd`) and answers with the top-level
`additionalContext` form Cursor injects into the agent's context. Only
`beforeSubmitPrompt` is used — verified (Cursor 3.9.16) to reach the model:

```json
{
  "version": 1,
  "hooks": {
    "beforeSubmitPrompt": [
      { "command": "npx -y --package=@korso/shepherd shepherd-inbox-hook" }
    ]
  }
}
```

### Notes

Every path is **fail-open**: a missing dir, unreachable hub, or any error means
nothing is surfaced and the tool call / turn proceeds normally — coordination
never blocks the agent. The inbox is keyed per working directory; two sessions in
the exact same directory share it (a benign edge — they're the same repo). If you
override `SHEPHERD_INBOX_DIR` on the server, set it on the hook/extension to the
same value (the Claude/Codex bin and the Pi extension both read
`SHEPHERD_INBOX_DIR`, or you can pass the dir as the first CLI arg to the bin).

---

## 3. MCP client configuration

### Claude Code

> **Do not use `~/.claude/mcp.json` — Claude Code does not read it** (a config
> there loads silently into nothing). Use `claude mcp add` (user scope, applies
> everywhere) or a project-root `.mcp.json`. Confirm with `claude mcp list`,
> which should show `shepherd … ✔ Connected`.

Recommended — register once at user scope. Written as a **single line** so it
pastes cleanly into PowerShell, cmd, bash, and zsh (on PowerShell the bash `\`
line-continuation does not work). Minimal: just the two required vars (identity
is auto-detected from git):

```powershell
claude mcp add shepherd -s user -e HUB_URL=https://shepherd.example.com -e TEAM_TOKEN=tok_abc123 -- npx -y --package=@korso/shepherd shepherd-mcp
```

Add any optional overrides from §2 with extra `-e` flags (e.g. `-e MODEL=claude-sonnet-4-6 -e HUMAN=alex`).

Alternative — a `.mcp.json` at the **root of the repo you're working in**
(optional overrides shown commented-style; drop the ones you don't need):

```json
{
  "mcpServers": {
    "shepherd": {
      "command": "npx",
      "args": ["-y", "--package=@korso/shepherd", "shepherd-mcp"],
      "env": {
        "HUB_URL": "https://shepherd.example.com",
        "TEAM_TOKEN": "tok_abc123",
        "MODEL": "claude-sonnet-4-6"
      }
    }
  }
}
```

> Windows note: the server is a thin stdio client to the Linux-hosted hub, and
> `npx` works the same on every OS — no file paths to escape. The hub itself runs
> on Linux (Postgres), so the Windows-native durability concerns from the spike
> don't apply to clients.

### Codex (`~/.codex/config.toml`)

Codex uses the same MCP stdio protocol but configures it in **TOML**, not JSON —
at `~/.codex/config.toml` (global) or `.codex/config.toml` in a trusted project.
The table is `mcp_servers` with an **underscore** (`mcp-servers`/`mcpServers` are
silently ignored). Either run `codex mcp add`:

```sh
codex mcp add shepherd --env HUB_URL=https://shepherd.example.com --env TEAM_TOKEN=tok_abc123 --env PROGRAM=codex -- npx -y --package=@korso/shepherd shepherd-mcp
```

…or add the table directly:

```toml
[mcp_servers.shepherd]
command = "npx"
args = ["-y", "--package=@korso/shepherd", "shepherd-mcp"]
env = { HUB_URL = "https://shepherd.example.com", TEAM_TOKEN = "tok_abc123", PROGRAM = "codex", MODEL = "o4-mini" }
```

### Pi (`~/.pi/agent/mcp.json` or `.pi/mcp.json`)

Pi uses a JSON `mcpServers` block (project config overrides global):

```json
{
  "mcpServers": {
    "shepherd": {
      "command": "npx",
      "args": ["-y", "--package=@korso/shepherd", "shepherd-mcp"],
      "env": {
        "HUB_URL": "https://shepherd.example.com",
        "TEAM_TOKEN": "tok_abc123",
        "PROGRAM": "pi"
      }
    }
  }
}
```

### Cursor (`~/.cursor/mcp.json` or `.cursor/mcp.json`)

Cursor reads the same JSON `mcpServers` shape — global at `~/.cursor/mcp.json`,
or per-project at `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "shepherd": {
      "command": "npx",
      "args": ["-y", "--package=@korso/shepherd", "shepherd-mcp"],
      "env": {
        "HUB_URL": "https://shepherd.example.com",
        "TEAM_TOKEN": "tok_abc123",
        "PROGRAM": "cursor"
      }
    }
  }
}
```

Confirm under **Settings → MCP** that `shepherd` is listed with its tools.
Announcement push: handled by the auto-installed `beforeSubmitPrompt` hook in
`~/.cursor/hooks.json` (see the Cursor hook section above) — announcements and
the link nudge land on each user turn, plus the universal drainer on every
Shepherd tool call.

---

## 4. Verify the server starts (quick smoke test)

Run with `HUB_URL` and a token set to confirm it connects and idles on stdin.
PowerShell (set env vars, then run):

```powershell
$env:HUB_URL = "https://shepherd.example.com"
$env:TEAM_TOKEN = "tok_abc123"
npx -y --package=@korso/shepherd shepherd-mcp
```

bash/zsh: `HUB_URL=https://shepherd.example.com TEAM_TOKEN=tok_abc123 npx -y --package=@korso/shepherd shepherd-mcp`

No stderr output and the process blocking on stdin = healthy. Press Ctrl+C to exit.

**Missing env vars:** with nothing set you will see:

```
[shepherd] Configuration error — missing or invalid env vars:
  HUB_URL: HUB_URL is required
```

and with `HUB_URL` set but no token:

```
[shepherd] Configuration error — missing or invalid env vars:
  SHEPHERD_TOKEN: Either SHEPHERD_TOKEN or TEAM_TOKEN is required
```

In both cases the process exits 1 immediately. This is by design. The optional
identity vars never cause this — they fall back to git detection / defaults.

**Unlinked repo:** launched from a repo with no committed `.shepherd` marker,
the server starts and idles but stays **dormant** (a one-line stderr advisory
says so): no join, no heartbeat, and the coordination tools return a "not
linked" advisory until the agent runs the `link` tool — which activates
coordination immediately, no restart.

**Wrong WORKSPACE (self-host):** if the marker (or a `WORKSPACE` override) names a workspace other than the hub's `ALLOWED_WORKSPACE`, the join is rejected and every tool call (`work`, `sync`, etc.) reports "proceeding uncoordinated". Either leave `WORKSPACE` unset (resolves to `default`) or set it to exactly match the hub's `ALLOWED_WORKSPACE`.

---

## Develop from source

Only needed if you're changing the MCP server itself. Clone the monorepo and
point your client at a local build instead of npx:

```sh
git clone https://github.com/Korso-AI/shepherd.git
cd shepherd
npm install
npm run build         # tsc -b — compiles the workspace for dev + tests
```

For an exact preview of the published artifact (a single self-contained bundle
with `@shepherd/shared` inlined), build the package directly:

```sh
npm run build --workspace=@korso/shepherd   # runs tsup → packages/mcp-server/dist/index.js
```

Then use `node /absolute/path/to/shepherd/packages/mcp-server/dist/index.js` as
the `command` in your MCP config (Windows: escape backslashes in JSON).

### Publishing a new version

```sh
# bump "version" in packages/mcp-server/package.json, then:
npm publish --workspace=@korso/shepherd   # prepublishOnly runs tsup automatically
```

`publishConfig.access` is `public`, so the scoped package publishes publicly.

---

## Troubleshooting

| Symptom                                                     | Likely cause                                                                                                    | Fix                                                                                                                                                                                      |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Configuration error — missing or invalid env vars`         | `HUB_URL` is absent/not a valid URL, or neither `SHEPHERD_TOKEN` nor `TEAM_TOKEN` is set                        | Add the missing var(s) to your client's `env` block                                                                                                                                      |
| Tools return a "not linked" advisory                        | The repo has no committed `.shepherd` marker, so the server is dormant here                                     | Ask the agent to run the `link` tool (takes effect immediately) — or `decline` to stop being asked                                                                                       |
| Tools report "session not ready … proceeding uncoordinated" | Join rejected — usually a stale/revoked token, or (self-host) a workspace the hub doesn't allow                 | Re-check the token; leave `WORKSPACE` unset (→ `default`) or match the hub's `ALLOWED_WORKSPACE`                                                                                         |
| Agent shows up under a surprising name/repo/branch          | Identity auto-detected from git, or reused from the device-identity cache when launched outside a git work tree | Override with `HUMAN`/`REPO`/`BRANCH`/`MODEL` env vars (§2); a correct git `user.name` on the next in-repo launch refreshes the cache, or delete `~/.shepherd/identity.json` to clear it |
| `npm error 404 … @korso/shepherd`                           | Package not published yet, or name typo                                                                         | `npm view @korso/shepherd version` to confirm it's live                                                                                                                                  |
| Process exits immediately with no error                     | Rare; check for node version incompatibility                                                                    | Requires Node 20+ (see `engines` in package.json)                                                                                                                                        |

---

## License

AGPL-3.0-only — see the repository
[`LICENSE`](https://github.com/Korso-AI/shepherd/blob/main/LICENSE) file and the
licensing section of the
[root README](https://github.com/Korso-AI/shepherd#license): the AGPL's
network-service clause applies to modified versions run as a service, and a
separate commercial license is available from Korso — contact [support@korsoai.com](mailto:support@korsoai.com).
