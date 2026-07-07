/**
 * Unit tests for sendFeedbackEmail — DB-free: the global fetch is stubbed, so
 * these run everywhere (unlike the DB-gated feedback.test.ts route tests).
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { sendFeedbackEmail } from "../src/email.js";

const CONFIG = {
  RESEND_API_KEY: "re_test_key",
  INVITE_EMAIL_FROM: "Shepherd <feedback@example.test>",
  FEEDBACK_EMAIL_TO: "dev@example.test",
};

const PARAMS = {
  id: "fb-uuid-1",
  type: "bug",
  body: "the export button crashes the tab when the table is empty and the console shows a TypeError",
  account: {
    id: "acct-alice",
    name: "Alice Example",
    email: "alice@example.test",
  },
  workspace: { id: "ws-uuid-1", name: "Acme Team", slug: "acme" },
  context: {
    route: "/shepherd",
    appVersion: "0.14.0",
    userAgent: "UA",
    viewport: "1280x720",
  },
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("sendFeedbackEmail", () => {
  it("POSTs the expected Resend payload", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await sendFeedbackEmail(PARAMS, CONFIG);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.resend.com/emails");
    expect(init.headers.Authorization).toBe("Bearer re_test_key");
    const payload = JSON.parse(init.body);
    expect(payload.from).toBe(CONFIG.INVITE_EMAIL_FROM);
    expect(payload.to).toBe("dev@example.test");
    expect(payload.subject).toBe(
      `[Feedback] bug — ${PARAMS.body.slice(0, 60)}…`,
    );
    expect(payload.text).toContain(PARAMS.body);
    expect(payload.text).toContain(
      "account: Alice Example <alice@example.test> (acct-alice)",
    );
    expect(payload.text).toContain("workspace: Acme Team (acme)");
    expect(payload.text).toContain("route: /shepherd");
    expect(payload.text).toContain("appVersion: 0.14.0");
    expect(payload.text).toContain("feedback id: fb-uuid-1");
  });

  it("keeps a short body un-truncated in the subject and dashes null identities", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await sendFeedbackEmail(
      {
        ...PARAMS,
        body: "short one",
        account: null,
        workspace: null,
        context: null,
      },
      CONFIG,
    );

    const payload = JSON.parse(fetchMock.mock.calls[0]![1].body);
    expect(payload.subject).toBe("[Feedback] bug — short one");
    expect(payload.text).toContain("account: —");
    expect(payload.text).toContain("workspace: —");
  });

  it("falls back to raw ids when identities are unresolved", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await sendFeedbackEmail(
      {
        ...PARAMS,
        account: { id: "acct-alice", name: null, email: null },
        workspace: { id: "ws-uuid-1", name: null, slug: null },
      },
      CONFIG,
    );

    const payload = JSON.parse(fetchMock.mock.calls[0]![1].body);
    expect(payload.text).toContain("account: acct-alice");
    expect(payload.text).toContain("workspace: ws-uuid-1");
  });

  it("throws on a non-ok Resend response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("nope", { status: 422 })),
    );
    await expect(sendFeedbackEmail(PARAMS, CONFIG)).rejects.toThrow(/422/);
  });
});
