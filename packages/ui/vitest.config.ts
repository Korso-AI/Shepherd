import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

/**
 * Vitest project for the React UI package. Runs `.tsx`/`.ts` suites under jsdom
 * (the node packages keep the default node environment via the root config),
 * with the React plugin for JSX transform and jest-dom matchers loaded in setup.
 */
export default defineConfig({
  plugins: [react()],
  test: {
    name: "ui",
    environment: "jsdom",
    globals: true,
    setupFiles: ["./vitest.setup.ts"],
    include: ["{src,test}/**/*.{test,spec}.{ts,tsx}"],
  },
});
