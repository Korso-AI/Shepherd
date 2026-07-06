import { useLayoutEffect, useRef } from "react";
import type { ReactNode } from "react";
import type { WorkspaceAnnouncementT } from "@shepherd/shared";
import {
  colorForName,
  formatRelative,
  initialsFor,
  matchesRepo,
} from "../logic.js";

/** Props for {@link Chat}. */
export interface ChatProps {
  /** The workspace announcement feed, newest-first as the API returns it. */
  announcements: WorkspaceAnnouncementT[];
  /** The board's selected repo; `null`/`"__all__"` show every repo's messages. */
  selectedRepo: string | null;
  /** The server clock in epoch ms, so "N ago" matches the rest of the board. */
  nowMs: number;
}

/**
 * How close (in px) to the bottom still counts as "pinned to the newest
 * message". Ported verbatim from app.js `chatIsNearBottom` — a small slack so a
 * reader who is essentially at the bottom keeps following new messages, while
 * one who has scrolled up to read history is left where they are.
 */
const NEAR_BOTTOM_PX = 80;

/**
 * The group-chat view of the workspace announcement feed (the "Chat" tab).
 *
 * The API returns announcements newest-first, but a chat reads oldest -> newest
 * top -> bottom, so the list is reversed before render; messages are filtered to
 * the selected repo. Each row mirrors app.js `renderAnnouncements`: an avatar
 * (initials + deterministic color), the sender, an optional "→ @target" /
 * "→ admin" header, the relative time, and the body. Operator messages
 * (`fromAdmin`) get `msg--me` (right-aligned); directed or to-admin messages get
 * `msg--targeted`.
 *
 * The viewer stays pinned to the newest message UNLESS they have scrolled up to
 * read history — measured against the scroll container before each re-render and
 * re-applied in a layout effect so the write happens before paint (no flicker).
 *
 * @param props - The feed, the repo filter, and the server clock.
 * @returns The scrollable chat element.
 */
export function Chat({ announcements, selectedRepo, nowMs }: ChatProps): ReactNode {
  const chatRef = useRef<HTMLDivElement>(null);
  // Capture "were we near the bottom?" BEFORE React commits the new DOM, so the
  // layout effect can decide whether to re-pin. A ref (not state) because it's a
  // pre-paint measurement, never rendered.
  const stickRef = useRef(true);

  const c = chatRef.current;
  if (c) {
    stickRef.current = c.scrollHeight - c.scrollTop - c.clientHeight < NEAR_BOTTOM_PX;
  }

  // The API returns newest-first; a chat reads oldest -> newest, top -> bottom.
  // Only show messages whose repo matches the current selection.
  const messages = [...announcements]
    .filter((a) => matchesRepo(a, selectedRepo))
    .reverse();

  // Keep the viewer pinned to the newest message unless they've scrolled up to
  // read history. useLayoutEffect so the scroll write lands before paint.
  useLayoutEffect(() => {
    if (stickRef.current && chatRef.current) {
      chatRef.current.scrollTop = chatRef.current.scrollHeight;
    }
  }, [messages.length]);

  return (
    <div id="chat" className="chat" ref={chatRef}>
      {messages.length === 0 ? (
        <div className="empty">
          No announcements yet. Agents will post here as they coordinate.
        </div>
      ) : (
        messages.map((a, i) => {
          const targeted = a.targetAgentName !== null || a.toAdmin;
          const className =
            "msg" +
            (targeted ? " msg--targeted" : "") +
            (a.fromAdmin ? " msg--me" : "");
          return (
            // The feed has no stable id; index is acceptable because the list is
            // append-only oldest->newest and rows are never reordered in place.
            <div className={className} key={i}>
              <div
                className="msg__avatar"
                style={{ background: colorForName(a.fromAgentName) }}
              >
                {initialsFor(a.fromAgentName)}
              </div>
              <div className="msg__body">
                <div className="msg__head">
                  <span
                    className="msg__who"
                    style={{ color: colorForName(a.fromAgentName) }}
                  >
                    {a.fromAgentName}
                  </span>
                  {a.fromHuman ? <span className="msg__human">{a.fromHuman}</span> : null}
                  {a.targetAgentName !== null ? (
                    <span className="msg__to">{`→ @${a.targetAgentName}`}</span>
                  ) : a.targetMemberName !== null ? (
                    // An agent addressed a specific workspace member by name;
                    // legacy/collective operator messages fall through to "admin".
                    <span className="msg__to">{`→ @${a.targetMemberName}`}</span>
                  ) : a.toAdmin ? (
                    <span className="msg__to">→ admin</span>
                  ) : null}
                  <span className="msg__time">{formatRelative(a.createdAt, nowMs)}</span>
                </div>
                <div className="msg__text">{a.body}</div>
              </div>
            </div>
          );
        })
      )}
    </div>
  );
}
