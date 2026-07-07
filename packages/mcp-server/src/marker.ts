import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Repo opt-in marker (`.shepherd`) — the single, repo-local decision that a repo
 * participates in Shepherd coordination (design D8 / §5.1).
 *
 * The MCP is installed once globally and loads for EVERY repo. Without an
 * explicit marker a repo stays dormant: no `/join`, no heartbeat, no
 * coordination. The marker is committed by default (like `.editorconfig`) so
 * every teammate who clones the repo auto-joins the same workspace with zero
 * setup. It is JSON: `{ "workspace": "<slug>" }`.
 *
 * Every read here is FAIL-OPEN: a missing, garbled, or malformed marker is
 * treated as "no marker" (returns null) — it never throws and never crashes the
 * client. Coordination is advisory, so an unreadable marker degrades to dormant
 * rather than blocking the agent.
 */

const MARKER_FILENAME = ".shepherd";

/**
 * Strict workspace-slug shape the marker's `workspace` MUST match to be trusted.
 *
 * TRUST BOUNDARY: the `.shepherd` marker is attacker-controllable — it rides
 * inside any repo an agent clones, and its `workspace` value is interpolated
 * into the MCP `initialize` instructions that compliant clients inject into the
 * agent's SYSTEM PROMPT. An unconstrained string here would let a malicious
 * committed marker smuggle newlines and injected directives straight into that
 * prompt (prompt injection), while forcing the repo "linked" with zero user
 * action. So we accept only a lowercase kebab slug: it must start with an
 * alphanumeric and contain only `[a-z0-9-]`, 1–64 chars.
 *
 * This is the SAME charset the hub itself emits when it derives a workspace slug
 * from a name (`slugifyWorkspaceName` → lowercase, `[^a-z0-9]`→`-`, trimmed), so
 * every real, hub-issued slug passes; there is no exported shared validator to
 * reuse, so the pattern is pinned here as the client-side trust check.
 */
const WORKSPACE_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Parsed marker contents. Only `workspace` is meaningful today. */
export interface Marker {
  workspace: string;
}

/**
 * Walk up from `cwd` to find the repo root — the nearest ancestor containing a
 * `.git` entry. Returns null if none is found before the filesystem root. We
 * detect `.git` directly (rather than spawning `git`) so this stays cheap and
 * works in tests with throwaway dirs; `.git` may be a directory (normal repo) or
 * a file (worktree/submodule), so we accept either.
 *
 * Exported so other local, per-repo stores (e.g. {@link "./declined.js"}) can key
 * off the same repo root without duplicating the walk-up logic.
 */
export function findRepoRoot(cwd: string): string | null {
  let dir = path.resolve(cwd);
  // Bounded by the filesystem: path.dirname("/") === "/", so stop when it stops moving.
  for (;;) {
    if (fs.existsSync(path.join(dir, ".git"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Resolve the marker file path for a cwd: the repo root's `.shepherd` if a repo
 * root exists, else null (no repo → never a marker).
 */
function markerPath(cwd: string): string | null {
  const root = findRepoRoot(cwd);
  return root === null ? null : path.join(root, MARKER_FILENAME);
}

/**
 * Read the `.shepherd` marker from the repo root above `cwd`. Returns the parsed
 * `{ workspace }` when present and valid, else null. Never throws: a missing
 * file, garbled JSON, or a missing/blank/non-string `workspace` all yield null.
 *
 * A `workspace` that is a string but does NOT match {@link WORKSPACE_SLUG_PATTERN}
 * (newlines, injected directives, oversized, or an out-of-charset value) is
 * rejected the SAME way — treated as NO marker (returns null → the repo stays
 * dormant/fail-open). This is the trust-boundary check: the marker is
 * attacker-controllable via a cloned repo, so refusing to trust a malformed
 * value fails safe (dormant) rather than propagating it into agent-facing text.
 */
export function readMarker(cwd: string = process.cwd()): Marker | null {
  const file = markerPath(cwd);
  if (file === null) return null;
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    // Missing or unreadable → dormant.
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      typeof (parsed as { workspace?: unknown }).workspace === "string"
    ) {
      const workspace = (parsed as { workspace: string }).workspace;
      // Fail-open on anything that isn't a strict slug: a blank, oversized,
      // newline-bearing, or out-of-charset value is treated as no marker.
      if (WORKSPACE_SLUG_PATTERN.test(workspace)) {
        return { workspace };
      }
      return null;
    }
    return null;
  } catch {
    // Garbled JSON → treat as no marker, never crash.
    return null;
  }
}

/**
 * Write the `.shepherd` marker at the repo root above `cwd`, naming `slug` as the
 * workspace. Used by the `link` tool. Throws only if there is no repo
 * root or the write fails — callers surface that to the operator.
 */
export function writeMarker(cwd: string = process.cwd(), slug: string): void {
  const file = markerPath(cwd);
  if (file === null) {
    throw new Error("not inside a git repository — cannot write .shepherd marker");
  }
  fs.writeFileSync(file, JSON.stringify({ workspace: slug }) + "\n", "utf8");
}

/**
 * Remove the `.shepherd` marker at the repo root above `cwd`. Used by the
 * `unlink` tool. Idempotent: a missing marker (or no repo root) is a
 * no-op, never an error.
 */
export function removeMarker(cwd: string = process.cwd()): void {
  const file = markerPath(cwd);
  if (file === null) return;
  try {
    fs.rmSync(file, { force: true });
  } catch {
    // best effort — already gone or unremovable; opting out is advisory.
  }
}
