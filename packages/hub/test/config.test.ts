import { describe, it, expect } from "vitest";
import { loadConfig } from "../src/config.js";

const BASE_ENV = {
  DATABASE_URL: "postgres://localhost/test",
  TEAM_TOKEN: "tok-abc",
  ALLOWED_WORKSPACE: "acme",
};

describe("loadConfig — pure (no Postgres needed)", () => {
  it("returns typed config with all required fields", () => {
    const cfg = loadConfig(BASE_ENV);
    expect(cfg.DATABASE_URL).toBe("postgres://localhost/test");
    expect(cfg.TEAM_TOKEN).toBe("tok-abc");
    expect(cfg.ALLOWED_WORKSPACE).toBe("acme");
  });

  it("applies numeric defaults when optional vars are absent", () => {
    const cfg = loadConfig(BASE_ENV);
    expect(cfg.HUB_PORT).toBe(8080);
    expect(cfg.DEFAULT_TTL_SECONDS).toBe(3600);
    expect(cfg.MIN_TTL_SECONDS).toBe(30);
    expect(cfg.STALE_AFTER_SECONDS).toBe(120);
    expect(cfg.CHANGE_RECORD_TTL_SECONDS).toBe(259200);
    expect(cfg.HUB_ADMIN_LABEL).toBe("admin");
    // FEEDBACK_EMAIL_TO is optional with no default (no org-specific address in
    // source) — the send path falls back to INVITE_EMAIL_FROM when it is unset.
    expect(cfg.FEEDBACK_EMAIL_TO).toBeUndefined();
    // Optional with no schema default — the effective default is applied at the
    // call sites (DEFAULT_UNCOMMITTED_GRACE_SECONDS), so it is undefined here.
    expect(cfg.UNCOMMITTED_GRACE_SECONDS).toBeUndefined();
    // TRUST_PROXY is unset here → undefined; the fail-safe `false` default is
    // applied at the buildServer boundary, not in the parsed config.
    expect(cfg.TRUST_PROXY).toBeUndefined();
    // No operator domain baked in — fail-closed until explicitly configured.
    expect(cfg.OPERATOR_EMAIL_DOMAIN).toBeUndefined();
  });

  it('coerces TRUST_PROXY leniently — only "true"/"1" enable it', () => {
    expect(loadConfig({ ...BASE_ENV, TRUST_PROXY: "true" }).TRUST_PROXY).toBe(
      true,
    );
    expect(loadConfig({ ...BASE_ENV, TRUST_PROXY: "1" }).TRUST_PROXY).toBe(
      true,
    );
    expect(loadConfig({ ...BASE_ENV, TRUST_PROXY: "false" }).TRUST_PROXY).toBe(
      false,
    );
    expect(loadConfig({ ...BASE_ENV, TRUST_PROXY: "yes" }).TRUST_PROXY).toBe(
      false,
    );
  });

  it("reads HUB_ADMIN_LABEL from the environment when set", () => {
    const cfg = loadConfig({
      ...BASE_ENV,
      HUB_ADMIN_LABEL: "admin@example.test",
    });
    expect(cfg.HUB_ADMIN_LABEL).toBe("admin@example.test");
  });

  it("coerces numeric env vars from strings", () => {
    const cfg = loadConfig({
      ...BASE_ENV,
      HUB_PORT: "3000",
      DEFAULT_TTL_SECONDS: "600",
      MIN_TTL_SECONDS: "15",
      STALE_AFTER_SECONDS: "60",
      CHANGE_RECORD_TTL_SECONDS: "3600",
      UNCOMMITTED_GRACE_SECONDS: "1200",
    });
    expect(cfg.HUB_PORT).toBe(3000);
    expect(cfg.DEFAULT_TTL_SECONDS).toBe(600);
    expect(cfg.MIN_TTL_SECONDS).toBe(15);
    expect(cfg.STALE_AFTER_SECONDS).toBe(60);
    expect(cfg.CHANGE_RECORD_TTL_SECONDS).toBe(3600);
    expect(cfg.UNCOMMITTED_GRACE_SECONDS).toBe(1200);
  });

  it("throws a ZodError when CHANGE_RECORD_TTL_SECONDS is non-numeric", () => {
    expect(() =>
      loadConfig({ ...BASE_ENV, CHANGE_RECORD_TTL_SECONDS: "not-a-number" }),
    ).toThrow("CHANGE_RECORD_TTL_SECONDS");
  });

  it("throws a clear error when DATABASE_URL is missing", () => {
    const env = { ...BASE_ENV };
    delete (env as Record<string, string | undefined>)["DATABASE_URL"];
    expect(() => loadConfig(env)).toThrow("DATABASE_URL");
  });

  it("throws a clear error when TEAM_TOKEN is missing", () => {
    const env = { ...BASE_ENV };
    delete (env as Record<string, string | undefined>)["TEAM_TOKEN"];
    expect(() => loadConfig(env)).toThrow("TEAM_TOKEN");
  });

  it("throws a clear error when ALLOWED_WORKSPACE is missing", () => {
    const env = { ...BASE_ENV };
    delete (env as Record<string, string | undefined>)["ALLOWED_WORKSPACE"];
    expect(() => loadConfig(env)).toThrow("ALLOWED_WORKSPACE");
  });
});

describe("loadConfig — ENTITLEMENTS_DEFAULT_LIMITS", () => {
  it("is undefined when unset (enforcement disabled)", () => {
    expect(loadConfig(BASE_ENV).ENTITLEMENTS_DEFAULT_LIMITS).toBeUndefined();
  });

  it("parses valid JSON into camelCase limits", () => {
    const cfg = loadConfig({
      ...BASE_ENV,
      ENTITLEMENTS_DEFAULT_LIMITS:
        '{"seatsLimit":4,"reposLimit":5,"retentionDays":30}',
    });
    expect(cfg.ENTITLEMENTS_DEFAULT_LIMITS).toEqual({
      seatsLimit: 4,
      reposLimit: 5,
      retentionDays: 30,
    });
  });

  it("accepts null caps (unlimited dimensions)", () => {
    const cfg = loadConfig({
      ...BASE_ENV,
      ENTITLEMENTS_DEFAULT_LIMITS:
        '{"seatsLimit":null,"reposLimit":null,"retentionDays":null}',
    });
    expect(cfg.ENTITLEMENTS_DEFAULT_LIMITS).toEqual({
      seatsLimit: null,
      reposLimit: null,
      retentionDays: null,
    });
  });

  it("throws loudly at loadConfig on malformed JSON", () => {
    expect(() =>
      loadConfig({ ...BASE_ENV, ENTITLEMENTS_DEFAULT_LIMITS: "{not json" }),
    ).toThrow("ENTITLEMENTS_DEFAULT_LIMITS");
  });

  it("throws on valid JSON with an invalid shape (zero cap)", () => {
    expect(() =>
      loadConfig({
        ...BASE_ENV,
        ENTITLEMENTS_DEFAULT_LIMITS:
          '{"seatsLimit":0,"reposLimit":5,"retentionDays":30}',
      }),
    ).toThrow("ENTITLEMENTS_DEFAULT_LIMITS");
  });
});

describe("loadConfig — dual-mode env schema", () => {
  it("parses a self-host config (TEAM_TOKEN + ALLOWED_WORKSPACE, no BFF token)", () => {
    const cfg = loadConfig(BASE_ENV);
    expect(cfg.TEAM_TOKEN).toBe("tok-abc");
    expect(cfg.ALLOWED_WORKSPACE).toBe("acme");
    expect(cfg.BFF_INTERNAL_TOKEN).toBeUndefined();
  });

  it("parses a hosted config (BFF_INTERNAL_TOKEN only, no TEAM_TOKEN/ALLOWED_WORKSPACE)", () => {
    const cfg = loadConfig({
      DATABASE_URL: "postgres://localhost/test",
      BFF_INTERNAL_TOKEN: "bff-secret",
    });
    expect(cfg.BFF_INTERNAL_TOKEN).toBe("bff-secret");
    expect(cfg.TEAM_TOKEN).toBeUndefined();
    expect(cfg.ALLOWED_WORKSPACE).toBeUndefined();
  });

  it("parses when both self-host and hosted modes are configured", () => {
    const cfg = loadConfig({ ...BASE_ENV, BFF_INTERNAL_TOKEN: "bff-secret" });
    expect(cfg.TEAM_TOKEN).toBe("tok-abc");
    expect(cfg.ALLOWED_WORKSPACE).toBe("acme");
    expect(cfg.BFF_INTERNAL_TOKEN).toBe("bff-secret");
  });

  it("throws naming the missing mode when no mode is configured", () => {
    const env = { DATABASE_URL: "postgres://localhost/test" };
    expect(() => loadConfig(env)).toThrow(
      /self-host.*hosted|hosted.*self-host/i,
    );
  });

  it("throws when only TEAM_TOKEN is set (ALLOWED_WORKSPACE missing, no BFF token)", () => {
    const env = {
      DATABASE_URL: "postgres://localhost/test",
      TEAM_TOKEN: "tok-abc",
    };
    expect(() => loadConfig(env)).toThrow(/self-host|hosted/i);
  });
});
