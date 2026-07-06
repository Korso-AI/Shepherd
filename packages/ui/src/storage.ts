// ---------------------------------------------------------------------------
// storage — exception-safe localStorage access shared by the board chrome and
// the setup-stage hook. Persistence here is always best-effort UI state (tab,
// repo filter, setup-skip flags), so private/quota modes degrade to in-memory
// behavior rather than throwing.
// ---------------------------------------------------------------------------

/** localStorage read that never throws (private/quota modes return null). */
export function readStored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** localStorage write that never throws — persistence is best-effort chrome. */
export function writeStored(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Ignore: a board that can't persist its filter still works this session.
  }
}
