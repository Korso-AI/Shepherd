# Changelog

All notable changes to the published packages are documented here. The hub
(`@shepherd/hub`) and shared contract (`@shepherd/shared`) are private
monorepo packages and are not versioned independently on npm.

The format is based on [Keep a Changelog](https://keepachangelog.com/).

## [@korso/shepherd-ui 0.17.0](https://www.npmjs.com/package/@korso/shepherd-ui/v/0.17.0) — 2026-07-07

### Fixed

- Sync `SHEPHERD_UI_VERSION` with package version for feedback metadata.

## [@korso/shepherd 0.9.1](https://www.npmjs.com/package/@korso/shepherd/v/0.9.1) — 2026-07-07

### Fixed

- Pi's MCP adapter discards the `initialize` `instructions` field, so Pi
  agents had the coordination tools wired up but no guidance on when to use
  them. The Pi extension now injects the same standing procedure into the
  agent's system prompt on every turn, scoped to repos with a `.shepherd`
  marker.

## [@korso/shepherd 0.9.0](https://www.npmjs.com/package/@korso/shepherd/v/0.9.0) — 2026-07-07

### Added

- Initial public npm release of the Shepherd MCP server (`shepherd-mcp` bin).
- Advisory coordination tools: `work`, `done`, `announce`, `sync`.
- Repo lifecycle tools: `link`, `unlink`, `decline`.
- Auto hook installation for Claude Code, Codex, Cursor, and Pi (opt-out via
  `SHEPHERD_NO_AUTO_HOOKS`).
