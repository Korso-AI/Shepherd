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
    expect(cfg.FEEDBACK_EMAIL_TO).toBe("dev@korsoai.com");
    // Optional with no schema default — the effective default is applied at the
    // call sites (DEFAULT_UNCOMMITTED_GRACE_SECONDS), so it is undefined here.
    expect(cfg.UNCOMMITTED_GRACE_SECONDS).toBeUndefined();
  });

  it("reads HUB_ADMIN_LABEL from the environment when set", () => {
    const cfg = loadConfig({ ...BASE_ENV, HUB_ADMIN_LABEL: "admin@example.test" });
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
    expect(() => loadConfig(env)).toThrow(/self-host.*hosted|hosted.*self-host/i);
  });

  it("throws when only TEAM_TOKEN is set (ALLOWED_WORKSPACE missing, no BFF token)", () => {
    const env = { DATABASE_URL: "postgres://localhost/test", TEAM_TOKEN: "tok-abc" };
    expect(() => loadConfig(env)).toThrow(/self-host|hosted/i);
  });
});
