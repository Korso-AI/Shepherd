import { describe, it, expect, vi } from "vitest";
import { offerLinkPopup, NEVER_ASK_CHOICE } from "../src/linkPopup.js";

// The Layer 2 elicitation popup puts the link question to the USER directly.
// Its cardinal rule is ACCEPT-ONLY: only an accepted form submission records a
// decision. Some clients auto-decline popups they can't render (observed:
// Codex answers {action:"decline"} in milliseconds while still declaring the
// elicitation capability) — a decline/cancel/error must therefore mean
// "couldn't ask", never "user said no".

function makeDeps(overrides?: {
  slugs?: string[] | (() => Promise<string[]>);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  elicit?: any;
}) {
  const slugs = overrides?.slugs ?? ["team-alpha", "team-beta"];
  const listWorkspaces = vi.fn(
    typeof slugs === "function" ? slugs : async () => slugs
  );
  const elicit =
    overrides?.elicit ??
    vi.fn(async () => ({ action: "accept", content: { decision: "team-alpha" } }));
  const linkWorkspace = vi.fn(async () => undefined);
  const neverAskAgain = vi.fn();
  return { listWorkspaces, elicit, linkWorkspace, neverAskAgain };
}

async function run(deps: ReturnType<typeof makeDeps>) {
  return offerLinkPopup({
    repoName: "my-repo",
    elicit: deps.elicit,
    listWorkspaces: deps.listWorkspaces,
    linkWorkspace: deps.linkWorkspace,
    neverAskAgain: deps.neverAskAgain,
  });
}

describe("offerLinkPopup", () => {
  it("accepted workspace choice → links it and reports the slug", async () => {
    const deps = makeDeps();
    const result = await run(deps);

    expect(result).toEqual({ outcome: "linked", workspace: "team-alpha" });
    expect(deps.linkWorkspace).toHaveBeenCalledWith("team-alpha");
    expect(deps.neverAskAgain).not.toHaveBeenCalled();
  });

  it(`accepted "${NEVER_ASK_CHOICE}" → records the decline`, async () => {
    const deps = makeDeps({
      elicit: vi.fn(async () => ({
        action: "accept",
        content: { decision: NEVER_ASK_CHOICE },
      })),
    });
    const result = await run(deps);

    expect(result.outcome).toBe("declined");
    expect(deps.neverAskAgain).toHaveBeenCalledOnce();
    expect(deps.linkWorkspace).not.toHaveBeenCalled();
  });

  it("DECLINE action records NOTHING (accept-only: Codex auto-declines)", async () => {
    const deps = makeDeps({ elicit: vi.fn(async () => ({ action: "decline" })) });
    const result = await run(deps);

    expect(result.outcome).toBe("unanswered");
    expect(deps.linkWorkspace).not.toHaveBeenCalled();
    expect(deps.neverAskAgain).not.toHaveBeenCalled();
  });

  it("CANCEL action records nothing (dismiss = ask again next session)", async () => {
    const deps = makeDeps({ elicit: vi.fn(async () => ({ action: "cancel" })) });
    const result = await run(deps);

    expect(result.outcome).toBe("unanswered");
    expect(deps.linkWorkspace).not.toHaveBeenCalled();
    expect(deps.neverAskAgain).not.toHaveBeenCalled();
  });

  it("an elicitation error (timeout, unsupported) records nothing", async () => {
    const deps = makeDeps({
      elicit: vi.fn(async () => {
        throw new Error("request timed out");
      }),
    });
    const result = await run(deps);

    expect(result.outcome).toBe("unanswered");
    expect(deps.neverAskAgain).not.toHaveBeenCalled();
  });

  it("an accepted but unknown decision value records nothing", async () => {
    const deps = makeDeps({
      elicit: vi.fn(async () => ({ action: "accept", content: { decision: "not-a-workspace" } })),
    });
    const result = await run(deps);

    expect(result.outcome).toBe("unanswered");
    expect(deps.linkWorkspace).not.toHaveBeenCalled();
    expect(deps.neverAskAgain).not.toHaveBeenCalled();
  });

  it("no workspaces to offer → never pops anything up", async () => {
    const deps = makeDeps({ slugs: [] });
    const result = await run(deps);

    expect(result.outcome).toBe("unanswered");
    expect(deps.elicit).not.toHaveBeenCalled();
  });

  it("workspace listing failure (hub down) → never pops anything up", async () => {
    const deps = makeDeps({
      slugs: async () => {
        throw new Error("hub unreachable");
      },
    });
    const result = await run(deps);

    expect(result.outcome).toBe("unanswered");
    expect(deps.elicit).not.toHaveBeenCalled();
  });

  it("uses a lowest-common-denominator schema: one flat string enum", async () => {
    const deps = makeDeps();
    await run(deps);

    const params = deps.elicit.mock.calls[0][0];
    expect(typeof params.message).toBe("string");
    expect(params.message).toContain("my-repo");

    const schema = params.requestedSchema;
    expect(schema.type).toBe("object");
    expect(schema.required).toEqual(["decision"]);
    const decision = schema.properties.decision;
    expect(decision.type).toBe("string");
    // The never-ask option is a VALUE inside the form, so clicking the dialog's
    // own Decline/Cancel buttons can never be mistaken for "don't ask again".
    expect(decision.enum).toEqual(["team-alpha", "team-beta", NEVER_ASK_CHOICE]);
  });

  it("a linkWorkspace failure is contained (no throw) and reports unanswered", async () => {
    const deps = makeDeps();
    deps.linkWorkspace.mockRejectedValueOnce(new Error("disk full"));
    const result = await run(deps);

    expect(result.outcome).toBe("unanswered");
  });
});
