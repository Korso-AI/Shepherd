/**
 * Repo identity canonicalization — the single source of truth, shared by the
 * MCP client (which canonicalizes what it reports) and the hub (which
 * canonicalizes what it ingests). Keeping ONE implementation here is the whole
 * point: repo is the coordination boundary, and two copies that drift would
 * silently split a team — exactly the bug this code exists to prevent.
 *
 * Pure string functions, no Node/runtime deps, so both packages can import them.
 */

/** Normalize a remote URL (https or scp-like ssh) to `owner/repo`, or null. */
export function normalizeRemoteUrl(url: string): string | null {
  let s = url.trim();
  if (!s) return null;
  // Strip a trailing .git
  s = s.replace(/\.git$/, "");
  // scp-like: git@host:owner/repo  -> take the part after the colon
  const scp = s.match(/^[^/@]+@[^:]+:(.+)$/);
  if (scp) {
    s = scp[1];
  } else {
    // url form: scheme://host/owner/repo  -> strip scheme + host
    s = s.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, "");
    const slash = s.indexOf("/");
    if (slash !== -1) {
      s = s.slice(slash + 1);
    }
  }
  s = s.replace(/^\/+|\/+$/g, "");
  const segments = s.split("/").filter(Boolean);
  if (segments.length < 2) return null;
  // owner/repo are the last two segments (handles nested groups, e.g. gitlab).
  const owner = segments[segments.length - 2];
  const repo = segments[segments.length - 1];
  return `${owner}/${repo}`;
}

/**
 * Canonicalize ANY repo identifier to a stable comparison key so that two agents
 * spelling the same repo differently still land on the same value.
 *
 * The key is the BARE repo name (last path segment), lowercased. This is the one
 * form every source can agree on: an origin remote yields `owner/repo`, but a
 * clone without one falls back to a toplevel directory basename, and those two
 * CANNOT be reconciled while keeping the owner (a remote-less clone has no owner
 * to recover). Reducing both to the trailing segment makes them converge:
 *   git@github.com:Org/App.git  -> app
 *   https://github.com/Org/App  -> app
 *   Org/App                     -> app
 *   app  (basename fallback)    -> app
 *
 * Tradeoff: two genuinely-distinct repos that share a short name under different
 * owners collapse onto one key. For a coordination boundary that is the SAFE
 * error direction — a false merge makes teammates over-coordinate (visible, self-
 * correcting), whereas the false SPLIT it replaces hid teammates from each other
 * entirely. Idempotent: re-running on a bare name is a no-op.
 */
export function canonicalizeRepo(input: string): string {
  const s = input.trim();
  const looksLikeUrl = /:\/\//.test(s) || /^[^/@]+@[^:]+:/.test(s);
  const base = looksLikeUrl
    ? (normalizeRemoteUrl(s) ?? s)
    : s.replace(/\.git$/, "").replace(/^\/+|\/+$/g, "");
  // Reduce owner/repo (and any nested group path) to the trailing repo name.
  const segments = base.split("/").filter(Boolean);
  const name = segments.length > 0 ? segments[segments.length - 1] : base;
  return name.toLowerCase();
}
