import { defineConfig } from "tsup";

// Build the publishable, self-contained CLI bundle.
//
// The MCP server is distributed via `npx -y @korso/shepherd`, so the published
// artifact must be runnable with ZERO unresolved workspace dependencies. The
// monorepo-internal `@shepherd/shared` is therefore bundled IN (noExternal),
// while the real registry deps (`@modelcontextprotocol/sdk`, `zod`) stay
// external and are installed by the consumer from package.json.
//
// The entry files' `#!/usr/bin/env node` shebang is preserved by esbuild, so
// each `bin` works under npx without an injected banner. inboxHook.ts is the
// announcement-push hook (shepherd-inbox-hook) for Claude Code / Codex;
// inboxExtension.ts is the equivalent Pi extension (loaded in-process by Pi).
export default defineConfig({
  entry: ["src/index.ts", "src/inboxHook.ts", "src/inboxExtension.ts"],
  format: ["esm"],
  target: "node18",
  outDir: "dist",
  clean: true,
  // Bundle the workspace-internal package; keep published deps external.
  noExternal: ["@shepherd/shared"],
  dts: false,
  // Single-file CLI; no code-splitting.
  splitting: false,
});
