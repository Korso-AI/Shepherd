import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import dts from "vite-plugin-dts";

/**
 * Library build for `@korso/shepherd-ui` — emits the auth-agnostic `.` export
 * consumed by other packages (ESM + .d.ts).
 *
 * WHY a separate config from the app build: this output must be a *library*
 * (externalized peer deps, declaration files) rather than a runnable SPA, so
 * its Rollup settings are fundamentally different and cannot share one config.
 */
export default defineConfig({
  plugins: [
    react(),
    // Emit .d.ts and ROLL THEM UP per entry (index.d.ts/selfhost.d.ts) via
    // api-extractor, inlining the referenced @shepherd/shared types with
    // `bundledPackages`. This makes the public typed surface self-contained —
    // matching the JS, which already bundles @shepherd/shared. Without it the
    // emitted .d.ts kept a bare `from "@shepherd/shared"` import that an external
    // (Phase 5) consumer could not resolve, since @shepherd/shared is
    // unpublished. (`bundleTypes` needs @microsoft/api-extractor, a devDep.)
    dts({
      entryRoot: "src",
      include: ["src/**/*.ts", "src/**/*.tsx"],
      bundleTypes: { bundledPackages: ["@shepherd/shared"] },
    }),
  ],
  build: {
    lib: {
      // Two entries: the auth-agnostic "." surface (index.js, the hosted
      // consumer API) and the token-gated self-host root ("./selfhost" ->
      // selfhost.js). Separate entries keep the gate out of "." while sharing
      // one externals/declaration config.
      entry: { index: "src/index.ts", selfhost: "src/selfhost.tsx" },
      formats: ["es"],
      // Callback form (NOT the literal "[name].js"): newer Vite can emit
      // "index.js.js" from the string placeholder, so build the name ourselves.
      fileName: (_format, entryName) => `${entryName}.js`,
    },
    outDir: "dist/lib",
    emptyOutDir: true,
    rollupOptions: {
      // Externalize React (incl. the JSX runtime — bundling it would duplicate
      // React in consumers) and zod. @shepherd/shared is deliberately NOT
      // listed: it is unpublished and MUST bundle into the lib output.
      external: ["react", "react-dom", "react/jsx-runtime", "zod"],
    },
  },
});
