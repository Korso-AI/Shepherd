/**
 * Local "declined" store: per-user, per-repo record that this human said "don't
 * ask me to coordinate this repo again."
 *
 * Why this exists: `link`/`join` prompts an agent to opt a repo into Shepherd
 * coordination (see {@link "./marker.js"}). A decline must never re-prompt on the
 * next launch, but it is also not a repo-level decision — it must not land in
 * the repo tree or get committed, since a teammate on the same repo may want to
 * join. So it lives entirely under the user's home directory, keyed by the repo
 * root, mirroring {@link "./inbox.js"}'s path derivation.
 *
 * Everything here is FAIL-OPEN: a disk error never throws into the caller. A
 * read error is treated as "not declined" (never blocks a legitimate join); a
 * write error is swallowed (worst case the user is asked again next time).
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

/** On-disk shape of a decline record. Minimal, kept only for an audit trail. */
interface DeclinedFile {
  declinedAt: string;
}

/**
 * The default declined-store root, used when no dir is injected. Mirrors
 * {@link defaultInboxDir} in `inbox.ts`: falls back to the OS temp dir if the
 * home directory can't be resolved.
 */
export function defaultDeclinedDir(): string {
  let base = "";
  try {
    base = homedir();
  } catch {
    base = "";
  }
  if (!base) base = tmpdir();
  return join(base, ".shepherd", "declined");
}

/**
 * Deterministic per-repo-root file under `dir`. Keyed by the repo root (not
 * cwd) so a decline covers the whole repo regardless of the subdir the agent
 * started in. Windows paths are case-folded, matching `inboxFilePath`.
 */
export function declinedFilePath(repoRoot: string, dir: string = defaultDeclinedDir()): string {
  let normalized = resolve(repoRoot);
  if (process.platform === "win32") normalized = normalized.toLowerCase();
  const hash = createHash("sha256").update(normalized).digest("hex").slice(0, 16);
  return join(dir, hash);
}

/**
 * Whether `repoRoot` has been declined by this user on this machine. Fail-open:
 * a missing, unreadable, or garbled file all yield false — coordination degrades
 * to "not declined" rather than blocking on a corrupt local file.
 */
export function isDeclined(repoRoot: string, dir: string = defaultDeclinedDir()): boolean {
  const file = declinedFilePath(repoRoot, dir);
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    // Missing or unreadable → never declined.
    return false;
  }
  try {
    const parsed = JSON.parse(raw) as DeclinedFile;
    return typeof parsed?.declinedAt === "string";
  } catch {
    // Garbled JSON → treat as never declined, never crash.
    return false;
  }
}

/**
 * Record that `repoRoot` was declined. Creates the parent dir if needed.
 * Fail-open: a write error is swallowed — worst case the user is asked again.
 */
export function setDeclined(repoRoot: string, dir: string = defaultDeclinedDir()): void {
  const file = declinedFilePath(repoRoot, dir);
  try {
    mkdirSync(dirname(file), { recursive: true });
    const payload = JSON.stringify({ declinedAt: new Date().toISOString() } satisfies DeclinedFile);
    writeFileSync(file, payload + "\n", "utf8");
  } catch (err) {
    // Fail-open: a missed write just means the next launch prompts again.
    console.error(
      `[shepherd] declined-state write failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/**
 * Clear a decline for `repoRoot`, if any. Idempotent: a missing record (or
 * un-removable file) is a no-op, never an error.
 */
export function clearDeclined(repoRoot: string, dir: string = defaultDeclinedDir()): void {
  const file = declinedFilePath(repoRoot, dir);
  if (!existsSync(file)) return;
  try {
    rmSync(file, { force: true });
  } catch (err) {
    // best effort — already gone or unremovable.
    console.error(
      `[shepherd] declined-state clear failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}
