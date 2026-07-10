import { z } from "zod";
import { EntitlementLimits } from "@shepherd/shared";

/**
 * Zod schema for all environment variables consumed by the hub.
 * Numerics are coerced from string (as env vars always are).
 */
const ConfigSchema = z
  .object({
    DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
    // Self-host mode credentials. Optional at the field level: a hosted deployment
    // authenticates via BFF_INTERNAL_TOKEN instead. loadConfig's superRefine asserts
    // at least one full mode is configured, so neither is truly optional in practice.
    TEAM_TOKEN: z.string().min(1).optional(),
    HUB_PORT: z.coerce.number().int().positive().default(8080),
    ALLOWED_WORKSPACE: z.string().min(1).optional(),
    // Hosted mode credential: the shared secret the platform BFF presents to the Hub.
    // Optional at the field level; see the superRefine in loadConfig for the
    // "at least one mode must be fully configured" rule.
    BFF_INTERNAL_TOKEN: z.string().min(1).optional(),
    // HMAC secret for verifying the BFF-signed operator identity proof (the
    // `x-operator-*` headers) on `/admin/*` routes — the BFF's
    // CONSOLE_OPERATOR_IDENTITY_SECRET counterpart. See `requireOperator` in
    // tenant.ts for the full trust model. Optional and fail-closed: when unset,
    // operator headers never verify, so the operator surface is unreachable.
    OPERATOR_IDENTITY_SECRET: z.string().min(1).optional(),
    // The verified-email domain that marks a caller as an internal operator (the
    // exact domain after the last `@`, e.g. "example.com"). Optional and
    // fail-closed: with it unset, no operator email can ever match, so the
    // cross-tenant `/admin/*` analytics surface stays unreachable — the same
    // fail-closed posture as an unset OPERATOR_IDENTITY_SECRET. Threaded into
    // isInternalOperatorEmail (tenant.ts) rather than hardcoded, so no org-specific
    // domain ships in source.
    OPERATOR_EMAIL_DOMAIN: z.string().min(1).optional(),
    // Whether to derive request.ip from X-Forwarded-For. Fail-safe: only enable
    // when a TRUSTED reverse proxy that overwrites XFF fronts the hub, otherwise a
    // directly-exposed hub lets a client spoof XFF and dodge the per-IP pre-auth
    // throttle. Coerced leniently: only "true"/"1" enable it, any other present
    // value is false; UNSET stays undefined and the effective DEFAULT of `false`
    // is applied at the buildServer boundary (index.ts / server.ts). Optional so
    // the field never has to appear in a config literal. See server.ts's trustProxy.
    TRUST_PROXY: z
      .string()
      .transform((v) => v === "true" || v === "1")
      .optional(),
    DEFAULT_TTL_SECONDS: z.coerce.number().int().positive().default(3600),
    MIN_TTL_SECONDS: z.coerce.number().int().positive().default(30),
    STALE_AFTER_SECONDS: z.coerce.number().int().positive().default(120),
    CHANGE_RECORD_TTL_SECONDS: z.coerce
      .number()
      .int()
      .positive()
      .default(259200),
    // How long a DEAD agent's UNCOMMITTED change records (and the ordinal name they
    // reserve) stay visible after its last heartbeat. Decouples "is the session's
    // process alive" (STALE_AFTER_SECONDS, 120s — drives the active/offline label)
    // from "is this dirty work still plausibly going to change" (this grace window
    // — drives visibility). Covers crash/restart and short breaks without letting a
    // dead agent's dirty tree ghost until the 3-day CHANGE_RECORD_TTL. Optional so
    // the many inline test fixtures need not declare it; the effective default lives
    // at the call sites as DEFAULT_UNCOMMITTED_GRACE_SECONDS.
    UNCOMMITTED_GRACE_SECONDS: z.coerce.number().int().positive().optional(),
    // Sender label stamped on announcements the operator sends from the dashboard
    // (POST /workspace/announce). Agents see this as the message's author. Set it
    // to your email today; a future login flow will supply a real per-user
    // identity and override it per request.
    HUB_ADMIN_LABEL: z.string().min(1).default("admin"),
    // Oldest client version this hub still supports, advertised to clients on
    // join (see operations/join.ts + clientVersion.ts). Clients below it warn
    // their human every session instead of respecting the nudge cooldown.
    // OPTIONAL and inert: unset means no minimum is advertised.
    MIN_CLIENT_VERSION: z.string().min(1).optional(),
    // Email invites (POST /workspaces/:id/invites/email) are an OPTIONAL feature:
    // unset RESEND_API_KEY and the endpoint 501s rather than the Hub refusing to
    // boot — self-host operators who don't want it just skip these three vars.
    // When it IS set, INVITE_EMAIL_FROM and PUBLIC_WEB_URL become required (see
    // the superRefine below) because a "sent" email with no valid from-address or
    // join link would be worse than the feature not existing.
    RESEND_API_KEY: z.string().min(1).optional(),
    // Must be a sender address on a domain verified with Resend, e.g.
    // "Shepherd <invites@yourdomain.com>".
    INVITE_EMAIL_FROM: z.string().min(1).optional(),
    // The public origin the join link is built against (e.g. "https://app.example.com").
    // The Hub has no reliable way to infer its own public web origin from a
    // request, so this is explicit rather than derived from Host/Origin headers.
    PUBLIC_WEB_URL: z.string().min(1).optional(),
    // Where feedback-widget submissions are emailed. OPTIONAL, no default (no
    // org-specific address ships in source): when unset, the feedback send path
    // falls back to INVITE_EMAIL_FROM as the recipient (see operations/feedback.ts).
    // Either way, sending is enabled only when RESEND_API_KEY + INVITE_EMAIL_FROM
    // are also set (the sender address is shared with email invites); with those
    // unset the feature is simply inert.
    FEEDBACK_EMAIL_TO: z.string().min(1).optional(),
    // Deployment-default workspace caps as a JSON object, e.g.
    // '{"seatsLimit":10,"reposLimit":25,"retentionDays":180}' (null = that
    // dimension unlimited). OPTIONAL and inert by construction: when unset,
    // every entitlements check no-ops and the hub enforces no limits of any
    // kind (see enforcementEnabled in entitlements.ts). Malformed JSON or an
    // invalid shape fails config load loudly rather than silently disabling
    // enforcement on a deployment that meant to enable it.
    ENTITLEMENTS_DEFAULT_LIMITS: z
      .string()
      .transform((raw, ctx): unknown => {
        try {
          return JSON.parse(raw);
        } catch {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "must be a valid JSON object",
          });
          return z.NEVER;
        }
      })
      .pipe(EntitlementLimits)
      .optional(),
  })
  .superRefine((cfg, ctx) => {
    // One Hub binary, two deployment modes. Require at least one to be fully
    // configured so the Hub never boots without a way to authenticate callers
    // (fail-closed). Both modes configured simultaneously is allowed.
    const selfHost = Boolean(cfg.TEAM_TOKEN) && Boolean(cfg.ALLOWED_WORKSPACE);
    const hosted = Boolean(cfg.BFF_INTERNAL_TOKEN);
    if (!selfHost && !hosted) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["TEAM_TOKEN"],
        message:
          "no auth mode configured: set TEAM_TOKEN + ALLOWED_WORKSPACE (self-host) or BFF_INTERNAL_TOKEN (hosted)",
      });
    }

    if (cfg.RESEND_API_KEY && (!cfg.INVITE_EMAIL_FROM || !cfg.PUBLIC_WEB_URL)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["RESEND_API_KEY"],
        message:
          "RESEND_API_KEY is set but INVITE_EMAIL_FROM and/or PUBLIC_WEB_URL is missing — both are required once email invites are enabled",
      });
    }
  });

/** Parsed, validated configuration. Imported across the hub (operations, boot). */
export type Config = z.infer<typeof ConfigSchema>;

/**
 * Effective default for {@link Config.UNCOMMITTED_GRACE_SECONDS} (15 min). Applied
 * at call sites (`config.UNCOMMITTED_GRACE_SECONDS ?? DEFAULT_UNCOMMITTED_GRACE_SECONDS`)
 * because the env var is optional — see the schema comment for why.
 */
export const DEFAULT_UNCOMMITTED_GRACE_SECONDS = 900;

/**
 * Parse and validate config from an env-like object.
 * Defaults to `process.env` but accepts any Record<string,string|undefined>
 * so tests can supply a fake env without touching real process.env.
 *
 * Throws a ZodError (with a human-readable message) when required vars are
 * absent or values fail coercion.
 */
export function loadConfig(
  env: Record<string, string | undefined> = process.env,
): Config {
  const result = ConfigSchema.safeParse(env);
  if (!result.success) {
    const missing = result.error.issues
      .map((i) => `  ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Configuration error:\n${missing}`);
  }
  return result.data;
}
