# Contributing to Shepherd

Thanks for your interest in contributing. This is a concise guide; the
engineering conventions (code style, module boundaries, the minimalism
discipline, testing bar, Definition of Done) live in [`AGENTS.md`](AGENTS.md) —
read it before writing code.

## Prerequisites

- **Node.js** — `>= 20` for build and test; `>= 22.9` if you want the dev
  scripts (`dev:hub`, `dev:mcp`, `migrate`) to auto-load `.env` (they use
  `tsx --env-file-if-exists=.env`). On older Node, export the vars in your
  shell instead.
- **Postgres** (only for the hub's DB-backed test suites, which skip cleanly
  without one). The exact setup CI uses — a `postgres:16` container with
  `TEST_DATABASE_URL=postgres://postgres:test@localhost:5432/shepherd_test` —
  is in [`.github/workflows/ci.yml`](.github/workflows/ci.yml).

## Setup and verification

```sh
npm install
npm run check   # lint + build + test — the same gate CI runs
```

## Running the hub locally

1. Copy `.env.example` to `.env` and fill in the hub's three required vars:
   `DATABASE_URL`, `TEAM_TOKEN`, and `ALLOWED_WORKSPACE`.
2. `npm run migrate` — applies the hub's database migrations.
3. `npm run dev:hub` — runs the hub in watch mode (auto-loads `.env` on
   Node >= 22.9).

`npm run dev:mcp` runs the MCP server the same way (it needs `HUB_URL` plus a
token — see `.env.example`).

## Issues and pull requests

- **Issues** — file bugs and feature requests on the
  [GitHub issue tracker](https://github.com/Korso-AI/shepherd/issues) with
  reproduction steps or a clear motivation.
- **Pull requests** — keep diffs small and focused; write tests alongside the
  change; make sure `npm run check` is green. PRs run the CI workflow
  (build + full test suite against a real Postgres).
- **Security reports** — do **not** open a public issue; follow
  [`SECURITY.md`](SECURITY.md).

Be respectful — we keep it simple: treat everyone in the project's spaces with
courtesy and assume good faith.

## License

Shepherd is licensed under AGPL-3.0-only (see [`LICENSE`](LICENSE)). By
contributing, you agree that your contributions are licensed under the same
terms.
