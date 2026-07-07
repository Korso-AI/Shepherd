# Shepherd MCP — Developer Quickstart

Coordinate your agent with everyone else's by giving it four advisory
coordination tools — `work`, `done`, `announce`, `sync` — plus the
`link`/`unlink`/`decline` lifecycle tools, backed by a shared hub. In a linked
repo your agent joins the workspace **automatically** and self-coordinates from
there: once installed, you do **not** have to tell it "use shepherd." Setup is
~2 minutes, one time.

**Shepherd needs a hub.** Either your team already runs one — get the
`HUB_URL` and token from whoever deployed it (or from the hosted dashboard) —
or you deploy one first: see
["Deploying the hub" in the README](../README.md#deploying-the-hub-gcp).

> Full reference: [`packages/mcp-server/README.md`](../packages/mcp-server/README.md)

## Your hub

|                |                                                                      |
| -------------- | -------------------------------------------------------------------- |
| **HUB_URL**    | `https://your-shepherd-hub.example.com`                              |
| **TEAM_TOKEN** | shared team secret — see "Get the token" below. **Never commit it.** |

That's all you _must_ supply. (On a **hosted** hub you set `SHEPHERD_TOKEN` — a
minted `shp_…` token from the dashboard — instead of `TEAM_TOKEN`; it carries
its own workspace, so `WORKSPACE` is ignored.) The workspace defaults to
`default`, and your identity is auto-detected from git — see
[§4](#4-optional-overrides) if you want to override any of it.

## 1. Prerequisites

You need **Node 20+**. That's it — the server is published to npm as
[`@korso/shepherd`](https://www.npmjs.com/package/@korso/shepherd) and runs via
`npx`, so there's nothing to clone or build. (Building from source is only needed
for development — see the end.)

## 2. Get the token

For a self-hosted deployment, store the team token in your own secret store. The example below uses Google Secret Manager placeholders; replace them with your deployment values.

- **If you operate the deployment:**
  ```sh
  gcloud secrets versions access latest --secret=your-team-token-secret --project=your-gcp-project
  ```
- **If you do not operate the deployment:** ask your deployment maintainer for the team token via an approved password manager. You do **not** need to store it anywhere yourself — just paste it into your MCP config below. Treat it like a password; do not put it in git or chat.

## 3. Configure your MCP client

Shepherd is a **standard stdio MCP server**, so it works with any MCP-capable
agent — Claude Code, Codex, Pi, and others. The launch command
(`npx -y --package=@korso/shepherd shepherd-mcp`) and the two required env vars are **identical
everywhere**; only _where you paste them_ differs. Find your client below.

The two values you paste in every case:

|              |                                                                                                |
| ------------ | ---------------------------------------------------------------------------------------------- |
| `HUB_URL`    | `https://your-shepherd-hub.example.com`                                                        |
| `TEAM_TOKEN` | the token from §2 (**hosted hub:** set `SHEPHERD_TOKEN` — your minted `shp_…` token — instead) |

> 💡 Set `PROGRAM` to your tool (`claude-code`, `codex`, `pi`, …) so you show up
> under the right name in the presence feed. It's optional — it just defaults to
> `claude-code` — but worth one extra line if you're not on Claude. Every other
> identity field is auto-detected from git (see [§4](#4-optional-overrides)).

> ℹ️ **Installed per client, not once.** `npx` caches the _package_ machine-wide,
> so the code is fetched once. But each tool only launches the MCP servers listed
> in **its own** config — registering in Claude does nothing for Codex or Pi. If
> you use more than one tool, add the entry to each. Same command, same two vars,
> different config location.

---

### Claude Code

> ⚠️ **Do NOT use `~/.claude/mcp.json`.** Claude Code does **not** read that file —
> a config there loads silently into nothing, with no error. Use one of the two
> options below.

**Recommended — `claude mcp add` (user scope).** One command registers it for
every project on your machine. Written as a **single line** so it pastes cleanly
into PowerShell, cmd, bash, and zsh alike (on PowerShell the bash `\`
line-continuation does _not_ work — keep it one line):

```powershell
claude mcp add shepherd -s user -e HUB_URL=https://your-shepherd-hub.example.com -e TEAM_TOKEN=<paste-token-here> -- npx -y --package=@korso/shepherd shepherd-mcp
```

**Alternative — project `.mcp.json`** at the **root of the repo you're working
in** (a real path Claude Code loads, unlike `~/.claude/mcp.json`):

```json
{
  "mcpServers": {
    "shepherd": {
      "command": "npx",
      "args": ["-y", "--package=@korso/shepherd", "shepherd-mcp"],
      "env": {
        "HUB_URL": "https://your-shepherd-hub.example.com",
        "TEAM_TOKEN": "<paste-token-here>"
      }
    }
  }
}
```

---

### Codex

Codex uses **TOML**, not JSON — its config is `~/.codex/config.toml` (global) or
`.codex/config.toml` in a trusted project. The table name is `mcp_servers` with
an **underscore**; `mcp-servers`/`mcpServers` are silently ignored.

**Recommended — `codex mcp add`:**

```powershell
codex mcp add shepherd --env HUB_URL=https://your-shepherd-hub.example.com --env TEAM_TOKEN=<paste-token-here> --env PROGRAM=codex -- npx -y --package=@korso/shepherd shepherd-mcp
```

**Alternative — edit `~/.codex/config.toml` directly:**

```toml
[mcp_servers.shepherd]
command = "npx"
args = ["-y", "--package=@korso/shepherd", "shepherd-mcp"]
env = { HUB_URL = "https://your-shepherd-hub.example.com", TEAM_TOKEN = "<paste-token-here>", PROGRAM = "codex" }
```

Check it loaded with `/mcp` in the Codex TUI.

---

### Pi

Pi uses a JSON `mcpServers` block at `~/.pi/agent/mcp.json` (global) or
`.pi/mcp.json` in the project (project overrides global):

```json
{
  "mcpServers": {
    "shepherd": {
      "command": "npx",
      "args": ["-y", "--package=@korso/shepherd", "shepherd-mcp"],
      "env": {
        "HUB_URL": "https://your-shepherd-hub.example.com",
        "TEAM_TOKEN": "<paste-token-here>",
        "PROGRAM": "pi"
      }
    }
  }
}
```

Check it loaded with `/mcp` in Pi.

---

### Cursor

Cursor uses the same JSON `mcpServers` shape, at `~/.cursor/mcp.json` (global)
or `.cursor/mcp.json` in the project:

```json
{
  "mcpServers": {
    "shepherd": {
      "command": "npx",
      "args": ["-y", "--package=@korso/shepherd", "shepherd-mcp"],
      "env": {
        "HUB_URL": "https://your-shepherd-hub.example.com",
        "TEAM_TOKEN": "<paste-token-here>",
        "PROGRAM": "cursor"
      }
    }
  }
}
```

Check it loaded under **Settings → MCP** — `shepherd` should be listed with its
tools. (Announcement push is handled by the auto-installed `beforeSubmitPrompt`
hook in `~/.cursor/hooks.json`, plus the universal drainer on every Shepherd
tool call.)

---

### Any other MCP client

If your tool speaks MCP, it accepts a stdio server with a command, args, and env.
Use the generic shape (most JSON-config clients use exactly this):

```json
{
  "mcpServers": {
    "shepherd": {
      "command": "npx",
      "args": ["-y", "--package=@korso/shepherd", "shepherd-mcp"],
      "env": {
        "HUB_URL": "https://your-shepherd-hub.example.com",
        "TEAM_TOKEN": "<paste-token-here>",
        "PROGRAM": "<your-tool>"
      }
    }
  }
}
```

Consult your client's docs for the exact config file path. The smoke test in
[§5](#5-verify-it-actually-loaded) works regardless of client.

## 4. Optional overrides

Beyond the two required vars, every identity field is **auto-resolved** at
startup in this order: **env var → git detection → fallback**. You only set one
if you want to override what's detected. The most common one to set is `MODEL`,
since it's the only field that is never auto-detected.

| Variable      | If you omit it                                                                                                                                                   | Set it when…                                                                                                                                                            |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `WORKSPACE`   | defaults to `default`; a repo's committed `.shepherd` marker wins over it, and it's **ignored entirely with `SHEPHERD_TOKEN`** (the token carries the workspace) | (self-host) a maintainer points you at a different workspace; **must match the hub's `ALLOWED_WORKSPACE` exactly** or every call degrades to "proceeding uncoordinated" |
| `REPO`        | detected from `git remote origin` as `owner/repo`, else the repo folder name, else `unknown-repo`                                                                | the auto-detected slug is wrong/ugly                                                                                                                                    |
| `BRANCH`      | detected via `git rev-parse --abbrev-ref HEAD`, else `HEAD`                                                                                                      | you want a label other than the live branch                                                                                                                             |
| `BASE_BRANCH` | detected as `origin/HEAD`, else `origin/main` / `origin/master`                                                                                                  | your trunk has a non-standard name (used for the "what changed" heads-up)                                                                                               |
| `HUMAN`       | detected from git `user.name`, else the local-part of `user.email`, else a generated name                                                                        | git identity is missing/shared, **or you run several agents at once and want distinct names**                                                                           |
| `PROGRAM`     | defaults to `claude-code`                                                                                                                                        | you're on a different tool (e.g. `codex`)                                                                                                                               |
| `MODEL`       | omitted (never detected)                                                                                                                                         | you want your model shown in the presence feed                                                                                                                          |

Example with overrides — add an `-e KEY=value` for each (single line; drop the
ones you don't need):

```powershell
claude mcp add shepherd -s user -e HUB_URL=https://your-shepherd-hub.example.com -e TEAM_TOKEN=<paste-token-here> -e HUMAN=your-name -e MODEL=opus-4.8 -- npx -y --package=@korso/shepherd shepherd-mcp
```

## 5. Verify it actually loaded

**First, confirm your client sees it.** This is the step that catches the
silent-no-load trap:

- **Claude Code:** `claude mcp list` — you want a line like
  `shepherd: npx -y --package=@korso/shepherd shepherd-mcp - ✔ Connected`. If `shepherd` is missing,
  your config is in a path Claude Code doesn't read (almost always
  `~/.claude/mcp.json`) — switch to `claude mcp add` above.
- **Codex / Pi:** open the `/mcp` panel in the TUI; `shepherd` should be listed
  as connected with its tools.

Then **restart your session** and the four coordination tools
(`work`/`done`/`announce`/`sync`) plus the `link`/`unlink`/`decline` lifecycle
tools should appear. (Joining happens automatically in a linked repo — there is
no `join` tool to call; see "link a repo" below for the one-time repo opt-in.)

**Optionally, smoke-test the server directly** (no MCP client needed, works for
any client). In **PowerShell**, set the env vars first, then run:

```powershell
$env:HUB_URL = "https://your-shepherd-hub.example.com"
$env:TEAM_TOKEN = "<paste-token-here>"
npx -y --package=@korso/shepherd shepherd-mcp
```

(bash/zsh equivalent: `HUB_URL=… TEAM_TOKEN=… npx -y --package=@korso/shepherd shepherd-mcp`.)
No stderr + the process blocking on stdin = healthy (Ctrl+C to exit).

## Gotchas

| Symptom                                                                | Fix                                                                                                                                                                                                                                                                                                                                |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `shepherd` tools never appear in your client                           | Config is in a path your client doesn't load. **Claude Code:** usually `~/.claude/mcp.json` — run `claude mcp list`, and if it's missing register with `claude mcp add` (§3). **Codex:** the TOML table must be `mcp_servers` with an underscore, in `~/.codex/config.toml`. **Pi:** `~/.pi/agent/mcp.json`. Restart after fixing. |
| `Configuration error — missing … env vars`                             | You're missing `HUB_URL`, or set neither `SHEPHERD_TOKEN` nor `TEAM_TOKEN` — those are the only required vars.                                                                                                                                                                                                                     |
| Tools return a "not linked" advisory                                   | The repo has no committed `.shepherd` marker, so the server is dormant here. Ask the agent to run `link` — it takes effect immediately (see "link a repo" below).                                                                                                                                                                  |
| Tools report "session not ready … proceeding uncoordinated" every time | The join failed. Almost always a stale token, or (self-host) a `WORKSPACE`/marker value that doesn't match the hub (leave `WORKSPACE` unset to use `default`).                                                                                                                                                                     |
| `npm error 404 … @korso/shepherd`                                      | Package name typo, or the package isn't published yet — confirm with `npm view @korso/shepherd version`                                                                                                                                                                                                                            |
| `401 Unauthorized` behaviour                                           | Wrong/old `TEAM_TOKEN` — retrieve the current token from your deployment maintainer or secret store                                                                                                                                                                                                                                |
| Your agent shows up under a surprising name/repo                       | Identity is auto-detected from git. Set `HUMAN`/`REPO`/`MODEL` explicitly (§4) to override.                                                                                                                                                                                                                                        |

## Behavior notes (so nothing surprises you)

- **Identity is auto-detected, not required.** `REPO`, `BRANCH`, `HUMAN`, and
  `BASE_BRANCH` are read from git at startup; `WORKSPACE` defaults to `default`
  and `PROGRAM` to `claude-code`. Set any of them as an env var only to override
  the detected value. `MODEL` is the one field that is never detected.
- **Claims live by TTL, not by your activity.** When you `work`, your claim stays
  visible to teammates until its TTL lapses (default 60 min) or you call `done` —
  even if you go quiet. Calling `work`/`sync` renews it.
- **`sync` shows your own claims too.** The landscape has a `YOUR ACTIVE CLAIMS`
  section so you can confirm a claim registered; other agents' claims are listed
  separately under `ACTIVE CLAIMS`.
- **Announcements are delivered once per session.** You receive each announcement
  on the first `work`/`sync` after it's posted, then it won't show again for that
  session. It's a one-time heads-up, not a persistent feed.
- **Your agent name is stable per identity.** It's derived from
  `HUMAN`+`PROGRAM`+`MODEL`, so the same person/tool/model always gets the same
  name. Two concurrent agents with identical values share one name — vary `HUMAN`
  (or `PROGRAM`) if you run several at once.
- **The token sits in plaintext** in your MCP config (`~/.claude.json` for
  `claude mcp add`, or `.mcp.json`). Treat that file like a password store; never
  commit `.mcp.json` with a real token.

The hub never hard-blocks your work: if it's unreachable, the tools return a
"proceeding uncoordinated" notice instead of erroring, so coordination is
advisory, never a gate.

## Self-hosting: link a repo to your team's hub

If you run your **own** hub (one team, one workspace), two things matter: which
token you use, and how a repo opts in.

1. **Point at your hub with your team token.** Set `HUB_URL` to your hub and
   `TEAM_TOKEN` to its shared team secret (the hub's `TEAM_TOKEN`), exactly as in
   §3 — same command, your values. Leave `WORKSPACE` unset unless your hub's
   `ALLOWED_WORKSPACE` is something other than `default`, in which case set
   `WORKSPACE` to match it **exactly** (a mismatch degrades every call to
   "proceeding uncoordinated").

2. **Opt the repo in once with a `.shepherd` marker.** A self-host MCP is
   installed globally and loads for every repo, but a repo stays dormant — no
   join, no presence, no claims — until it carries a committed `.shepherd` marker
   naming the workspace. The easiest way to write it is the **`link` tool**: ask
   your agent to run `link` with no argument and it auto-picks the one workspace
   your hub serves (your `WORKSPACE`, or `default` when unset), writes
   `.shepherd` (`{ "workspace": "<slug>" }`) at the repo root, and starts
   coordinating **immediately — no restart**. In self-host the slug validation
   is purely local (no hub call to list workspaces): `link` checks it against
   your configured `WORKSPACE`.

   Commit `.shepherd` (it's safe — it names only the workspace, never a
   token) so every teammate who clones the repo auto-joins the same workspace
   with zero setup. To opt back out, run `unlink` (removes the marker), or
   `decline` to stop being asked without linking.

> The marker is a one-time, per-repo opt-in, not an expiring token: once
> committed it just stays. There is no ephemeral "one-time link code" to redeem —
> repo opt-in is the marker, and authentication is the shared `TEAM_TOKEN`.

## Running from source (development only)

If you're hacking on the MCP server itself, point your config at a local build
instead of npx:

```sh
git clone https://github.com/Korso-AI/shepherd.git
cd shepherd && npm install && npm run build
```

Then use `node /ABSOLUTE/PATH/TO/shepherd/packages/mcp-server/dist/index.js`
(Windows: escape backslashes in JSON, or pass the path after `--` in
`claude mcp add`). Everyday users should just use `npx -y --package=@korso/shepherd shepherd-mcp` above.
