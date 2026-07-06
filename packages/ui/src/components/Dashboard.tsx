import { useCallback, useEffect, useRef, useState } from "react";
import type { KeyboardEvent, ReactElement, ReactNode } from "react";
import type {
  WorkspaceLandscapeResponseT,
  WorkspaceSummaryT,
} from "@shepherd/shared";
import { useLandscapePolling } from "../useLandscapePolling.js";
import type { LandscapeStatus } from "../useLandscapePolling.js";
import { boardRepos, defaultRepo, matchesRepo } from "../logic.js";
import { RepoSelect } from "./RepoSelect.js";
import type { RepoCounts } from "./RepoSelect.js";
import { Crew } from "./Crew.js";
import { ActiveList } from "./ActiveList.js";
import { DoneList } from "./DoneList.js";
import { Chat } from "./Chat.js";
import { Composer } from "./Composer.js";
import { EmptyState } from "../config/EmptyState.js";
import { FeedbackWidget } from "./FeedbackWidget.js";
import { SetupChecklist } from "../onboarding/SetupChecklist.js";
import { useSetupStage } from "../onboarding/useSetupStage.js";
import { readStored, writeStored } from "../storage.js";

/**
 * localStorage keys + page size, ported verbatim from the state block of
 * packages/hub/public/app.js (POLL_MS lives in the hook).
 */
const TAB_KEY = "shepherd.tab";
const REPO_KEY = "shepherd.repo";
const DONE_PAGE = 10;

/**
 * The board views. `tasks` and `chat` mirror app.js's original two-view
 * `activeTab`; `config` is the hosted-shell management view, shown as a third
 * peer tab only when the host supplies a {@link DashboardProps.config} node.
 */
type Tab = "tasks" | "chat" | "config";

/**
 * Maps the polling hook's {@link LandscapeStatus} onto the chrome text + modifier
 * class the original board's `setStatus` produced. Kept as data so the header
 * stays a thin render of the hook's state.
 */
const STATUS_VIEW: Record<LandscapeStatus, { text: string; kind: string }> = {
  live: { text: "live", kind: "ok" },
  reconnecting: { text: "reconnecting…", kind: "warn" },
  // app.js cleared the token and re-prompted on 401; in the auth-agnostic port
  // the injected client's onUnauthorized owns any token handling, so the board
  // only surfaces the rejected state.
  unauthorized: { text: "token rejected", kind: "error" },
};

/**
 * Resolves the repo to actually filter by for this render, reproducing the
 * three side-effecting rules inside app.js's `render()` in order:
 *
 *  1. `null` (never chosen) + >=2 repos -> derive the newest-active default.
 *  2. a persisted specific repo that has VANISHED from the data -> "__all__"
 *     (so a workspace that narrowed to one repo can't strand the board on an
 *     absent repo — the selector itself hides under 2 repos).
 *  3. ONLY on first render, a persisted specific repo with no active work while
 *     another repo has some -> prefer the newest-active default, so a returning
 *     viewer never lands on an empty Active column. In-session picks are kept.
 *
 * Pure given its inputs; the caller commits the result back to state.
 *
 * @param selectedRepo - The current selection (`null` = not yet chosen).
 * @param snapshot - The landscape to resolve against.
 * @param firstRender - Whether this is the first render with a snapshot.
 * @returns The repo to use this render (`"__all__"` or a specific repo, never
 *   `null` once >=2 repos exist with no prior choice).
 */
function resolveSelectedRepo(
  selectedRepo: string | null,
  snapshot: WorkspaceLandscapeResponseT,
  firstRender: boolean,
): string | null {
  // The same board-wide repo set the selector renders (tasks + agents + chat),
  // so a repo that exists only via agents/announcements is both offered AND
  // survives the vanished-repo check below.
  const repos = boardRepos(snapshot);
  let next = selectedRepo;

  if (next === null && repos.length >= 2) {
    next = defaultRepo(snapshot.tasks);
  }

  if (next !== null && next !== "__all__" && !repos.includes(next)) {
    next = "__all__";
  }

  if (firstRender && next !== null && next !== "__all__") {
    const pinnedHasActive = snapshot.tasks.some(
      (t) => t.status === "active" && t.repo === next,
    );
    const anyActive = snapshot.tasks.some((t) => t.status === "active");
    if (!pinnedHasActive && anyActive) next = defaultRepo(snapshot.tasks);
  }

  return next;
}

/**
 * Per-repo `{active,done}` tallies plus the board-wide `"__all__"` aggregate,
 * mirroring app.js's `counts` map (each task bumps its own repo AND the
 * aggregate). The shape RepoSelect's `counts` prop expects.
 *
 * @param snapshot - The landscape whose tasks are tallied.
 * @returns A record keyed by repo, with an `"__all__"` aggregate row.
 */
function computeCounts(
  snapshot: WorkspaceLandscapeResponseT,
): Record<string, RepoCounts> {
  const counts: Record<string, RepoCounts> = {};
  const bump = (repo: string, key: "active" | "done"): void => {
    const c = (counts[repo] ??= { active: 0, done: 0 });
    c[key]++;
  };
  for (const t of snapshot.tasks) {
    const key = t.status === "active" ? "active" : "done";
    bump(t.repo, key);
    bump("__all__", key);
  }
  return counts;
}

/** Props for {@link Dashboard}. The client comes from context. */
export interface DashboardProps {
  /**
   * Workspace to scope the board to. When given, the polling hook hits the
   * workspace-scoped `landscape(id)` route and the composer posts via
   * `announceTo(id, …)`; when omitted, both fall back to the self-host singular
   * aliases, so a no-id render is unchanged.
   */
  workspaceId?: string;
  /**
   * The selected workspace summary, forwarded to the setup checklist so its
   * connect stage renders the checked workspace name (step 1) instead of the
   * create form. Optional — self-host callers omit it and never render the
   * checklist.
   */
  workspace?: WorkspaceSummaryT;
  /**
   * The hosted-shell management view. When supplied, a third `Config` tab is
   * shown beside `Tasks`/`Chat` and this node renders in its panel. Omitting it
   * (the self-host case) keeps the board a plain two-tab Tasks/Chat wallboard.
   */
  config?: ReactNode;
  /**
   * The hosted-shell workspace switcher, rendered in the header beside the brand
   * on EVERY tab (not just Config) so the active workspace is always visible.
   * Omitted for self-host, which has a single implicit team workspace.
   */
  switcher?: ReactNode;
  /**
   * Whether the account currently belongs to a workspace. Only meaningful in
   * the hosted shell (paired with {@link config}). When `false`, the view lands
   * on Tasks showing the first-run setup checklist (create stage), the Chat
   * panel shows an {@link EmptyState} prompt, and the board does not poll.
   * Defaults to "yes" (self-host always has its implicit team workspace).
   */
  hasWorkspace?: boolean;
  /**
   * Optional header logout seam. The dashboard only renders the control and
   * invokes this callback; authentication side effects belong to the caller.
   */
  onLogout?: () => void;
  /**
   * The DIRECT Hub URL the first-run setup checklist embeds in its agent install
   * command (hosted shell). Passed through to {@link SetupChecklist}; omitted for
   * self-host, where the checklist never renders.
   */
  hubUrl?: string;
  /**
   * Called after the setup checklist creates a workspace so the hosted shell
   * re-lists and flips `hasWorkspace`. Optional — self-host callers omit it and
   * never render the checklist.
   */
  onWorkspacesChanged?: () => void;
}

/**
 * The Shepherd wallboard shell. Composes {@link useLandscapePolling} (which reads
 * the client from context, keeping this auth-agnostic) with the six leaf
 * components, owning only the UI state app.js kept in module variables:
 *
 *  - `activeTab` — persisted to `"shepherd.tab"` (default `"tasks"`).
 *  - `selectedRepo` — persisted to `"shepherd.repo"`; `null` derives a default on
 *    the first render with >=2 repos (see {@link resolveSelectedRepo}).
 *  - `doneShown` — the history page size, grown a page at a time by "Load older".
 *
 * Header chrome mirrors app.js: brand, the repo filter, vitals (online/active
 * counts under the current filter), the poll status indicator, a freshness
 * string, and the tab strip. The body shows the Tasks panel (crew + active +
 * done) or the Chat panel (feed + composer); the composer's post-send hook is the
 * polling hook's `refresh`, so a sent message shows up immediately.
 *
 * Renders the header even before the first snapshot arrives so the board never
 * blanks — the panels simply render their own empty states off an empty
 * landscape.
 *
 * @returns The dashboard element.
 */
export function Dashboard({
  workspaceId,
  workspace,
  config,
  switcher,
  hasWorkspace,
  onLogout,
  hubUrl,
  onWorkspacesChanged,
}: DashboardProps = {}): ReactElement {
  const hasConfig = config != null;
  // The hosted shell is the only mode with a first-run setup checklist; the
  // discriminator is an explicit `hasWorkspace` (self-host leaves it undefined).
  const hosted = hasWorkspace !== undefined;
  // Only the hosted shell with an explicit empty account suppresses the board;
  // self-host (hasWorkspace undefined) always has its implicit team workspace.
  const noWorkspace = hasWorkspace === false;

  const { snapshot, snapshotWorkspaceId, status, lastUpdatedMs, refresh } =
    useLandscapePolling({
      workspaceId,
      // A no-workspace board has nothing to poll; keep it off the hub.
      enabled: !noWorkspace,
    });

  // The first-run setup checklist policy: stage derivation (stale-snapshot
  // gated), the per-workspace skip, the engaged latch, and the header
  // "Setup guide" re-open all live in the hook.
  const setup = useSetupStage({
    hosted,
    hasWorkspace: !noWorkspace,
    workspaceId,
    snapshot,
    snapshotWorkspaceId,
  });

  const [activeTab, setActiveTab] = useState<Tab>(() => {
    // A no-workspace hosted account lands on Tasks so the setup checklist is the
    // first thing a new user sees (Config stays reachable via its tab).
    const stored = readStored(TAB_KEY);
    if (stored === "chat") return "chat";
    if (stored === "config" && hasConfig) return "config";
    return "tasks";
  });

  // The flat tab strip: Tasks/Chat always, Config only when the host supplies it.
  const tabs: ReadonlyArray<{ id: Tab; label: string }> = hasConfig
    ? [
        { id: "tasks", label: "Tasks" },
        { id: "chat", label: "Chat" },
        { id: "config", label: "Config" },
      ]
    : [
        { id: "tasks", label: "Tasks" },
        { id: "chat", label: "Chat" },
      ];

  // Roving-tabindex refs for the tablist: each tab registers by index so
  // arrow/Home/End navigation can move DOM focus to the target tab.
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  // WAI-ARIA "tabs with automatic activation": Arrow keys (wrap-around), Home,
  // End change the active view AND move focus to the matching tab.
  const onTabKeyDown = useCallback(
    (e: KeyboardEvent<HTMLButtonElement>, index: number) => {
      const last = tabs.length - 1;
      let next: number | null = null;
      switch (e.key) {
        case "ArrowRight":
          next = index === last ? 0 : index + 1;
          break;
        case "ArrowLeft":
          next = index === 0 ? last : index - 1;
          break;
        case "Home":
          next = 0;
          break;
        case "End":
          next = last;
          break;
        default:
          return;
      }
      e.preventDefault();
      const target = tabs[next];
      if (!target) return;
      onTab(target.id);
      tabRefs.current[next]?.focus();
    },
    // `tabs` is rebuilt each render but its identity only matters by length,
    // which is stable for a given `hasConfig`; `onTab` is stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [hasConfig],
  );
  // `null` = not yet chosen (derive a default on first render); "__all__" = All
  // repos; else a specific repo. Seeded from storage exactly like app.js.
  const [selectedRepo, setSelectedRepo] = useState<string | null>(
    () => readStored(REPO_KEY),
  );
  const [doneShown, setDoneShown] = useState(DONE_PAGE);

  // First-load guard for resolveSelectedRepo's rule 3 — a persisted repo is only
  // second-guessed once, then in-session selections are respected (a ref because
  // flipping it must not itself trigger a render).
  const firstRenderRef = useRef(true);

  // No local 1s "freshness" timer: useLandscapePolling already runs its own 1s
  // tick that re-renders this component, so `freshness` (computed from Date.now()
  // below) refreshes every second on that re-render. A second interval here would
  // only duplicate the work.

  const onTab = useCallback((tab: Tab) => {
    setActiveTab(tab);
    writeStored(TAB_KEY, tab);
  }, []);

  const onSelectRepo = useCallback((repo: string | null) => {
    // app.js stores the "__all__" sentinel for All repos (RepoSelect reports null).
    const next = repo === null ? "__all__" : repo;
    setSelectedRepo(next);
    writeStored(REPO_KEY, next);
    setDoneShown(DONE_PAGE); // a new filter resets the history page
  }, []);

  const onLoadMore = useCallback(() => {
    setDoneShown((n) => n + DONE_PAGE);
  }, []);

  // Re-open the setup guide from the persistent header button: force it open and
  // route to the Tasks panel where it renders.
  const openSetupGuide = useCallback(() => {
    setup.openSetupGuide();
    onTab("tasks");
  }, [setup.openSetupGuide, onTab]);

  // The checklist created a workspace: latch the guide engaged across the
  // switch onto the new workspace (so it doesn't vanish until the first poll),
  // then let the shell re-list.
  const onChecklistWorkspaceCreated = useCallback(() => {
    setup.noteWorkspaceCreated();
    onWorkspacesChanged?.();
  }, [setup.noteWorkspaceCreated, onWorkspacesChanged]);

  // Resolve the effective repo for this render. When the resolver derives a
  // value different from state (first-load default / vanished repo), commit it so
  // the selection is sticky and persisted — done in an effect to avoid a setState
  // during render. `firstRenderRef` is consumed (flipped) once a snapshot exists.
  const effectiveRepo = snapshot
    ? resolveSelectedRepo(selectedRepo, snapshot, firstRenderRef.current)
    : selectedRepo;

  useEffect(() => {
    if (!snapshot) return;
    firstRenderRef.current = false;
    if (effectiveRepo !== selectedRepo) {
      setSelectedRepo(effectiveRepo);
      // Persist a derived *concrete* default so the next visit is stable (a
      // documented superset of app.js, which wrote REPO_KEY only on an explicit
      // pick). Do NOT persist the "__all__" vanished-repo fallback: it is a
      // transient reaction to a repo briefly dropping out of one poll, and
      // writing it would permanently clobber the viewer's saved specific filter
      // even after that repo reappears. Keeping it in-state only restores
      // app.js's recover-the-saved-repo-on-reload behavior.
      if (effectiveRepo !== null && effectiveRepo !== "__all__") {
        writeStored(REPO_KEY, effectiveRepo);
      }
    }
  }, [snapshot, effectiveRepo, selectedRepo]);

  const nowMs = snapshot ? Date.parse(snapshot.serverTime) : Date.now();

  // Board-wide repo set (tasks + agents + announcements) — see boardRepos. The
  // selector still hides itself below two repos (nothing to filter).
  const repos = snapshot ? boardRepos(snapshot) : [];
  const counts = snapshot
    ? computeCounts(snapshot)
    : ({} as Record<string, RepoCounts>);

  // Vitals: live agents + active tasks under the current filter (matchesRepo
  // treats null/"__all__" as all), mirroring app.js's `online`/`active`.
  const online = snapshot
    ? snapshot.agents.filter(
        (a) => a.presence === "live" && matchesRepo({ repo: a.repo ?? "" }, effectiveRepo),
      ).length
    : 0;
  const active = snapshot
    ? snapshot.tasks.filter((t) => t.status === "active" && matchesRepo(t, effectiveRepo)).length
    : 0;

  const statusView = STATUS_VIEW[status];
  const freshness =
    lastUpdatedMs === null
      ? ""
      : `updated ${Math.floor((Date.now() - lastUpdatedMs) / 1000)}s ago`;

  const agents = snapshot?.agents ?? [];
  const tasks = snapshot?.tasks ?? [];
  const announcements = snapshot?.announcements ?? [];

  // Column-head badges, ported from `renderActive`/`renderDone` which set
  // `#active-count`/`#done-count` to the filtered LIST lengths. activeCount
  // equals the `active` vital here (same filter), but doneCount is distinct.
  const activeCount = tasks.filter(
    (t) => t.status === "active" && matchesRepo(t, effectiveRepo),
  ).length;
  const doneCount = tasks.filter(
    (t) => t.status !== "active" && matchesRepo(t, effectiveRepo),
  ).length;

  const stage = setup.stage;

  // The poll-driven header chrome (repo filter, vitals, status, freshness) only
  // makes sense for a live board — hide it on the Config tab, when there is no
  // workspace to poll, and on the Tasks tab while the setup checklist replaces
  // the board there. The Chat tab still shows a live board during the connect
  // stage, so it keeps its chrome. The brand and tab strip stay in every state.
  const showBoardChrome =
    !noWorkspace &&
    activeTab !== "config" &&
    !(activeTab === "tasks" && stage !== "hidden");

  return (
    <div id="board" className={activeTab === "chat" ? "board--chat-active" : undefined}>
      <header>
        {/* The brand is the document <h1> so the outline is valid (h1 → the
            panels' h2). Inline resets keep it visually identical to the prior
            <span>; consumer CSS still targets `.brand`. */}
        <h1 className="brand" style={{ margin: 0, font: "inherit" }}>
          Shepherd
        </h1>
        {/* The workspace switcher rides beside the brand on every tab, so the
            active workspace is always in view — independent of board chrome. */}
        {switcher}
        {showBoardChrome && (
          <>
            <RepoSelect
              repos={repos}
              counts={counts}
              selected={effectiveRepo}
              onSelect={onSelectRepo}
            />
            <span className="vitals">
              <b id="vitals-online">{online}</b>
              {" online · "}
              <b id="vitals-active">{active}</b>
              {" active"}
            </span>
          </>
        )}
        <span className="grow" />
        {showBoardChrome && (
          <>
            <span
              id="status"
              className={"status" + (statusView.kind ? ` status--${statusView.kind}` : "")}
            >
              {statusView.text}
            </span>
            <span id="freshness" className="freshness">
              {freshness}
            </span>
          </>
        )}
        {hosted && (
          <button
            type="button"
            className="header-setup-guide"
            onClick={openSetupGuide}
          >
            Setup guide
          </button>
        )}
        {onLogout && (
          <button type="button" className="header-signout" onClick={onLogout}>
            Sign out
          </button>
        )}
        <nav className="tabs" role="tablist" aria-label="Shepherd views">
          {tabs.map(({ id, label }, index) => (
            <button
              key={id}
              ref={(el) => {
                tabRefs.current[index] = el;
              }}
              className={"tab" + (activeTab === id ? " tab--active" : "")}
              data-tab={id}
              type="button"
              role="tab"
              id={`tab-${id}`}
              aria-controls={`panel-${id}`}
              aria-selected={activeTab === id}
              tabIndex={activeTab === id ? 0 : -1}
              onClick={() => onTab(id)}
              onKeyDown={(e) => onTabKeyDown(e, index)}
            >
              {label}
            </button>
          ))}
        </nav>
      </header>

      <section
        id="panel-tasks"
        role="tabpanel"
        aria-labelledby="tab-tasks"
        hidden={activeTab !== "tasks"}
      >
        {stage !== "hidden" ? (
          <SetupChecklist
            stage={stage}
            workspace={workspace ?? null}
            // Stale-snapshot gate: never show another workspace's agents in
            // the check-in indicator during a switch.
            agents={
              snapshot && snapshotWorkspaceId === workspaceId
                ? snapshot.agents
                : null
            }
            hubUrl={hubUrl}
            onWorkspacesChanged={onChecklistWorkspaceCreated}
            onSkip={setup.skip}
          />
        ) : (
          <>
            <Crew agents={agents} tasks={tasks} selectedRepo={effectiveRepo} />
            <div className="board">
              <div className="col">
                <div className="colhead">
                  <h2>Active</h2>
                  <span className="n" id="active-count">
                    {activeCount}
                  </span>
                </div>
                <ActiveList tasks={tasks} nowMs={nowMs} selectedRepo={effectiveRepo} />
              </div>
              <div className="board__rule" />
              <div className="col">
                <div className="colhead">
                  <h2>Done</h2>
                  <span className="n" id="done-count">
                    {doneCount}
                  </span>
                </div>
                <DoneList
                  tasks={tasks}
                  nowMs={nowMs}
                  selectedRepo={effectiveRepo}
                  doneShown={doneShown}
                  onLoadMore={onLoadMore}
                />
              </div>
            </div>
          </>
        )}
      </section>

      <section
        id="panel-chat"
        role="tabpanel"
        aria-labelledby="tab-chat"
        hidden={activeTab !== "chat"}
      >
        {noWorkspace ? (
          <EmptyState
            onGetStarted={openSetupGuide}
            ctaLabel="Open setup guide"
          >
            Finish setting up your workspace to start chatting with your agents.
          </EmptyState>
        ) : (
          <div className="chat-wrap">
            <Chat announcements={announcements} selectedRepo={effectiveRepo} nowMs={nowMs} />
            <Composer
              agents={agents}
              selectedRepo={effectiveRepo}
              workspaceId={workspaceId}
              onSent={refresh}
            />
          </div>
        )}
      </section>

      {hasConfig && (
        <section
          id="panel-config"
          role="tabpanel"
          aria-labelledby="tab-config"
          hidden={activeTab !== "config"}
        >
          {config}
        </section>
      )}

      {/* Floats over every tab (and the no-workspace empty state) — not gated
          by activeTab/noWorkspace like the board chrome above. */}
      <FeedbackWidget workspaceId={workspaceId} />
    </div>
  );
}
