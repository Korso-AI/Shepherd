import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/**
 * Application build for `@korso/shepherd-ui` — bundles the self-hostable SPA
 * (everything inlined, no externals) for the hub to serve as static files.
 *
 * WHY default base "/": the hub serves assets from the site root, so hashed
 * files emitted under /assets/ resolve correctly.
 */
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist/selfhost",
    emptyOutDir: true,
    rollupOptions: {
      input: "index.html",
    },
  },
});
