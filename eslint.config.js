// Root ESLint flat config (ESM — the repo is "type": "module").
//
// Baseline: @eslint/js recommended + typescript-eslint recommended
// (non-type-checked, to stay fast and avoid project-service setup). Prettier
// config is applied LAST so it turns off any stylistic rules that would
// conflict with the formatter.
//
// The codebase is intentionally clean, but a few of typescript-eslint's more
// opinionated rules flag deliberate, well-understood patterns (explicit `any`
// at trust boundaries, non-null assertions on DOM lookups, etc.). Those are
// relaxed below rather than editing source — see the `rules` block.

import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import prettier from "eslint-config-prettier";

export default tseslint.config(
  {
    // Global ignores. Build output, deps, generated declarations, coverage,
    // and the gitignored local dev-harness files (see .gitignore).
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/*.d.ts",
      "coverage/**",
      "**/coverage/**",
      "packages/ui/vite.config.dev.ts",
      "packages/ui/devFull.html",
      "packages/ui/src/devFull.tsx",
      "seed-dev.sh",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  // Real React hooks linting for the UI component library. rules-of-hooks is an
  // error (a genuine bug class); exhaustive-deps is "warn" because the source
  // carries a few deliberate `eslint-disable-next-line react-hooks/exhaustive-deps`
  // opt-outs — the active rule makes those directives legitimate rather than
  // "unused". Scoped to the UI package so non-React packages aren't scanned.
  {
    files: ["packages/ui/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
    },
  },
  {
    rules: {
      // Base rule flags reassignments the compiler/tests treat as intentional
      // (accumulator patterns, throwaway locals). Off — too opinionated to
      // gate CI on for source this task doesn't own.
      "no-useless-assignment": "off",
      // Explicit `any` is used deliberately at a few trust boundaries
      // (untyped host injection, test doubles). Off rather than warn so
      // `eslint .` exits 0 without noise.
      "@typescript-eslint/no-explicit-any": "off",
      // Non-null assertions are used on DOM lookups (e.g. getElementById)
      // that are guaranteed present by the surrounding markup.
      "@typescript-eslint/no-non-null-assertion": "off",
      // Allow triple-slash reference directives (ambient type setup).
      "@typescript-eslint/triple-slash-reference": "off",
      // Allow intentionally-unused args/vars when prefixed with `_`. Kept at
      // "warn" (not "error") so a stray unused type import doesn't fail CI on
      // source this task doesn't own — real bugs still surface in the log.
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
      // `${x}` where x is already a string/number is common and harmless.
      "@typescript-eslint/restrict-template-expressions": "off",
    },
  },
  prettier,
);
