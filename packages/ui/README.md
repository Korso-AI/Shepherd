# @korso/shepherd-ui

The Shepherd dashboard: an **auth-agnostic** React app (Vite) that renders the
workspace landscape (crew, territory, active/done work, chat) and issues operator
actions against the hub. "Auth-agnostic" means the core holds no notion of who
the user is or how they authenticated — it renders coordination state and issues
operator actions, leaving authentication to the layer in front of it.

## Install (npm)

Requires **Node 20+** and peer dependencies `react` / `react-dom` (^18 or ^19).

```tsx
import {
  ShepherdRoot,
  createShepherdClient,
  ShepherdClientProvider,
} from "@korso/shepherd-ui";
import "@korso/shepherd-ui/styles.css";

const client = createShepherdClient({
  baseUrl: "https://your-hub.example.com",
  getAuthHeader: () => ({ Authorization: "Bearer …" }), // host-owned
  onUnauthorized: () => { /* host-owned */ },
});

// Embed the full hosted shell:
<ShepherdRoot client={client} onLogout={() => { /* host-owned */ }} />

// Or compose lower-level pieces via ShepherdClientProvider + <Dashboard/>.
```

The library never reads tokens from storage — the host injects auth via
`getAuthHeader` and handles 401s via `onUnauthorized`.

## Two build outputs

One source tree, two Vite builds (`npm run build` runs both):

- **`dist/lib`** (`build:lib`) — a component library for **Korso** to embed in
  the hosted product. Exposes `<Dashboard/>`, `createShepherdClient`, the React
  context (`ShepherdClientProvider` / `useShepherdClient`), and types via the `.`
  export. It is **token-blind**: auth lives in the BFF in front of it. The
  stylesheet is opt-in (`@korso/shepherd-ui/styles.css`), not auto-imported.
- **`dist/selfhost`** (`build:app`) — a self-contained SPA the **hub serves**
  verbatim via a small hand-rolled asset route in `packages/hub/src/server.ts`
  (the hub resolves `../../ui/dist/selfhost/` and preloads the hashed assets).
  It bundles its own CSS and mounts the token-gated root.

Both `dist/` outputs are gitignored; `npm run build` (root) and the hub Docker
image regenerate them.

## Two mounts

- **Self-host (the Hub).** The Hub serves `<SelfHostApp/>` (the `./selfhost`
  export, mounted by `src/main.tsx`). This is the **one** place a team token is
  handled — the named exception to the auth-agnostic core: it prompts for the
  `TEAM_TOKEN`, persists it, builds a same-origin client that sends
  `Authorization: Bearer <token>`, and re-gates on a 401. The token gate lives
  **only** here, never in the `.` export or `<Dashboard/>`.
- **Hosted (Korso).** Korso imports `<Dashboard/>` + `createShepherdClient` from
  the `.` export and supplies its own auth layer (the BFF). No token gate.
  Hosted shells that embed `<ShepherdRoot/>` may pass `onLogout`; Shepherd renders
  the Sign out action at the bottom of Config, while the host callback performs
  the actual session cleanup and navigation (cookies, OIDC, BFF state, etc.).

## Development

```
npm -w @korso/shepherd-ui run dev    # Vite dev server for the self-host SPA
```

Other scripts: `build` (both outputs), `build:lib`, `build:app`, `type-check`
(`tsc --noEmit`), `test` (Vitest, jsdom).

## Scope note

The `dist/lib` component library is consumed by the hosted Korso product; that
integration lives outside this repository. The self-host SPA (`dist/selfhost`)
is fully served by the hub in this repo.

## License

AGPL-3.0-only — see the [repository LICENSE](https://github.com/Korso-AI/shepherd/blob/main/LICENSE)
and the [licensing section of the root README](https://github.com/Korso-AI/shepherd#license)
(the AGPL's network-service clause applies; commercial licensing is available from Korso).
