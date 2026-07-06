import { createRequire } from "node:module";

/**
 * The package version, read from package.json at runtime so it can never go
 * stale (the MCP handshake previously hardcoded "0.1.0"). Both src/ (tsx dev)
 * and the bundled dist/ sit one level below the package root, so the relative
 * require resolves identically from either. Fail-open to "0.0.0" — a version
 * string is never worth crashing the server over.
 */
export const PACKAGE_VERSION: string = (() => {
  try {
    const req = createRequire(import.meta.url);
    const pkg = req("../package.json") as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
})();
