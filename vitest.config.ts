import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // `passWithNoTests` is a root-only (NonProjectOptions) flag — it must live
    // here, not inside a project, so an empty filter run still exits green.
    passWithNoTests: true,
    // Vitest 4.1.9: `test.projects` runs heterogeneous suites in one `vitest run`.
    // Two projects with different environments share the same invocation:
    //   - "node": the existing TS suites (default node env).
    //   - "ui":  the React/.tsx suites under jsdom (own config file).
    projects: [
      {
        test: {
          name: "node",
          // Scope strictly to the node packages so .tsx under packages/ui is
          // NEVER collected here (it must only run under the jsdom "ui" project).
          include: [
            "packages/{shared,hub,mcp-server}/{src,test}/**/*.{test,spec}.ts",
          ],
          // The DB-gated suites all share ONE Postgres database and TRUNCATE
          // between tests. Running test files in parallel makes one file's
          // TRUNCATE (ACCESS EXCLUSIVE) deadlock against another file's
          // in-flight transaction, so the integration/operation suites must
          // execute sequentially. Unit suites are fast enough that global
          // sequential file execution costs ~nothing.
          fileParallelism: false,
        },
      },
      // The UI project supplies its own jsdom environment + React plugin so the
      // node suites' environment stays untouched.
      "./packages/ui/vitest.config.ts",
    ],
  },
});
