/**
 * Static "one door" invariants for the scopedDb layer.
 *
 * The ScopedDb brand is compile-time only, and setDbContext is an escalation
 * primitive whose safety rests on each call site holding a proof (a validated
 * row) for the scope it adopts. Neither invariant is expressible in the type
 * system, so this suite pins them by sweeping the src tree: a new escalation
 * site, a new brand cast, a raw pool query, or a privileged context literal
 * fails CI until it is added here — i.e. until it has been reviewed on purpose.
 *
 * Pure filesystem checks — no database needed, so this suite always runs.
 * Textual sweeps are best-effort by nature (an alias like `const p = pool`
 * evades the pool sweep); the compile-time brand remains the primary wall,
 * these pins are the tripwires for the ways AROUND it.
 */

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SRC_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../src",
);

/** Every .ts file under src, as src-relative POSIX paths. */
function srcFiles(dir = SRC_DIR): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...srcFiles(full));
    } else if (entry.name.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

function rel(file: string): string {
  return path.relative(SRC_DIR, file).split(path.sep).join("/");
}

function filesMatching(pattern: RegExp): string[] {
  return srcFiles()
    .filter((f) => pattern.test(fs.readFileSync(f, "utf8")))
    .map(rel)
    .sort();
}

/** Per-file occurrence counts for a global pattern, only files with ≥1 hit. */
function countsMatching(pattern: RegExp): Record<string, number> {
  const out: Record<string, number> = {};
  for (const f of srcFiles()) {
    const matches = fs.readFileSync(f, "utf8").match(pattern);
    if (matches !== null && matches.length > 0) {
      out[rel(f)] = matches.length;
    }
  }
  return out;
}

describe("scopedDb door invariants", () => {
  it("setDbContext CALL COUNTS stay pinned to the reviewed escalation list", () => {
    // Each allowed site carries its proof at the call site:
    //  - scopedDb.ts (2)      — the definition + withContext's initial set.
    //  - sessionScope.ts (1)  — workspace adoption after the membership check.
    //  - tenant.ts (1)        — auth-context widening with the just-fetched
    //                           token row's account.
    //  - operations/workspaces.ts (1) — focus on the row createWorkspace just
    //                           created for this account.
    //  - operations/account.ts (3)    — deleteAccount's walk: per-workspace
    //                           focus after the sole-member proof, full
    //                           workspace powers for the cascade, back to
    //                           plain account for the account-wide sweep.
    // Counted PER FILE (not just file presence) so a second unreviewed call in
    // an already-allowlisted file still trips. Adding a call is an
    // RLS-escalation change: it needs the same review as a policy change.
    expect(countsMatching(/\bsetDbContext\(/g)).toEqual({
      "operations/account.ts": 3,
      "operations/workspaces.ts": 1,
      "scopedDb.ts": 2,
      "sessionScope.ts": 1,
      "tenant.ts": 1,
    });
  });

  it("only scopedDb.ts mints (casts to) a ScopedDb — under any of its names", () => {
    // `as ScopedDb` compiles anywhere; the brand only means something while
    // withContext is the sole producer. `Queryable` is repo.ts's exported
    // alias of the same brand, and `<Brand>expr` is the angle-bracket cast —
    // all count as minting. A laundering chain (`x as never as ScopedDb`)
    // still ends in `as <Brand>`, so the tail alternative catches it.
    expect(
      filesMatching(
        /\bas\s+(?:unknown\s+as\s+)?(?:ScopedDb|Queryable)\b|<\s*(?:ScopedDb|Queryable)\s*>/,
      ),
    ).toEqual(["scopedDb.ts"]);
  });

  it("withTransaction appears only in its definition and its one wrapper", () => {
    // withTransaction is the raw, context-less transaction primitive. All
    // request-serving code must come through withContext instead. Swept as a
    // bare identifier (not just import statements) so namespace access
    // (`db.withTransaction(...)`) and re-exports trip it too. db.ts is the
    // definition; scopedDb.ts the sole caller.
    expect(filesMatching(/\bwithTransaction\b/)).toEqual([
      "db.ts",
      "scopedDb.ts",
    ]);
  });

  it("no raw pool.query/pool.connect outside the pool/migration plumbing", () => {
    // A `pool.query(...)` in an operation file compiles fine (pg.Pool has
    // query) and bypasses the door with no import and no cast. Only db.ts
    // (withTransaction's checkout) and migrate.ts (owner-connection plumbing +
    // the boot assertion) may touch the pool directly.
    expect(filesMatching(/\bpool\.(?:query|connect)\b/)).toEqual([
      "db.ts",
      "migrate.ts",
    ]);
  });

  it("privileged context literals (operator/maintenance) stay pinned", () => {
    // operator = cross-tenant reads, maintenance = unscoped writes: a NEW file
    // opening one is a privilege-surface change. scopedDb.ts holds the type
    // union; analytics.ts is the requireOperator-gated /admin rollup;
    // index.ts is boot-time self-host seeding.
    expect(filesMatching(/kind:\s*"operator"/)).toEqual([
      "operations/analytics.ts",
      "scopedDb.ts",
    ]);
    expect(filesMatching(/kind:\s*"maintenance"/)).toEqual([
      "index.ts",
      "scopedDb.ts",
    ]);
  });

  it("FOCUSED account contexts (account + workspaceId) stay pinned", () => {
    // Opening a withContext directly at {kind:"account", accountId,
    // workspaceId} is the same escalation as a setDbContext focus flip — the
    // focus unlocks a non-member workspace's membership/entitlement arms — so
    // fresh focused literals are pinned exactly like escalation call sites.
    // Sanctioned: invites.ts (the validated invite code is the capability),
    // account.ts + workspaces.ts (setDbContext focus flips on rows the caller
    // just proved), scopedDb.ts (the DbContext type + contextIds).
    expect(filesMatching(/"account"[^}]*workspaceId/)).toEqual([
      "operations/account.ts",
      "operations/invites.ts",
      "operations/workspaces.ts",
      "scopedDb.ts",
    ]);
  });
});
