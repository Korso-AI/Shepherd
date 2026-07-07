import { useCallback, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import type { WorkspaceAgentT } from "@shepherd/shared";
import { useShepherdClient } from "../context.js";
import {
  colorForName,
  extractTarget,
  initialsFor,
  mentionableAgents,
  parseMention,
} from "../logic.js";

/** Props for {@link Composer}. */
export interface ComposerProps {
  /** Workspace agents; the live ones in the selected repo drive @-autocomplete. */
  agents: WorkspaceAgentT[];
  /** The board's selected repo; `null`/`"__all__"` broadcast to every repo. */
  selectedRepo: string | null;
  /**
   * Workspace to post into. When given, submit goes through the plural
   * `announceTo(id, …)` route; when omitted it uses the singular self-host
   * `announce(…)` alias, so an unscoped composer is unchanged.
   */
  workspaceId?: string;
  /** Invoked after a successful send so the host can refresh the feed. */
  onSent: () => void | Promise<void>;
}

/** How many autocomplete suggestions to show — ported from app.js `.slice(0, 8)`. */
const MAX_SUGGESTIONS = 8;

/** The slice of the @-token being completed: `[start, end)` of `value`. */
interface MentionRange {
  start: number;
  end: number;
}

/**
 * The operator's message composer (the "Chat" tab footer). A controlled input
 * with an @-mention autocomplete and a send button, ported from app.js
 * `setupComposer` + `renderPop`.
 *
 * As the operator types, the token immediately left of the caret is parsed; if
 * it is an `@mention`, a `role="listbox"` of live agents in the selected repo
 * opens. ArrowUp/ArrowDown move the highlight, Enter/Tab (or a mousedown on a
 * row) accept it — inserting `"@Name "` — and Escape closes it. On submit a
 * blank body is ignored; otherwise the first mention matching a known agent
 * directs the message (`targetAgentName`) and the selected repo scopes a
 * broadcast (`null` in All-repos mode). The send button is disabled in-flight;
 * on success the input clears and `onSent` is awaited, on failure a
 * "send failed — retry" status shows and the button re-enables. The client comes
 * from context, keeping the composer auth-agnostic.
 *
 * @param props - The agents, repo filter, and post-send callback.
 * @returns The composer element (autocomplete popup + form).
 */
export function Composer({
  agents,
  selectedRepo,
  workspaceId,
  onSent,
}: ComposerProps): ReactNode {
  const client = useShepherdClient();
  const inputRef = useRef<HTMLInputElement>(null);

  const [value, setValue] = useState("");
  const [items, setItems] = useState<string[]>([]);
  const [active, setActive] = useState(0);
  const [range, setRange] = useState<MentionRange | null>(null);
  const [sending, setSending] = useState(false);
  const [failed, setFailed] = useState(false);

  // The names addressable under the current filter — the same crew the board
  // shows for the selected repo. Recomputed each render; cheap for board sizes.
  // An agent with no session repo (repo === null) coalesces to "" so it never
  // equals a real repo (mentionable only in All-repos, via matchesRepo's
  // short-circuit) — exactly the original app.js behavior.
  const names = mentionableAgents(
    agents.map((a) => ({
      name: a.name,
      presence: a.presence,
      repo: a.repo ?? "",
    })),
    selectedRepo,
  );

  const popOpen = items.length > 0;

  const closePop = useCallback(() => {
    setItems([]);
    setRange(null);
  }, []);

  /**
   * Recompute the autocomplete from the caret position: open it on an active
   * @mention (filtered by the live crew), else close it. Mirrors `refreshPop`.
   */
  const refreshPop = useCallback(
    (nextValue: string, caret: number) => {
      const mention = parseMention(nextValue, caret);
      if (!mention) {
        closePop();
        return;
      }
      const q = mention.query.toLowerCase();
      const next = names
        .filter((n) => n.toLowerCase().startsWith(q))
        .slice(0, MAX_SUGGESTIONS);
      setItems(next);
      setRange({ start: mention.start, end: mention.end });
      setActive(0);
    },
    [names, closePop],
  );

  /** Replace the @-token with `"@Name "` and place the caret after it. */
  const accept = useCallback(
    (name: string) => {
      if (!range) return;
      const insert = "@" + name + " ";
      const next =
        value.slice(0, range.start) + insert + value.slice(range.end);
      const caret = range.start + insert.length;
      setValue(next);
      closePop();
      // Restore focus + caret after React commits the new value.
      requestAnimationFrame(() => {
        const el = inputRef.current;
        if (el) {
          el.focus();
          el.setSelectionRange(caret, caret);
        }
      });
    },
    [range, value, closePop],
  );

  const onInput = useCallback(
    (next: string) => {
      setValue(next);
      const caret = inputRef.current?.selectionStart ?? next.length;
      refreshPop(next, caret);
    },
    [refreshPop],
  );

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      if (!popOpen) return;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActive((a) => (a + 1) % items.length);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setActive((a) => (a - 1 + items.length) % items.length);
      } else if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        accept(items[active]);
      } else if (e.key === "Escape") {
        e.preventDefault();
        closePop();
      }
    },
    [popOpen, items, active, accept, closePop],
  );

  const onSubmit = useCallback(
    async (e: { preventDefault: () => void }) => {
      e.preventDefault();
      const body = value.trim();
      if (!body) return;
      // The first @mention matching a live agent directs the message; otherwise
      // it broadcasts to the selected repo (null repo => fan out to all repos).
      const targetAgentName = extractTarget(body, names);
      const repo =
        selectedRepo === null || selectedRepo === "__all__"
          ? null
          : selectedRepo;
      setSending(true);
      setFailed(false);
      try {
        // A scoped composer posts to the workspace-scoped route; otherwise the
        // singular self-host alias. Same request body either way.
        const req = { body, targetAgentName, repo };
        await (workspaceId !== undefined
          ? client.announceTo(workspaceId, req)
          : client.announce(req));
        setValue("");
        closePop();
        await onSent();
      } catch {
        // A 401 is handled by the client's onUnauthorized (self-host); the
        // composer just shows the rejected state and keeps the body for retry.
        setFailed(true);
      } finally {
        setSending(false);
      }
    },
    [value, names, selectedRepo, workspaceId, client, closePop, onSent],
  );

  return (
    <div className="composer">
      <div
        id="mention-pop"
        className="mention-pop"
        role="listbox"
        aria-label="Agents to mention"
        hidden={!popOpen}
      >
        {items.map((name, i) => (
          <button
            key={name}
            id={`mention-opt-${i}`}
            type="button"
            role="option"
            aria-selected={i === active}
            className={"mention-mi" + (i === active ? " on" : "")}
            // mousedown fires before the input blurs, so the click still lands.
            onMouseDown={(e) => {
              e.preventDefault();
              accept(name);
            }}
          >
            <div className="ma" style={{ background: colorForName(name) }}>
              {initialsFor(name)}
            </div>
            <span>{name}</span>
          </button>
        ))}
      </div>
      <form
        id="chat-form"
        className="chat-form"
        onSubmit={(e) => {
          void onSubmit(e);
        }}
      >
        <input
          id="chat-input"
          className="chat-input"
          type="text"
          autoComplete="off"
          aria-label="Message the team"
          placeholder="Message the team… use @name to direct it"
          role="combobox"
          aria-expanded={popOpen}
          aria-controls="mention-pop"
          aria-autocomplete="list"
          aria-activedescendant={popOpen ? `mention-opt-${active}` : undefined}
          ref={inputRef}
          value={value}
          onChange={(e) => onInput(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <button
          id="chat-send"
          className="chat-send"
          type="submit"
          disabled={sending}
        >
          Send
        </button>
      </form>
      {failed ? (
        <div className="chat__note" role="status">
          send failed, retry
        </div>
      ) : null}
    </div>
  );
}
