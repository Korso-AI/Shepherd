/**
 * The client version this hub advertises on join, read from the monorepo's
 * own mcp-server package.json. Because the hub deploys from the same commit
 * that tags a client release, the file sitting next to the hub IS the latest
 * published version — no registry lookup, no release-step bookkeeping.
 *
 * The relative hop works in both layouts:
 *   dev:  packages/hub/src/clientVersion.ts -> packages/mcp-server/package.json
 *   prod: /app/packages/hub/dist/clientVersion.js -> /app/packages/mcp-server/package.json
 * (the Dockerfile copies that package.json into the runtime image).
 *
 * Fails open: if the file is missing or unreadable the hub simply advertises
 * nothing and clients stay quiet.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const CLIENT_PACKAGE_JSON = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "mcp-server",
  "package.json",
);

export function readLatestClientVersion(
  file: string = CLIENT_PACKAGE_JSON,
): string | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as { version?: unknown }).version === "string"
    ) {
      return (parsed as { version: string }).version;
    }
  } catch {
    // Missing or unreadable — advertise nothing.
  }
  return null;
}

let cached: string | null | undefined;

/** Memoized: the version cannot change without a redeploy. */
export function advertisedClientVersion(): string | null {
  if (cached === undefined) cached = readLatestClientVersion();
  return cached;
}
