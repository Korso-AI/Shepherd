# Feedback Widget v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Polish the feedback widget's UX, silently attach client context (route/version/UA/viewport) to every submission, and email each submission to dev@korsoai.com via the hub's existing Resend integration.

**Architecture:** Optional `context` object added to the `FeedbackRequest` wire schema (packages/shared) flows widget → hub → a new `context jsonb` column. The hub's existing fetch-based `email.ts` gains `sendFeedbackEmail`, fired-and-forgotten after the DB insert so mail failures never break a submission. The widget itself is reworked in place (header/close, radiogroup segmented control, keyboard/focus handling, char counter, footer).

**Tech Stack:** TypeScript, Zod, React 18, vitest + @testing-library/react (jsdom), Fastify, pg, Resend REST API (plain fetch, no SDK).

**Spec:** `docs/superpowers/specs/2026-07-06-feedback-widget-v2-design.md` (approved, amended for discovered infra).

## Global Constraints

- Repo: `shepherd/` (npm workspaces — use `npm`, NOT pnpm, in this repo).
- Full verification gate: `npm run check` at the repo root (tsc -b + ui type-check + builds + `vitest run`). Hub DB-gated suites auto-skip without a local Postgres — that is expected and fine.
- Run a single package's tests with e.g. `npx vitest run packages/ui/src/components/FeedbackWidget.test.tsx` from the repo root.
- Migrations: atomic single-transaction files, no `COMMIT`, no `CREATE INDEX CONCURRENTLY` (invariant in `packages/hub/src/migrate.ts`). Next free number is **019**.
- No new npm dependencies anywhere.
- Email destination default: exactly `dev@korsoai.com`. Success copy: exactly `Thanks — we read every note.` Body cap: 2000 chars, counter appears at ≥80% (1600).
- ui `src/**/*.test.tsx` files are excluded from tsc (validated by vitest only); hub tests likewise run through vitest's transform.
- Commit after every task; commit messages end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- CRLF warnings from git on Windows are noise — ignore them; do not reformat unrelated files.

---

### Task 1: Wire schema — optional `context` on FeedbackRequest

**Files:**
- Modify: `packages/shared/src/contract.ts` (~line 625, the feedback block)
- Modify: `packages/shared/src/index.ts` (feedback entries at lines 65–67, 131–133, 205–207)
- Test: `packages/shared/test/contract.test.ts` (append)

**Interfaces:**
- Consumes: existing `FeedbackType`, `FeedbackRequest` Zod schemas.
- Produces: `FeedbackContext` (Zod object) and `FeedbackContextT` type exported from `@shepherd/shared`; `FeedbackRequestT` gains optional `context?: { route?, appVersion?, userAgent?, viewport? }`. Tasks 2–5 rely on these exact names.

- [ ] **Step 1: Write the failing tests** — append to `packages/shared/test/contract.test.ts` (match the file's existing describe/it style; import `FeedbackRequest` from `../src/index.js` alongside the file's existing imports):

```ts
describe("FeedbackRequest context", () => {
  it("parses without context (old clients keep working)", () => {
    const parsed = FeedbackRequest.parse({ type: "bug", body: "x" });
    expect(parsed.context).toBeUndefined();
  });

  it("parses a full context object", () => {
    const context = {
      route: "/shepherd",
      appVersion: "0.14.0",
      userAgent: "Mozilla/5.0",
      viewport: "1280x720",
    };
    const parsed = FeedbackRequest.parse({ type: "bug", body: "x", context });
    expect(parsed.context).toEqual(context);
  });

  it("accepts a partial context and strips unknown fields", () => {
    const parsed = FeedbackRequest.parse({
      type: "bug",
      body: "x",
      context: { route: "/x", extra: "nope" },
    });
    expect(parsed.context).toEqual({ route: "/x" });
  });

  it("rejects an oversized userAgent", () => {
    expect(() =>
      FeedbackRequest.parse({
        type: "bug",
        body: "x",
        context: { userAgent: "u".repeat(513) },
      })
    ).toThrow();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/shared/test/contract.test.ts`
Expected: the new tests FAIL (full-context test: `parsed.context` is undefined because Zod strips the unknown `context` key today).

- [ ] **Step 3: Implement the schema** — in `packages/shared/src/contract.ts`, replace the existing `FeedbackRequest` (lines 630–633) with:

```ts
// Optional client-gathered context attached by the feedback widget. Every
// field optional and length-capped: old clients that omit `context` entirely
// keep working, and no field is trusted beyond being a short string.
export const FeedbackContext = z.object({
  route: z.string().max(256).optional(),
  appVersion: z.string().max(256).optional(),
  userAgent: z.string().max(512).optional(),
  viewport: z.string().max(256).optional(),
});

export const FeedbackRequest = z.object({
  type: FeedbackType,
  body: z.string().trim().min(1).max(4000),
  context: FeedbackContext.optional(),
});
```

Then in `packages/shared/src/index.ts`: add `FeedbackContext,` immediately after `FeedbackType,` in BOTH lists (the import list ~line 65 and the re-export list ~line 131), add `FeedbackContext` to the `import type` list used by the z.infer block if the file imports values and types separately (mirror exactly how `FeedbackRequest` is handled), and add next to line 206:

```ts
export type FeedbackContextT = z.infer<typeof FeedbackContext>;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run packages/shared/test/contract.test.ts`
Expected: PASS (all, including pre-existing).

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/contract.ts packages/shared/src/index.ts packages/shared/test/contract.test.ts
git commit -m "feat(shared): optional client context on FeedbackRequest"
```

---

### Task 2: Hub storage — migration 019 + `insertFeedback` context param

**Files:**
- Create: `packages/hub/migrations/019_feedback_context.sql`
- Modify: `packages/hub/src/repo.ts:2275-2292` (`insertFeedback`)
- Modify: `packages/hub/src/operations/feedback.ts`
- Test: `packages/hub/test/feedback.test.ts`

**Interfaces:**
- Consumes: `FeedbackRequestT` with optional `context` (Task 1).
- Produces: `insertFeedback(pool, { workspaceId, accountId, type, body, context })` where `context: FeedbackContextT | null` (import the type from `@shepherd/shared`) — Task 3's operation changes build on this exact signature.

- [ ] **Step 1: Write the failing test** — in `packages/hub/test/feedback.test.ts`, extend `fetchFeedback`'s SELECT to include `context`:

```ts
async function fetchFeedback(
  pool: pg.Pool,
  id: string
): Promise<{
  workspace_id: string | null;
  account_id: string | null;
  type: string;
  body: string;
  context: Record<string, string> | null;
}> {
  const { rows } = await pool.query(
    `SELECT workspace_id, account_id, type, body, context FROM feedback WHERE id = $1`,
    [id]
  );
  return rows[0]!;
}
```

and add two tests inside the existing describe:

```ts
it("stores client context verbatim when supplied", async () => {
  const res = await app.inject({
    method: "POST",
    url: "/feedback",
    headers: bffHeaders("acct-carol"),
    payload: {
      type: "bug",
      body: "widget exploded",
      context: {
        route: "/shepherd",
        appVersion: "0.14.0",
        userAgent: "test-agent",
        viewport: "1280x720",
      },
    },
  });

  expect(res.statusCode).toBe(200);
  const parsed = FeedbackResponse.parse(res.json());
  const row = await fetchFeedback(pool, parsed.id);
  expect(row.context).toEqual({
    route: "/shepherd",
    appVersion: "0.14.0",
    userAgent: "test-agent",
    viewport: "1280x720",
  });
});

it("stores NULL context when the request omits it", async () => {
  const res = await app.inject({
    method: "POST",
    url: "/feedback",
    headers: bffHeaders("acct-carol"),
    payload: { type: "other", body: "no context here" },
  });

  expect(res.statusCode).toBe(200);
  const parsed = FeedbackResponse.parse(res.json());
  const row = await fetchFeedback(pool, parsed.id);
  expect(row.context).toBeNull();
});
```

- [ ] **Step 2: Run tests to verify they fail** (requires a local Postgres; if `dbAvailable` is false the suite skips — in that case verify failure by compilation/inspection and note it)

Run: `npx vitest run packages/hub/test/feedback.test.ts`
Expected: FAIL — `column "context" does not exist` (or TS error on the missing `insertFeedback` param).

- [ ] **Step 3: Implement** — create `packages/hub/migrations/019_feedback_context.sql`:

```sql
-- Migration 019: optional client context for feedback rows (feedback widget
-- v2). The widget silently attaches route / appVersion / userAgent / viewport;
-- older clients send nothing, so the column is nullable.
--
-- Atomic, single-transaction file (see the invariant in migrate.ts): no
-- COMMIT, no CREATE INDEX CONCURRENTLY. Safe to apply after 001-018.

ALTER TABLE feedback ADD COLUMN context jsonb;
```

Update `insertFeedback` in `packages/hub/src/repo.ts` (add `FeedbackContextT` to the file's existing `@shepherd/shared` type imports):

```ts
export async function insertFeedback(
  pool: pg.Pool,
  params: {
    workspaceId: string | null;
    accountId: string | null;
    type: string;
    body: string;
    /** Client-gathered context (route/appVersion/userAgent/viewport), already
     * validated + length-capped by FeedbackRequest. NULL when the (older)
     * client sent none. */
    context: FeedbackContextT | null;
  }
): Promise<string> {
  const { workspaceId, accountId, type, body, context } = params;
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO feedback (workspace_id, account_id, type, body, context)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [workspaceId, accountId, type, body, context]
  );
  return rows[0]!.id;
}
```

(`pg` serializes a plain JS object to JSON for a jsonb parameter; `null` stays SQL NULL.)

Update the `insertFeedback` call in `packages/hub/src/operations/feedback.ts` to pass the new field:

```ts
  const id = await insertFeedback(pool, {
    workspaceId: tenant.workspaceId === NO_ROUTE_WORKSPACE ? null : tenant.workspaceId,
    accountId: tenant.accountId ?? null,
    type: input.type,
    body: input.body,
    context: input.context ?? null,
  });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run packages/hub/test/feedback.test.ts` and `npx vitest run packages/hub/test/migrate.test.ts`
Expected: PASS (if `migrate.test.ts` asserts a migration count/list, update it for 019).

- [ ] **Step 5: Commit**

```bash
git add packages/hub/migrations/019_feedback_context.sql packages/hub/src/repo.ts packages/hub/src/operations/feedback.ts packages/hub/test/feedback.test.ts
git commit -m "feat(hub): store feedback client context (migration 019)"
```

---

### Task 3: Hub email — `sendFeedbackEmail` + fire-and-forget wiring

**Files:**
- Modify: `packages/hub/src/config.ts` (ConfigSchema)
- Modify: `packages/hub/src/email.ts` (append)
- Modify: `packages/hub/src/operations/feedback.ts`
- Test: create `packages/hub/test/email.feedback.test.ts`; modify `packages/hub/test/feedback.test.ts`

**Interfaces:**
- Consumes: `insertFeedback` with `context` (Task 2); existing `getContext()` returning `{ pool, config }`.
- Produces: `Config.FEEDBACK_EMAIL_TO: string` (default `"dev@korsoai.com"`); `sendFeedbackEmail(params: SendFeedbackEmailParams, config: { RESEND_API_KEY: string; INVITE_EMAIL_FROM: string; FEEDBACK_EMAIL_TO: string }): Promise<void>` exported from `packages/hub/src/email.ts` with `SendFeedbackEmailParams = { id: string; type: string; body: string; accountId: string | null; workspaceId: string | null; context: FeedbackContextT | null }`.

- [ ] **Step 1: Write the failing unit tests** — create `packages/hub/test/email.feedback.test.ts`:

```ts
/**
 * Unit tests for sendFeedbackEmail — DB-free: the global fetch is stubbed, so
 * these run everywhere (unlike the DB-gated feedback.test.ts route tests).
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { sendFeedbackEmail } from "../src/email.js";

const CONFIG = {
  RESEND_API_KEY: "re_test_key",
  INVITE_EMAIL_FROM: "Shepherd <feedback@korsoai.com>",
  FEEDBACK_EMAIL_TO: "dev@korsoai.com",
};

const PARAMS = {
  id: "fb-uuid-1",
  type: "bug",
  body: "the export button crashes the tab when the table is empty",
  accountId: "acct-alice",
  workspaceId: "ws-uuid-1",
  context: { route: "/shepherd", appVersion: "0.14.0", userAgent: "UA", viewport: "1280x720" },
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("sendFeedbackEmail", () => {
  it("POSTs the expected Resend payload", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await sendFeedbackEmail(PARAMS, CONFIG);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.resend.com/emails");
    expect(init.headers.Authorization).toBe("Bearer re_test_key");
    const payload = JSON.parse(init.body);
    expect(payload.from).toBe(CONFIG.INVITE_EMAIL_FROM);
    expect(payload.to).toBe("dev@korsoai.com");
    expect(payload.subject).toBe(
      "[Feedback] bug — the export button crashes the tab when the table is emp…"
    );
    expect(payload.text).toContain(PARAMS.body);
    expect(payload.text).toContain("account: acct-alice");
    expect(payload.text).toContain("workspace: ws-uuid-1");
    expect(payload.text).toContain("route: /shepherd");
    expect(payload.text).toContain("appVersion: 0.14.0");
    expect(payload.text).toContain("feedback id: fb-uuid-1");
  });

  it("keeps a short body un-truncated in the subject and dashes null identities", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await sendFeedbackEmail(
      { ...PARAMS, body: "short one", accountId: null, workspaceId: null, context: null },
      CONFIG
    );

    const payload = JSON.parse(fetchMock.mock.calls[0]![1].body);
    expect(payload.subject).toBe("[Feedback] bug — short one");
    expect(payload.text).toContain("account: —");
    expect(payload.text).toContain("workspace: —");
  });

  it("throws on a non-ok Resend response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("nope", { status: 422 }))
    );
    await expect(sendFeedbackEmail(PARAMS, CONFIG)).rejects.toThrow(/422/);
  });
});
```

Note: the 60-char subject snippet of the long PARAMS body is exactly `the export button crashes the tab when the table is emp` + `…`? No — count it: the expected string in the first test is `PARAMS.body.slice(0, 60) + "…"`. Compute it as the implementation does; if the literal above mismatches when you run the test, replace the literal with `` `[Feedback] bug — ${PARAMS.body.slice(0, 60)}…` `` so the assertion is exact but not hand-counted.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/hub/test/email.feedback.test.ts`
Expected: FAIL — `sendFeedbackEmail` is not exported.

- [ ] **Step 3: Implement config + email** — in `packages/hub/src/config.ts`, add to `ConfigSchema` right after the `PUBLIC_WEB_URL` line:

```ts
  // Where feedback-widget submissions are emailed. Sending is enabled only
  // when RESEND_API_KEY + INVITE_EMAIL_FROM are also set (the sender address
  // is shared with email invites); with them unset this default is inert.
  FEEDBACK_EMAIL_TO: z.string().min(1).default("dev@korsoai.com"),
```

Append to `packages/hub/src/email.ts`:

```ts
import type { FeedbackContextT } from "@shepherd/shared";

export interface SendFeedbackEmailParams {
  id: string;
  type: string;
  body: string;
  accountId: string | null;
  workspaceId: string | null;
  context: FeedbackContextT | null;
}

/**
 * Email one feedback-widget submission to the configured inbox. Same contract
 * as sendInviteEmail: the caller checks configuration BEFORE calling, and this
 * throws on a Resend rejection — but unlike invites, the feedback caller fires
 * and forgets (operations/feedback.ts), so a throw is logged, never surfaced.
 */
export async function sendFeedbackEmail(
  params: SendFeedbackEmailParams,
  config: { RESEND_API_KEY: string; INVITE_EMAIL_FROM: string; FEEDBACK_EMAIL_TO: string }
): Promise<void> {
  const { id, type, body, accountId, workspaceId, context } = params;

  const snippet = body.length > 60 ? `${body.slice(0, 60)}…` : body;
  const text = [
    body,
    "",
    `type: ${type}`,
    `account: ${accountId ?? "—"}`,
    `workspace: ${workspaceId ?? "—"}`,
    ...Object.entries(context ?? {})
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => `${key}: ${value}`),
    `feedback id: ${id}`,
  ].join("\n");

  const res = await fetch(RESEND_API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: config.INVITE_EMAIL_FROM,
      to: config.FEEDBACK_EMAIL_TO,
      subject: `[Feedback] ${type} — ${snippet}`,
      text,
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Resend API error (${res.status}): ${detail || res.statusText}`);
  }
}
```

- [ ] **Step 4: Run unit tests to verify they pass**

Run: `npx vitest run packages/hub/test/email.feedback.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing operation-wiring tests** — in `packages/hub/test/feedback.test.ts`, add at the top (after the imports, before the describe):

```ts
import { sendFeedbackEmail } from "../src/email.js";

vi.mock("../src/email.js", () => ({
  sendInviteEmail: vi.fn(),
  sendFeedbackEmail: vi.fn().mockResolvedValue(undefined),
}));
```

(add `vi` to the vitest import list), add `vi.mocked(sendFeedbackEmail).mockClear()` in the existing `afterEach`, and add tests:

```ts
it("emails the submission when Resend is configured", async () => {
  const res = await app.inject({
    method: "POST",
    url: "/feedback",
    headers: bffHeaders("acct-dave"),
    payload: { type: "bug", body: "mail me", context: { route: "/r" } },
  });
  expect(res.statusCode).toBe(200);
  const parsed = FeedbackResponse.parse(res.json());

  await vi.waitFor(() => expect(sendFeedbackEmail).toHaveBeenCalledTimes(1));
  expect(sendFeedbackEmail).toHaveBeenCalledWith(
    {
      id: parsed.id,
      type: "bug",
      body: "mail me",
      accountId: "acct-dave",
      workspaceId: null,
      context: { route: "/r" },
    },
    {
      RESEND_API_KEY: "re_test",
      INVITE_EMAIL_FROM: "Shepherd <feedback@test.local>",
      FEEDBACK_EMAIL_TO: "dev@korsoai.com",
    }
  );
});

it("still succeeds when the email send rejects", async () => {
  vi.mocked(sendFeedbackEmail).mockRejectedValueOnce(new Error("resend down"));
  const res = await app.inject({
    method: "POST",
    url: "/feedback",
    headers: bffHeaders("acct-dave"),
    payload: { type: "other", body: "mail broke, row survives" },
  });
  expect(res.statusCode).toBe(200);
});
```

For these to see a configured mailer, extend `makeTestConfig`'s literal in this file with:

```ts
    RESEND_API_KEY: "re_test",
    INVITE_EMAIL_FROM: "Shepherd <feedback@test.local>",
    PUBLIC_WEB_URL: "https://test.local",
    FEEDBACK_EMAIL_TO: "dev@korsoai.com",
```

Also add a "skips email when unconfigured" test. Since config is fixed per suite here, assert the guard at the operation level instead: temporarily reset context with an unconfigured config, call the operation directly, then restore. Simpler and sufficient:

```ts
it("does not email when Resend is unconfigured", async () => {
  resetContext();
  initContext({ pool, config: makeTestConfig({ RESEND_API_KEY: undefined, INVITE_EMAIL_FROM: undefined }) });
  try {
    const res = await app.inject({
      method: "POST",
      url: "/feedback",
      headers: bffHeaders("acct-erin"),
      payload: { type: "bug", body: "quiet" },
    });
    expect(res.statusCode).toBe(200);
    expect(sendFeedbackEmail).not.toHaveBeenCalled();
  } finally {
    resetContext();
    initContext({ pool, config: makeTestConfig() });
  }
});
```

Additionally add one config test to `packages/hub/test/config.test.ts` (match its style):

```ts
it("defaults FEEDBACK_EMAIL_TO to dev@korsoai.com", () => {
  const cfg = loadConfig({
    DATABASE_URL: "postgres://x",
    TEAM_TOKEN: "t",
    ALLOWED_WORKSPACE: "w",
  });
  expect(cfg.FEEDBACK_EMAIL_TO).toBe("dev@korsoai.com");
});
```

- [ ] **Step 6: Run tests to verify the new ones fail**

Run: `npx vitest run packages/hub/test/feedback.test.ts packages/hub/test/config.test.ts`
Expected: config default test PASSES already after Step 3; the two mailer-wiring tests FAIL (`sendFeedbackEmail` never called) — that's the signal to wire the operation.

- [ ] **Step 7: Wire the operation** — `packages/hub/src/operations/feedback.ts` becomes:

```ts
/**
 * submitFeedback operation: record a "bug"/"suggestion"/"other" note from the
 * feedback widget. Accepts ANY resolved tenant — self-host TEAM_TOKEN, an agent
 * shp_ token, or a hosted browser call with no route-derived workspace all land
 * a row, capturing whatever workspace/account context happens to be present
 * rather than requiring either (feedback is not workspace-scoped data).
 *
 * When Resend is configured (RESEND_API_KEY + INVITE_EMAIL_FROM — the sender
 * is shared with email invites), each submission is also emailed to
 * FEEDBACK_EMAIL_TO, fire-and-forget: the row is the source of truth, so a
 * mail failure is logged but never fails or delays the response.
 */

import type { FeedbackRequestT, FeedbackResponseT } from "@shepherd/shared";
import { getContext } from "../context.js";
import { sendFeedbackEmail } from "../email.js";
import { insertFeedback } from "../repo.js";
import { NO_ROUTE_WORKSPACE, type TenantContext } from "../tenant.js";

export async function submitFeedback(
  input: FeedbackRequestT,
  tenant: TenantContext
): Promise<FeedbackResponseT> {
  const { pool, config } = getContext();

  const workspaceId =
    tenant.workspaceId === NO_ROUTE_WORKSPACE ? null : tenant.workspaceId;
  const accountId = tenant.accountId ?? null;
  const context = input.context ?? null;

  const id = await insertFeedback(pool, {
    workspaceId,
    accountId,
    type: input.type,
    body: input.body,
    context,
  });

  if (config.RESEND_API_KEY && config.INVITE_EMAIL_FROM) {
    void sendFeedbackEmail(
      { id, type: input.type, body: input.body, accountId, workspaceId, context },
      {
        RESEND_API_KEY: config.RESEND_API_KEY,
        INVITE_EMAIL_FROM: config.INVITE_EMAIL_FROM,
        FEEDBACK_EMAIL_TO: config.FEEDBACK_EMAIL_TO,
      }
    ).catch((err) => {
      console.error("[feedback] notification email failed:", err);
    });
  }

  return { ok: true, id };
}
```

Sweep for other `makeTestConfig`-style helpers typed as `: Config` that now miss `FEEDBACK_EMAIL_TO`: because the field has a Zod default it is REQUIRED on the `Config` type, so any test file with a full-`Config` literal needs `FEEDBACK_EMAIL_TO: "dev@korsoai.com"` added. Find them with `grep -rn "makeTestConfig\|: Config = {" packages/hub/test packages/hub/src` and fix each.

- [ ] **Step 8: Run the hub suite**

Run: `npx vitest run packages/hub`
Expected: PASS (DB-gated suites skip without Postgres).

- [ ] **Step 9: Commit**

```bash
git add packages/hub/src/config.ts packages/hub/src/email.ts packages/hub/src/operations/feedback.ts packages/hub/test/email.feedback.test.ts packages/hub/test/feedback.test.ts packages/hub/test/config.test.ts
git commit -m "feat(hub): email feedback submissions via Resend (fire-and-forget)"
```

---

### Task 4: UI context plumbing — version constant + buildFeedbackContext + widget sends it

**Files:**
- Create: `packages/ui/src/version.ts`
- Create: `packages/ui/src/version.test.ts`
- Create: `packages/ui/src/feedbackContext.ts`
- Create: `packages/ui/src/feedbackContext.test.ts`
- Modify: `packages/ui/src/components/FeedbackWidget.tsx` (submit call only)
- Modify: `packages/ui/src/components/FeedbackWidget.test.tsx` (the two submit-assertion tests)

**Interfaces:**
- Consumes: `FeedbackContextT` from `@shepherd/shared` (Task 1).
- Produces: `SHEPHERD_UI_VERSION: string` from `src/version.ts`; `buildFeedbackContext(): FeedbackContextT | undefined` from `src/feedbackContext.ts`. Task 5's rewritten widget keeps calling `buildFeedbackContext()` in submit.

- [ ] **Step 1: Write the failing tests** — `packages/ui/src/version.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { SHEPHERD_UI_VERSION } from "./version.js";
import pkg from "../package.json";

describe("SHEPHERD_UI_VERSION", () => {
  it("matches package.json (bump version.ts when releasing)", () => {
    expect(SHEPHERD_UI_VERSION).toBe(pkg.version);
  });
});
```

`packages/ui/src/feedbackContext.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { buildFeedbackContext } from "./feedbackContext.js";
import { SHEPHERD_UI_VERSION } from "./version.js";

describe("buildFeedbackContext", () => {
  it("gathers route, appVersion, userAgent and viewport from the browser", () => {
    const ctx = buildFeedbackContext();
    expect(ctx).toBeDefined();
    expect(ctx!.route).toBe(window.location.pathname + window.location.hash);
    expect(ctx!.appVersion).toBe(SHEPHERD_UI_VERSION);
    expect(ctx!.userAgent).toBe(navigator.userAgent);
    expect(ctx!.viewport).toMatch(/^\d+x\d+$/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/ui/src/version.test.ts packages/ui/src/feedbackContext.test.ts`
Expected: FAIL — modules don't exist.

- [ ] **Step 3: Implement** — `packages/ui/src/version.ts`:

```ts
/**
 * The library's own version, reported as `appVersion` in feedback context.
 * A hand-maintained constant (the vite lib build has no clean package.json
 * import path under the project's tsc setup); version.test.ts pins it to
 * package.json so a release bump that forgets this file fails CI.
 */
export const SHEPHERD_UI_VERSION = "0.14.0";
```

(Copy the CURRENT `version` from `packages/ui/package.json` — verify it is still `0.14.0` before hardcoding.)

`packages/ui/src/feedbackContext.ts`:

```ts
/**
 * Client context silently attached to feedback submissions — route, library
 * version, user agent, viewport. Everything comes from browser globals and is
 * length-capped to match FeedbackContext's schema caps; in a windowless
 * environment (SSR) it degrades to undefined and feedback simply sends none.
 */

import type { FeedbackContextT } from "@shepherd/shared";
import { SHEPHERD_UI_VERSION } from "./version.js";

export function buildFeedbackContext(): FeedbackContextT | undefined {
  if (typeof window === "undefined") return undefined;
  return {
    route: (window.location.pathname + window.location.hash).slice(0, 256),
    appVersion: SHEPHERD_UI_VERSION,
    userAgent: navigator.userAgent.slice(0, 512),
    viewport: `${window.innerWidth}x${window.innerHeight}`,
  };
}
```

In `packages/ui/src/components/FeedbackWidget.tsx`, add the import and change the submit call:

```ts
import { buildFeedbackContext } from "../feedbackContext.js";
```

```ts
      await client.submitFeedback(
        { type, body: body.trim(), context: buildFeedbackContext() },
        workspaceId,
      );
```

Update the two submit-assertion tests in `FeedbackWidget.test.tsx` ("submits with the selected workspace id…" and "submits with no workspace id…") to:

```ts
      expect(client.submitFeedback).toHaveBeenCalledWith(
        {
          type: "suggestion",
          body: "add dark mode",
          context: expect.objectContaining({
            appVersion: expect.any(String),
            userAgent: expect.any(String),
            viewport: expect.stringMatching(/^\d+x\d+$/),
          }),
        },
        "ws_1",
      );
```

(and the analogous change with `type: "bug"`, `body: "hello there"`, `undefined` workspace.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run packages/ui/src/version.test.ts packages/ui/src/feedbackContext.test.ts packages/ui/src/components/FeedbackWidget.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/version.ts packages/ui/src/version.test.ts packages/ui/src/feedbackContext.ts packages/ui/src/feedbackContext.test.ts packages/ui/src/components/FeedbackWidget.tsx packages/ui/src/components/FeedbackWidget.test.tsx
git commit -m "feat(ui): attach client context to feedback submissions"
```

---

### Task 5: Widget UX + visual refresh

**Files:**
- Modify: `packages/ui/src/components/FeedbackWidget.tsx` (full rework below)
- Modify: `packages/ui/src/components/FeedbackWidget.test.tsx`
- Modify: `packages/ui/src/styles.css` (feedback block, lines ~477–511)

**Interfaces:**
- Consumes: `buildFeedbackContext()` (Task 4); existing `useShepherdClient`, `describeError`, `FeedbackTypeT`, mock client.
- Produces: same public component `FeedbackWidget({ workspaceId })` — no API change; type picker becomes `role="radio"` (existing `aria-pressed` button queries in any OTHER test files would break — `grep -rn 'aria-pressed' packages/ui/src` and fix any stragglers).

- [ ] **Step 1: Update + add tests** — in `FeedbackWidget.test.tsx`:

(a) Rewrite the two type-picker tests to radio semantics:

```ts
  it("opens the popover on click, showing the type picker and a textarea", async () => {
    renderWidget(makeMockClient());
    await userEvent.click(screen.getByRole("button", { name: /feedback/i }));

    expect(screen.getByRole("textbox")).toBeInTheDocument();
    expect(screen.getByRole("radiogroup", { name: /feedback type/i })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /bug/i })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /suggestion/i })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /other/i })).toBeInTheDocument();
  });

  it("defaults to the bug type and switches when another type is picked", async () => {
    renderWidget(makeMockClient());
    await userEvent.click(screen.getByRole("button", { name: /feedback/i }));

    expect(screen.getByRole("radio", { name: /bug/i })).toHaveAttribute("aria-checked", "true");

    await userEvent.click(screen.getByRole("radio", { name: /suggestion/i }));
    expect(screen.getByRole("radio", { name: /suggestion/i })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("radio", { name: /bug/i })).toHaveAttribute("aria-checked", "false");
  });
```

Also change the success-copy assertion in "shows a confirmation and clears the form on success" to `await screen.findByText(/we read every note/i)`.

(b) Append new tests:

```ts
  it("closes via the × button and returns focus to the trigger", async () => {
    renderWidget(makeMockClient());
    const trigger = screen.getByRole("button", { name: /feedback/i });
    await userEvent.click(trigger);

    await userEvent.click(screen.getByRole("button", { name: /close/i }));
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("closes on Escape and returns focus to the trigger", async () => {
    renderWidget(makeMockClient());
    const trigger = screen.getByRole("button", { name: /feedback/i });
    await userEvent.click(trigger);
    expect(screen.getByRole("textbox")).toHaveFocus();

    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("closes when clicking outside the widget", async () => {
    renderWidget(makeMockClient());
    await userEvent.click(screen.getByRole("button", { name: /feedback/i }));
    expect(screen.getByRole("textbox")).toBeInTheDocument();

    await userEvent.click(document.body);
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("focuses the textarea when the popover opens", async () => {
    renderWidget(makeMockClient());
    await userEvent.click(screen.getByRole("button", { name: /feedback/i }));
    expect(screen.getByRole("textbox")).toHaveFocus();
  });

  it("submits on Ctrl+Enter from the textarea", async () => {
    const client = makeMockClient();
    renderWidget(client);
    await userEvent.click(screen.getByRole("button", { name: /feedback/i }));
    await userEvent.type(screen.getByRole("textbox"), "keyboard warrior");
    await userEvent.keyboard("{Control>}{Enter}{/Control}");

    await waitFor(() => expect(client.submitFeedback).toHaveBeenCalledTimes(1));
  });

  it("moves the type selection with arrow keys", async () => {
    renderWidget(makeMockClient());
    await userEvent.click(screen.getByRole("button", { name: /feedback/i }));

    screen.getByRole("radio", { name: /bug/i }).focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(screen.getByRole("radio", { name: /suggestion/i })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("radio", { name: /suggestion/i })).toHaveFocus();
  });

  it("shows a character counter only once the body nears the cap", async () => {
    renderWidget(makeMockClient());
    await userEvent.click(screen.getByRole("button", { name: /feedback/i }));
    const textarea = screen.getByRole("textbox");

    await userEvent.click(textarea);
    await userEvent.paste("x".repeat(1599));
    expect(screen.queryByText(/\/ 2000/)).not.toBeInTheDocument();

    await userEvent.paste("x");
    expect(screen.getByText("1600 / 2000")).toBeInTheDocument();
  });
```

- [ ] **Step 2: Run tests to verify the new/changed ones fail**

Run: `npx vitest run packages/ui/src/components/FeedbackWidget.test.tsx`
Expected: FAIL — no radio roles, no close button, no Escape handling, etc. Pre-existing untouched tests still pass.

- [ ] **Step 3: Rework the component** — replace the body of `packages/ui/src/components/FeedbackWidget.tsx` (keep the existing file-header comment block and `FeedbackWidgetProps`) with:

```tsx
import { useEffect, useId, useRef, useState } from "react";
import type { FeedbackTypeT } from "@shepherd/shared";
import { useShepherdClient } from "../context.js";
import { describeError } from "../client.js";
import { buildFeedbackContext } from "../feedbackContext.js";

const TYPES: ReadonlyArray<{ id: FeedbackTypeT; label: string }> = [
  { id: "bug", label: "Bug" },
  { id: "suggestion", label: "Suggestion" },
  { id: "other", label: "Other" },
];

/** How long the "Thanks" confirmation shows before the popover auto-closes. */
const CONFIRMATION_MS = 1500;
/** Textarea hard cap — well under FeedbackRequest's max(4000). */
const BODY_MAX = 2000;
/** The character counter stays hidden until the draft reaches this length. */
const COUNTER_FROM = BODY_MAX * 0.8;

export function FeedbackWidget({ workspaceId }: FeedbackWidgetProps) {
  const client = useShepherdClient();
  const headingId = useId();

  const [open, setOpen] = useState(false);
  const [type, setType] = useState<FeedbackTypeT>("bug");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const canSubmit = body.trim() !== "" && !busy;
  const isMac =
    typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

  useEffect(() => {
    if (open) textareaRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [open]);

  function toggle() {
    setOpen((o) => !o);
  }

  function close() {
    setOpen(false);
    triggerRef.current?.focus();
  }

  function reset() {
    setType("bug");
    setBody("");
    setError(null);
    setSent(false);
  }

  function onPanelKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      e.stopPropagation();
      close();
    }
  }

  function onTypeKeyDown(e: React.KeyboardEvent, index: number) {
    const delta =
      e.key === "ArrowRight" || e.key === "ArrowDown"
        ? 1
        : e.key === "ArrowLeft" || e.key === "ArrowUp"
          ? -1
          : 0;
    if (delta === 0) return;
    e.preventDefault();
    const next = (index + delta + TYPES.length) % TYPES.length;
    setType(TYPES[next]!.id);
    const radios = rootRef.current?.querySelectorAll<HTMLButtonElement>('[role="radio"]');
    radios?.[next]?.focus();
  }

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await client.submitFeedback(
        { type, body: body.trim(), context: buildFeedbackContext() },
        workspaceId,
      );
      setSent(true);
      setBody("");
      setTimeout(() => {
        close();
        reset();
      }, CONFIRMATION_MS);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="shepherd-feedback" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className="shepherd-feedback__trigger"
        onClick={toggle}
        aria-expanded={open}
      >
        Feedback
      </button>

      {open && (
        <section
          className="shepherd-feedback__panel"
          aria-labelledby={headingId}
          onKeyDown={onPanelKeyDown}
        >
          <div className="shepherd-feedback__header">
            <h3 id={headingId}>Give feedback</h3>
            <button
              type="button"
              className="shepherd-feedback__close"
              aria-label="Close"
              onClick={close}
            >
              ×
            </button>
          </div>

          {sent ? (
            <p role="status">
              <span aria-hidden="true">✓ </span>
              Thanks — we read every note.
            </p>
          ) : (
            <>
              <div
                className="shepherd-feedback__types"
                role="radiogroup"
                aria-label="Feedback type"
              >
                {TYPES.map((t, i) => (
                  <button
                    key={t.id}
                    type="button"
                    role="radio"
                    aria-checked={type === t.id}
                    tabIndex={type === t.id ? 0 : -1}
                    onClick={() => setType(t.id)}
                    onKeyDown={(e) => onTypeKeyDown(e, i)}
                  >
                    {t.label}
                  </button>
                ))}
              </div>

              <textarea
                ref={textareaRef}
                aria-label="Feedback"
                placeholder="What's on your mind?"
                maxLength={BODY_MAX}
                value={body}
                onChange={(e) => setBody(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && canSubmit) {
                    void submit();
                  }
                }}
              />

              {body.length >= COUNTER_FROM && (
                <p className="shepherd-feedback__count">
                  {body.length} / {BODY_MAX}
                </p>
              )}

              {error && <p role="alert">{error}</p>}

              <div className="shepherd-feedback__footer">
                <span className="shepherd-feedback__hint" aria-hidden="true">
                  {isMac ? "⌘↵" : "Ctrl↵"} to send
                </span>
                <button type="button" onClick={() => void submit()} disabled={!canSubmit}>
                  Submit
                </button>
              </div>
            </>
          )}
        </section>
      )}
    </div>
  );
}
```

Update the file-header comment's popover description to mention the close ×, radiogroup, Escape/click-outside, and keyboard submit.

- [ ] **Step 4: Update the styles** — in `packages/ui/src/styles.css`, within the feedback block (lines ~477–511): replace the `.shepherd-feedback__types` rules and the `.shepherd-feedback__panel > button` rules; add header/close/count/footer/hint rules and the entrance animation. Keep every other existing rule (trigger, panel, h3, status/alert, textarea) untouched:

```css
      .shepherd-feedback__header { display:flex; align-items:center; justify-content:space-between; }
      .shepherd-feedback__close {
        padding:0 4px; border:none; background:none; color:var(--ink3);
        font:inherit; font-size:16px; line-height:1; cursor:pointer; }
      .shepherd-feedback__close:hover { color:var(--ink); }
      .shepherd-feedback__types {
        display:flex; border:1px solid var(--line); border-radius:8px; overflow:hidden; }
      .shepherd-feedback__types button {
        flex:1; padding:6px 0; border:none; background:transparent; color:var(--ink2);
        font:inherit; font-size:12.5px; cursor:pointer;
        transition:background .12s ease, color .12s ease; }
      .shepherd-feedback__types button + button { border-left:1px solid var(--line); }
      .shepherd-feedback__types button[aria-checked="true"] {
        background:var(--ink); color:var(--bg); font-weight:600; }
      .shepherd-feedback__count { margin:0; font-size:11.5px; color:var(--ink3); text-align:right; }
      .shepherd-feedback__footer {
        display:flex; align-items:center; justify-content:space-between; gap:10px; }
      .shepherd-feedback__hint { font-size:11.5px; color:var(--ink3); }
      .shepherd-feedback__footer button {
        padding:9px 16px; border-radius:8px; border:1px solid var(--ink);
        background:var(--ink); color:var(--bg); font-weight:600; cursor:pointer; font:inherit; }
      .shepherd-feedback__footer button:hover:not(:disabled) { background:#413a2a; }
      .shepherd-feedback__footer button:disabled { opacity:.55; cursor:default; }
      @media (prefers-reduced-motion: no-preference) {
        .shepherd-feedback__panel { animation:shepherd-feedback-in .12s ease-out; }
      }
      @keyframes shepherd-feedback-in {
        from { opacity:0; transform:translateY(6px); }
        to   { opacity:1; transform:none; }
      }
```

(Indentation: this file nests CSS inside a template/string block at that indent level — match the surrounding lines exactly.)

- [ ] **Step 5: Run the ui suite**

Run: `npx vitest run packages/ui`
Expected: PASS — all FeedbackWidget tests (old + new), no regressions elsewhere.

- [ ] **Step 6: Commit**

```bash
git add packages/ui/src/components/FeedbackWidget.tsx packages/ui/src/components/FeedbackWidget.test.tsx packages/ui/src/styles.css
git commit -m "feat(ui): feedback widget UX refresh (close/escape/focus, segmented types, kbd submit, counter)"
```

---

### Task 6: Full verification + visual check

**Files:**
- No new files; runs the repo gate and a manual visual pass.

**Interfaces:**
- Consumes: everything above.
- Produces: a verified branch ready for review.

- [ ] **Step 1: Run the full repo gate**

Run (repo root): `npm run check`
Expected: tsc build clean, ui type-check clean, both vite builds succeed, `vitest run` green (DB-gated hub suites skip without Postgres — fine).

- [ ] **Step 2: Visual check in the dev app**

Run: `npm -w @korso/shepherd-ui run dev` and open the printed localhost URL with `agent-browser open <url>`, then `agent-browser snapshot -i`, click the Feedback pill, screenshot the open popover (`agent-browser screenshot feedback-v2.png`), and verify: header with ×, connected segmented control, footer hint + Submit, counter appears after pasting 1700 chars, Escape closes. Close the browser session when done.

- [ ] **Step 3: Commit any fixups and stop**

Report results (including the screenshot path) and stop for human review. Ops steps (Resend key check, `FEEDBACK_EMAIL_TO` if non-default, migration 019 against Cloud SQL) are listed in the spec and remain manual.
