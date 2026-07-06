/**
 * Glob-overlap detection for conflict warnings.
 *
 * `globsOverlap(A, B)` returns true if any pattern in A could share a matching
 * path with any pattern in B. This powers advisory conflict warnings between
 * concurrent agents' file reservations.
 *
 * Design bias: FAVOR RECALL. False positives (spurious warnings) are cheap and
 * acceptable; a missed conflict is the costly failure. The matcher is therefore
 * deliberately conservative — when in doubt, it reports overlap.
 *
 * No runtime dependency: we implement a small segment-wise recursive matcher
 * rather than pulling a library (no mainstream npm lib does pattern-vs-pattern
 * intersection — they only match a pattern against a concrete path).
 */

const WILDCARD_CHARS = ['*', '?', '{', '}', '[', ']'];

function hasWildcard(segment: string): boolean {
  return WILDCARD_CHARS.some((c) => segment.includes(c));
}

/**
 * Normalize a glob/path pattern into a segment list.
 *
 * - lowercase the whole string (case-insensitive matching is cross-OS safe and
 *   favors recall on case-insensitive filesystems like Windows/macOS);
 * - convert `\` to `/`;
 * - strip a trailing `/` and treat a bare directory as `dir/**` — a directory
 *   reservation claims its whole subtree (the most important recall rule);
 * - split on `/` into a segment list, dropping empty segments (so a leading `/`
 *   or duplicate `//` is absorbed);
 * - canonicalize relative segments so equivalent spellings compare equal: drop
 *   `.` (current-dir, incl. a leading `./`) and resolve `..` by popping the
 *   previous segment (a `..` that would climb above the root is dropped). This
 *   closes silent-miss gaps from representation drift; over-collapsing only ever
 *   WIDENS overlap, which is the safe (recall-favoring) direction.
 */
export function normalize(pattern: string): string[] {
  let p = pattern.toLowerCase().replace(/\\/g, '/');

  // A bare directory reservation (trailing slash) claims its whole subtree.
  if (p.endsWith('/')) {
    p = p.replace(/\/+$/, '') + '/**';
  }

  // Split on '/', dropping empty segments produced by leading/duplicate slashes.
  const rawSegments = p.split('/').filter((s) => s.length > 0);

  // Resolve '.' and '..' so e.g. './src/auth', '/src/auth', and 'src/x/../auth'
  // all canonicalize to a comparable form.
  const segments: string[] = [];
  for (const seg of rawSegments) {
    if (seg === '.') continue;
    if (seg === '..') {
      if (segments.length > 0) segments.pop();
      continue;
    }
    segments.push(seg);
  }
  return segments;
}

/**
 * Are two single segments compatible (could a concrete path segment satisfy
 * both)?
 *
 * - either is exactly `*` -> compatible (matches anything within one segment);
 * - both pure literals -> compatible iff equal;
 * - either contains any wildcard (`*`,`?`,`{`,`}`,`[`,`]`) -> conservatively
 *   compatible. v1 favors recall.
 *
 * NOTE (future precision pass): a later, more precise implementation could
 * brace-expand `{a,b}` alternatives and test each pair with
 * picomatch(seg, { nocase: true }) to decide real segment intersection. For
 * advisory warnings the cheap "any wildcard => maybe" rule is correct-enough.
 */
export function segmentsCompatible(a: string, b: string): boolean {
  if (a === '*' || b === '*') return true;

  const aWild = hasWildcard(a);
  const bWild = hasWildcard(b);

  if (!aWild && !bWild) return a === b;

  // At least one side has a wildcard we don't precisely evaluate -> be lenient.
  return true;
}

/**
 * Do two NORMALIZED patterns (segment arrays) overlap?
 *
 * Recursive segment-wise matcher where `**` consumes zero-or-more segments.
 *
 * Memoized on the `(i, j)` suffix positions. The naive recursion branches on
 * every globstar on either side, so a pattern packed with many globstar
 * segments (which a claim/record author can craft within the 512-char glob
 * limit) drives exponential backtracking and amplifies hub CPU — SEC-2.
 * Caching each `(i, j)` collapses that to O(|a|*|b|) while preserving the exact
 * same result.
 */
export function patternsOverlap(a: string[], b: string[]): boolean {
  const bLen = b.length;
  const memo = new Map<number, boolean>();

  function go(i: number, j: number): boolean {
    const aRemaining = a.length - i;
    const bRemaining = bLen - j;

    // Both exhausted -> they describe the same (empty) remainder -> overlap.
    if (aRemaining === 0 && bRemaining === 0) return true;

    // One side exhausted: overlap only if the other is entirely `**` segments
    // (each `**` can consume zero segments, so it can match the empty remainder).
    if (aRemaining === 0) {
      for (let k = j; k < bLen; k++) if (b[k] !== '**') return false;
      return true;
    }
    if (bRemaining === 0) {
      for (let k = i; k < a.length; k++) if (a[k] !== '**') return false;
      return true;
    }

    const cacheKey = i * (bLen + 1) + j;
    const cached = memo.get(cacheKey);
    if (cached !== undefined) return cached;

    const aHead = a[i];
    const bHead = b[j];

    let result: boolean;
    // `**` consumes zero-or-more segments on whichever side it appears.
    if (aHead === '**') {
      // zero: skip the ** ; or one+: consume one segment of B and keep the **.
      result = go(i + 1, j) || go(i, j + 1);
    } else if (bHead === '**') {
      result = go(i, j + 1) || go(i + 1, j);
    } else if (segmentsCompatible(aHead, bHead)) {
      // Plain heads: must be compatible, then recurse on both tails.
      result = go(i + 1, j + 1);
    } else {
      result = false;
    }

    memo.set(cacheKey, result);
    return result;
  }

  return go(0, 0);
}

/**
 * Do any pattern in `globsA` and any pattern in `globsB` overlap?
 * Empty input arrays yield false (and never throw).
 */
export function globsOverlap(globsA: string[], globsB: string[]): boolean {
  const normA = globsA.map(normalize);
  const normB = globsB.map(normalize);

  for (const a of normA) {
    for (const b of normB) {
      if (patternsOverlap(a, b)) return true;
    }
  }
  return false;
}
