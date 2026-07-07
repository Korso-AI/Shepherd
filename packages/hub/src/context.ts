/**
 * Shared hub runtime context: the Postgres pool + parsed config that every
 * operation (`join`/`work`/`done`/`announce`/`sync`) needs.
 *
 * The plan's operation signatures are `op(input)` with no deps parameter, so
 * operations resolve their dependencies through this module-level accessor
 * rather than threading a context argument everywhere.
 *
 * - Production: `index.ts` calls `initContext({ pool, config })` at boot before
 *   any request can arrive.
 * - Tests: call `initContext({ pool: testPool, config: testConfig })` before
 *   invoking an operation so it runs against the disposable test database, and
 *   `resetContext()` between suites for isolation.
 */

import type pg from "pg";
import { type Config } from "./config.js";

export interface HubContext {
  pool: pg.Pool;
  config: Config;
}

let current: HubContext | null = null;

/**
 * Explicitly set the shared context (server boot, or test injection).
 *
 * Fails fast on a DOUBLE init: silently overwriting a live context turns this
 * module into a mutable service locator where the pool/config in force depends
 * on call order — a footgun in production (e.g. a stray re-init swapping the
 * pool out from under in-flight requests). Production boot (`index.ts`) calls
 * this exactly once; tests must `resetContext()` before re-initialising for a
 * new suite. The throw makes an accidental second init loud instead of silent.
 */
export function initContext(ctx: HubContext): void {
  if (current !== null) {
    throw new Error(
      "Hub context already initialised — call resetContext() before initContext() again " +
        "(production boots once; tests reset between suites).",
    );
  }
  current = ctx;
}

/**
 * Return the shared context. Throws if `initContext` was never called — this is
 * a fail-fast guard: an operation (including the security-critical auth path)
 * must never silently run against an env-derived pool/config that nobody
 * intended. Both production boot and tests call `initContext` first.
 */
export function getContext(): HubContext {
  if (current === null) {
    throw new Error(
      "Hub context not initialised — call initContext({ pool, config }) before handling requests.",
    );
  }
  return current;
}

/** Clear the context. Tests use this to guarantee isolation between suites. */
export function resetContext(): void {
  current = null;
}
