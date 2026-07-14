/**
 * Static "one door" invariants for the scopedDb layer.
 *
 * The ScopedDb brand is compile-time only, and setDbContext is an escalation
 * primitive whose safety rests on each call site holding a proof (a validated
 * row) for the scope it adopts. Neither invariant is expressible in the type
 * system, so this suite pins them by sweeping the src tree: a new escalation
 * site, a new `as ScopedDb` cast, or a stray withTransaction import fails CI
 * until it is added here — i.e. until it has been reviewed on purpose.
 *
 * Pure filesystem checks — no database needed, so this suite always runs.
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

describe("scopedDb door invariants", () => {
  it("setDbContext call sites stay pinned to the reviewed escalation list", () => {
    // Each allowed site carries its proof at the call site:
    //  - scopedDb.ts        — the definition + withContext's initial set.
    //  - sessionScope.ts    — workspace adoption after the membership check.
    //  - tenant.ts          — auth-context widening with the just-fetched
    //                         token row's account.
    //  - operations/workspaces.ts — focus on the row createWorkspace just
    //                         created for this account.
    //  - operations/account.ts    — per-workspace focus after the sole-member
    //                         proof during account deletion.
    // Adding a site is an RLS-escalation change: it needs the same review as
    // a policy change. Extend this list only alongside that review.
    expect(filesMatching(/\bsetDbContext\b/)).toEqual([
      "operations/account.ts",
      "operations/workspaces.ts",
      "scopedDb.ts",
      "sessionScope.ts",
      "tenant.ts",
    ]);
  });

  it("only scopedDb.ts mints (casts to) a ScopedDb", () => {
    // `as ScopedDb` compiles anywhere; the brand only means something while
    // withContext is the sole producer.
    expect(filesMatching(/\bas\s+(?:unknown\s+as\s+)?ScopedDb\b/)).toEqual([
      "scopedDb.ts",
    ]);
  });

  it("only scopedDb.ts imports withTransaction", () => {
    // withTransaction is the raw, context-less transaction primitive. All
    // request-serving code must come through withContext instead; db.ts is
    // its definition module.
    expect(filesMatching(/import[^;]*\bwithTransaction\b[^;]*from/)).toEqual([
      "scopedDb.ts",
    ]);
  });
});
