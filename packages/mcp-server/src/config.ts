import { z } from "zod";

const ConfigSchema = z
  .object({
    // Hard-required: Hub endpoint.
    HUB_URL: z.string().min(1, "HUB_URL is required"),

    // Auth credentials. Exactly one form is needed (enforced by the refine below):
    //   - SHEPHERD_TOKEN: the hosted Hub credential (carries its own workspace).
    //   - TEAM_TOKEN: the self-host credential.
    // SHEPHERD_TOKEN wins when both are present (see the derived `authToken`).
    SHEPHERD_TOKEN: z.string().min(1).optional(),
    TEAM_TOKEN: z.string().min(1).optional(),

    // Optional overrides — resolveContext will apply defaults for any that are absent.
    // WORKSPACE default is applied in resolveContext (auto-detected from cwd basename).
    // NOTE: WORKSPACE is IGNORED by the hosted Hub — the SHEPHERD_TOKEN carries the
    // workspace identity. It remains meaningful only for self-host (TEAM_TOKEN) setups.
    WORKSPACE: z.string().min(1).optional(),
  REPO: z.string().min(1).optional(),
  BRANCH: z.string().min(1).optional(),
  BASE_BRANCH: z.string().min(1).optional(),
  HUMAN: z.string().min(1).optional(),
  PROGRAM: z.string().min(1).optional(),
  MODEL: z.string().min(1).optional(),

  // Heartbeat cadence in seconds; coerced from string env var.
  HEARTBEAT_INTERVAL_SECONDS: z.coerce.number().int().positive().default(60),

  // Opt-in: directory for the local announcement inbox. When set, the background
  // heartbeat delivers pending announcements into a per-cwd file here, which the
  // `shepherd-inbox-hook` (configured with the SAME dir) drains into the agent's
  // context on its next action. Unset → no inbox, announcements flow only via
  // work/sync/done/announce tool results as before. Both the MCP server and the
  // hook must agree on this path.
  SHEPHERD_INBOX_DIR: z.string().min(1).optional(),

  // Opt-out for the zero-setup hook auto-install (Layer 4). Any of "1", "true",
  // "yes" (case-insensitive) disables it; everything else (including unset)
  // leaves the default-on behavior. See hookInstall.ts and the README.
  SHEPHERD_NO_AUTO_HOOKS: z
    .string()
    .optional()
    .transform((v) => ["1", "true", "yes"].includes((v ?? "").toLowerCase())),
  })
  .refine((c) => Boolean(c.SHEPHERD_TOKEN || c.TEAM_TOKEN), {
    message: "Either SHEPHERD_TOKEN or TEAM_TOKEN is required",
    path: ["SHEPHERD_TOKEN"],
  });

/**
 * Parsed config plus a derived `authToken` — the single credential put on the wire.
 * The refine above guarantees at least one of SHEPHERD_TOKEN / TEAM_TOKEN is set,
 * so `authToken` is always a non-optional string.
 */
export type Config = z.infer<typeof ConfigSchema> & { authToken: string };

/**
 * Parse env vars into a typed Config. Throws a ZodError on missing/invalid vars.
 * Use this in tests — it does NOT call process.exit.
 */
export function parseConfig(env: Record<string, string | undefined>): Config {
  const parsed = ConfigSchema.parse({
    HUB_URL: env["HUB_URL"],
    SHEPHERD_TOKEN: env["SHEPHERD_TOKEN"],
    TEAM_TOKEN: env["TEAM_TOKEN"],
    WORKSPACE: env["WORKSPACE"],
    REPO: env["REPO"],
    BRANCH: env["BRANCH"],
    BASE_BRANCH: env["BASE_BRANCH"],
    HUMAN: env["HUMAN"],
    PROGRAM: env["PROGRAM"],
    MODEL: env["MODEL"],
    HEARTBEAT_INTERVAL_SECONDS: env["HEARTBEAT_INTERVAL_SECONDS"],
    SHEPHERD_INBOX_DIR: env["SHEPHERD_INBOX_DIR"],
    SHEPHERD_NO_AUTO_HOOKS: env["SHEPHERD_NO_AUTO_HOOKS"],
  });
  // Derive the wire credential: SHEPHERD_TOKEN (hosted) wins over TEAM_TOKEN (self-host).
  // The refine guarantees at least one is set, so this is always a string.
  const authToken = (parsed.SHEPHERD_TOKEN ?? parsed.TEAM_TOKEN) as string;
  return { ...parsed, authToken };
}

/**
 * Load config from process.env. On failure prints a clear message to stderr and exits 1.
 * Use this in the production entrypoint.
 */
export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  try {
    return parseConfig(env);
  } catch (err) {
    if (err instanceof z.ZodError) {
      const messages = err.issues.map((e) => `  ${e.path.join(".")}: ${e.message}`).join("\n");
      process.stderr.write(`[shepherd] Configuration error — missing or invalid env vars:\n${messages}\n`);
    } else {
      process.stderr.write(`[shepherd] Unexpected configuration error: ${String(err)}\n`);
    }
    process.exit(1);
  }
}
