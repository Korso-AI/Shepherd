import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  existsSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  inboxFilePath,
  appendAnnouncements,
  drainInbox,
  formatInboxAnnouncements,
  buildHookOutput,
  defaultInboxDir,
  mergeAnnouncements,
  REPLY_ROUTING_HINT,
} from "../src/inbox.js";
import type { AnnouncementT } from "@shepherd/shared";

function ann(
  id: number,
  body: string,
  target: string | null = null,
): AnnouncementT {
  return {
    id,
    fromAgentName: "RedDragon",
    fromHuman: "alice",
    body,
    targetAgentName: target,
    createdAt: "2026-06-25T12:00:00.000Z",
  };
}

describe("defaultInboxDir", () => {
  it("returns a stable absolute path ending in .shepherd/inbox", () => {
    const a = defaultInboxDir();
    const b = defaultInboxDir();
    expect(a).toBe(b);
    expect(a.replace(/\\/g, "/")).toMatch(/\.shepherd\/inbox$/);
  });
});

describe("mergeAnnouncements", () => {
  const ann = (id: number, body: string) => ({
    id,
    fromAgentName: "X",
    fromHuman: "y",
    body,
    targetAgentName: null,
    createdAt: "2026-06-25T12:00:00.000Z",
  });

  it("dedupes by id and sorts ascending", () => {
    const merged = mergeAnnouncements(
      [ann(3, "c"), ann(1, "a")],
      [ann(1, "a-dup"), ann(2, "b")],
    );
    expect(merged.map((m) => m.id)).toEqual([1, 2, 3]);
    // First occurrence wins for a duplicate id.
    expect(merged.find((m) => m.id === 1)!.body).toBe("a");
  });

  it("tolerates undefined lists", () => {
    expect(
      mergeAnnouncements(undefined, [ann(1, "a")], undefined),
    ).toHaveLength(1);
    expect(mergeAnnouncements()).toEqual([]);
  });
});

describe("inboxFilePath", () => {
  it("is deterministic for the same (dir, cwd)", () => {
    expect(inboxFilePath("/inbox", "/repo/a")).toBe(
      inboxFilePath("/inbox", "/repo/a"),
    );
  });

  it("differs for different cwds", () => {
    expect(inboxFilePath("/inbox", "/repo/a")).not.toBe(
      inboxFilePath("/inbox", "/repo/b"),
    );
  });

  it("lives under the given dir and ends in .jsonl", () => {
    const p = inboxFilePath("/inbox", "/repo/a");
    expect(p.startsWith(join("/inbox"))).toBe(true);
    expect(p.endsWith(".jsonl")).toBe(true);
  });
});

describe("appendAnnouncements + drainInbox", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "shepherd-inbox-"));
    file = join(dir, "test.jsonl");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("round-trips announcements and clears the file on drain", () => {
    appendAnnouncements(file, [ann(1, "hi"), ann(2, "yo")]);
    const drained = drainInbox(file);
    expect(drained.map((a) => a.body)).toEqual(["hi", "yo"]);
    // Drained once — nothing left.
    expect(drainInbox(file)).toEqual([]);
  });

  it("accumulates across multiple appends before a single drain", () => {
    appendAnnouncements(file, [ann(1, "one")]);
    appendAnnouncements(file, [ann(2, "two")]);
    const drained = drainInbox(file);
    expect(drained.map((a) => a.id)).toEqual([1, 2]);
  });

  it("returns [] when there is no inbox file", () => {
    expect(drainInbox(join(dir, "missing.jsonl"))).toEqual([]);
  });

  it("skips malformed lines rather than throwing", () => {
    writeFileSync(
      file,
      'not json\n{"id":3,"fromAgentName":"X","fromHuman":"y","body":"ok","targetAgentName":null,"createdAt":"2026-06-25T12:00:00.000Z"}\n',
    );
    const drained = drainInbox(file);
    expect(drained).toHaveLength(1);
    expect(drained[0]!.body).toBe("ok");
  });

  it("dedupes by id within a drain (defensive against double-write)", () => {
    appendAnnouncements(file, [ann(1, "dup"), ann(1, "dup")]);
    expect(drainInbox(file)).toHaveLength(1);
  });

  it("appending an empty list is a no-op (no file created)", () => {
    appendAnnouncements(file, []);
    expect(existsSync(file)).toBe(false);
  });

  it("fails open: appending under an un-creatable path does not throw", () => {
    // A path whose parent is an existing *file* cannot be made a directory.
    const blocker = join(dir, "blocker");
    writeFileSync(blocker, "x");
    expect(() =>
      appendAnnouncements(join(blocker, "nope.jsonl"), [ann(1, "x")]),
    ).not.toThrow();
  });

  it("creates the inbox directory if it does not exist", () => {
    const nested = join(dir, "a", "b", "inbox.jsonl");
    appendAnnouncements(nested, [ann(1, "made")]);
    expect(existsSync(nested)).toBe(true);
    expect(readFileSync(nested, "utf8")).toContain("made");
  });
});

describe("buildHookOutput", () => {
  let dir: string;
  let cwd: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "shepherd-hook-"));
    cwd = "/some/project";
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const stdin = (over: Record<string, unknown> = {}) =>
    JSON.stringify({ cwd, hook_event_name: "PreToolUse", ...over });

  it("returns '' when no inbox dir is configured", () => {
    expect(buildHookOutput(stdin(), undefined)).toBe("");
  });

  it("returns '' on malformed stdin", () => {
    expect(buildHookOutput("not json", dir)).toBe("");
  });

  it("returns '' when stdin has no cwd", () => {
    expect(
      buildHookOutput(JSON.stringify({ hook_event_name: "PreToolUse" }), dir),
    ).toBe("");
  });

  it("returns '' when the inbox is empty", () => {
    expect(buildHookOutput(stdin(), dir)).toBe("");
  });

  it("emits additionalContext echoing the hook event when announcements are pending", () => {
    const file = inboxFilePath(dir, cwd);
    appendAnnouncements(file, [ann(1, "deploy is live")]);

    const out = JSON.parse(buildHookOutput(stdin(), dir));
    expect(out.hookSpecificOutput.hookEventName).toBe("PreToolUse");
    expect(out.hookSpecificOutput.additionalContext).toContain(
      "deploy is live",
    );
  });

  it("echoes a different configured hook event (e.g. UserPromptSubmit)", () => {
    const file = inboxFilePath(dir, cwd);
    appendAnnouncements(file, [ann(1, "msg")]);

    const out = JSON.parse(
      buildHookOutput(stdin({ hook_event_name: "UserPromptSubmit" }), dir),
    );
    expect(out.hookSpecificOutput.hookEventName).toBe("UserPromptSubmit");
  });

  it("consumes the inbox: a second invocation returns ''", () => {
    const file = inboxFilePath(dir, cwd);
    appendAnnouncements(file, [ann(1, "once")]);

    expect(buildHookOutput(stdin(), dir)).not.toBe("");
    expect(buildHookOutput(stdin(), dir)).toBe("");
  });

  // The link-state nudge rides the same hook output. These inject a fake nudge
  // fn to stay independent of the real filesystem/marker state; the predicate
  // itself is covered in linkNudge.test.ts.
  it("emits the nudge alone when the inbox is empty", () => {
    const out = JSON.parse(
      buildHookOutput(stdin(), dir, undefined, () => "NUDGE"),
    );
    expect(out.hookSpecificOutput.additionalContext).toBe("NUDGE");
    expect(out.hookSpecificOutput.hookEventName).toBe("PreToolUse");
  });

  it("emits nudge and announcements together, nudge first", () => {
    appendAnnouncements(inboxFilePath(dir, cwd), [ann(1, "deploy is live")]);
    const out = JSON.parse(
      buildHookOutput(stdin(), dir, undefined, () => "NUDGE"),
    );
    const ctx: string = out.hookSpecificOutput.additionalContext;
    expect(ctx.indexOf("NUDGE")).toBe(0);
    expect(ctx).toContain("deploy is live");
  });

  it("passes the hook input's cwd and tool_name to the nudge fn", () => {
    const seen: Array<[string, string | undefined]> = [];
    const nudge = (c: string, t?: string) => {
      seen.push([c, t]);
      return "";
    };
    buildHookOutput(stdin({ tool_name: "Edit" }), dir, undefined, nudge);
    buildHookOutput(stdin(), dir, undefined, nudge);
    expect(seen).toEqual([
      [cwd, "Edit"],
      [cwd, undefined],
    ]);
  });

  it("emits the nudge even when no inbox dir is configured", () => {
    const out = JSON.parse(
      buildHookOutput(stdin(), undefined, undefined, () => "NUDGE"),
    );
    expect(out.hookSpecificOutput.additionalContext).toBe("NUDGE");
  });

  it("still returns '' when both the inbox and the nudge are empty", () => {
    expect(buildHookOutput(stdin(), dir, undefined, () => "")).toBe("");
  });

  // -------------------------------------------------------------------------
  // Cursor dialect — verified by spike (Cursor 3.9.16): no cwd, URI-style
  // workspace_roots, a BOM prefix on stdin, and only a TOP-LEVEL
  // additionalContext (+ continue: true) reaches the model.
  // -------------------------------------------------------------------------

  /** A realistic Cursor beforeSubmitPrompt payload, BOM included. */
  const cursorStdin = (over: Record<string, unknown> = {}) =>
    "\uFEFF" +
    JSON.stringify({
      hook_event_name: "beforeSubmitPrompt",
      cursor_version: "3.9.16",
      workspace_roots: ["/c:/Users/x/proj"],
      prompt: "hello",
      ...over,
    });

  it("cursor: strips the BOM, keys the inbox off workspace_roots, replies top-level", () => {
    // The MCP server (launched by Cursor with the workspace as cwd) writes
    // using the NATIVE path spelling; the hook must land on the same file.
    appendAnnouncements(inboxFilePath(dir, "c:/Users/x/proj"), [
      ann(1, "deploy is live"),
    ]);

    const out = JSON.parse(
      buildHookOutput(cursorStdin(), dir, undefined, () => ""),
    );
    expect(out.continue).toBe(true);
    expect(out.additionalContext).toContain("deploy is live");
    expect(out.hookSpecificOutput).toBeUndefined();
  });

  it("cursor: passes the resolved native workspace root to the nudge fn", () => {
    const seen: string[] = [];
    buildHookOutput(cursorStdin(), dir, undefined, (c) => {
      seen.push(c);
      return "NUDGE";
    });
    expect(seen).toEqual(["c:/Users/x/proj"]);
  });

  it("cursor: non-Windows workspace roots pass through unchanged", () => {
    const seen: string[] = [];
    buildHookOutput(
      cursorStdin({ workspace_roots: ["/home/x/proj"] }),
      dir,
      undefined,
      (c) => {
        seen.push(c);
        return "NUDGE";
      },
    );
    expect(seen).toEqual(["/home/x/proj"]);
  });

  it("cursor: returns '' when workspace_roots is empty (nothing to key on)", () => {
    expect(
      buildHookOutput(
        cursorStdin({ workspace_roots: [] }),
        dir,
        undefined,
        () => "NUDGE",
      ),
    ).toBe("");
  });

  it("an explicit cwd still wins over workspace_roots and keeps the Claude reply shape", () => {
    // A hypothetical client sending BOTH stays on the hookSpecificOutput
    // dialect only when it does NOT identify as Cursor.
    const out = JSON.parse(
      buildHookOutput(
        JSON.stringify({ cwd, hook_event_name: "PreToolUse" }),
        dir,
        undefined,
        () => "NUDGE",
      ),
    );
    expect(out.hookSpecificOutput.additionalContext).toBe("NUDGE");
  });
});

describe("formatInboxAnnouncements", () => {
  it("returns empty string for no announcements", () => {
    expect(formatInboxAnnouncements([])).toBe("");
  });

  it("labels broadcasts and directed messages", () => {
    const text = formatInboxAnnouncements([
      ann(1, "everyone read this"),
      ann(2, "just you", "BlueWolf"),
    ]);
    expect(text).toContain("everyone read this");
    expect(text).toContain("(broadcast)");
    expect(text).toContain("→ BlueWolf");
    expect(text).toContain("just you");
  });

  it("routes replies back through announce (senders can't see the chat)", () => {
    const text = formatInboxAnnouncements([
      ann(1, "can you check the auth change?"),
    ]);
    expect(text).toContain(REPLY_ROUTING_HINT);
    expect(text.toLowerCase()).toContain("can't see this chat");
    expect(text).toContain("`announce`");
  });

  it("stamps each message with its age so stale info is discountable", () => {
    const threeDaysAgo = new Date(
      Date.now() - 3 * 24 * 60 * 60 * 1000 - 60_000,
    ).toISOString();
    const text = formatInboxAnnouncements([
      { ...ann(1, "old news"), createdAt: threeDaysAgo },
      { ...ann(2, "for you", "BlueWolf"), createdAt: threeDaysAgo },
    ]);
    expect(text).toContain("(broadcast), 3d ago]");
    expect(text).toContain("→ BlueWolf, 3d ago]");
  });

  it("falls back to 'recently' for an unparseable createdAt", () => {
    const text = formatInboxAnnouncements([
      { ...ann(1, "x"), createdAt: "not-a-date" },
    ]);
    expect(text).toContain("(broadcast), recently]");
  });

  it("does not label a replayed backlog as new", () => {
    const text = formatInboxAnnouncements([ann(1, "a"), ann(2, "b")]);
    expect(text).toContain("[Shepherd] 2 announcements from your teammates:");
    expect(text).not.toContain("new announcement");
  });
});
