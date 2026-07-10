/**
 * The library's own version, reported as `appVersion` in feedback context.
 * A hand-maintained constant (the vite lib build has no clean package.json
 * import path under the project's tsc setup); version.test.ts pins it to
 * package.json so a release bump that forgets this file fails CI.
 */
export const SHEPHERD_UI_VERSION = "0.19.0";
