import type { ReactElement } from "react";

/** Props for {@link Territory}. */
export interface TerritoryProps {
  /** The claim's path globs. */
  globs: string[];
}

/**
 * A claim's territory pills. Ported from app.js `taskTerritory`. A single path
 * (or none) renders inline under a "territory" label; two or more collapse into
 * a native `<details>` whose summary reads `"N paths"` and expands to the full
 * glob list.
 *
 * Unlike app.js the open/closed state is left to the browser's native
 * `<details>` rather than persisted across polls: React reconciles the same
 * element across re-renders (no `replaceChildren` rebuild), so the fold state
 * survives without manual bookkeeping.
 *
 * @param props - The globs to display.
 * @returns The territory element (inline or a collapsible `<details>`).
 */
export function Territory({ globs }: TerritoryProps): ReactElement {
  if (globs.length <= 1) {
    return (
      <div className="terr">
        <span className="terr__lbl">territory</span>
        {globs.map((g) => (
          <span key={g} className="glob">
            {g}
          </span>
        ))}
      </div>
    );
  }
  return (
    <details className="terrx">
      <summary>
        <span className="terr__lbl">territory</span>
        <span className="glob glob--more">
          <span className="tw">▶</span>
          {` ${globs.length} paths`}
        </span>
      </summary>
      <div className="terr terr--full">
        {globs.map((g) => (
          <span key={g} className="glob">
            {g}
          </span>
        ))}
      </div>
    </details>
  );
}
