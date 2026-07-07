import { describe, it, expect, vi } from "vitest";
import { parseConfig, assertHubUrlAllowed } from "../src/config.js";

const VALID_ENV = {
  HUB_URL: "http://localhost:4000",
  TEAM_TOKEN: "tok-abc123",
  WORKSPACE: "acme",
  REPO: "my-repo",
  BRANCH: "main",
  HUMAN: "alice",
  PROGRAM: "shepherd",
  MODEL: "claude-sonnet-4-5",
};

describe("parseConfig", () => {
  it("returns a typed config object when all required vars are present", () => {
    const config = parseConfig(VALID_ENV);
    expect(config.HUB_URL).toBe("http://localhost:4000");
    expect(config.TEAM_TOKEN).toBe("tok-abc123");
    expect(config.WORKSPACE).toBe("acme");
    expect(config.REPO).toBe("my-repo");
    expect(config.BRANCH).toBe("main");
    expect(config.HUMAN).toBe("alice");
    expect(config.PROGRAM).toBe("shepherd");
    expect(config.MODEL).toBe("claude-sonnet-4-5");
  });

  it("throws when HUB_URL is missing", () => {
    const env = { ...VALID_ENV };
    delete (env as Partial<typeof VALID_ENV>).HUB_URL;
    expect(() => parseConfig(env)).toThrow();
  });

  it("throws when TEAM_TOKEN is missing", () => {
    const env = { ...VALID_ENV };
    delete (env as Partial<typeof VALID_ENV>).TEAM_TOKEN;
    expect(() => parseConfig(env)).toThrow();
  });

  // Task 5.1: SHEPHERD_TOKEN (hosted credential) is accepted alongside TEAM_TOKEN
  // (self-host credential). At least one must be set; SHEPHERD_TOKEN wins when both
  // are present. The derived `authToken` is the credential put on the wire.
  describe("authToken (SHEPHERD_TOKEN / TEAM_TOKEN)", () => {
    it("uses SHEPHERD_TOKEN when only SHEPHERD_TOKEN is set", () => {
      const config = parseConfig({
        HUB_URL: "http://hub.example.com",
        SHEPHERD_TOKEN: "shp-123",
      });
      expect(config.authToken).toBe("shp-123");
      expect(config.SHEPHERD_TOKEN).toBe("shp-123");
      expect(config.TEAM_TOKEN).toBeUndefined();
    });

    it("uses TEAM_TOKEN when only TEAM_TOKEN is set", () => {
      const config = parseConfig({
        HUB_URL: "http://hub.example.com",
        TEAM_TOKEN: "tok-xyz",
      });
      expect(config.authToken).toBe("tok-xyz");
      expect(config.TEAM_TOKEN).toBe("tok-xyz");
      expect(config.SHEPHERD_TOKEN).toBeUndefined();
    });

    it("prefers SHEPHERD_TOKEN over TEAM_TOKEN when both are set", () => {
      const config = parseConfig({
        HUB_URL: "http://hub.example.com",
        TEAM_TOKEN: "tok-xyz",
        SHEPHERD_TOKEN: "shp-123",
      });
      expect(config.authToken).toBe("shp-123");
    });

    it("throws when neither SHEPHERD_TOKEN nor TEAM_TOKEN is set", () => {
      expect(() =>
        parseConfig({
          HUB_URL: "http://hub.example.com",
        })
      ).toThrow();
    });
  });

  // Task 4.3: WORKSPACE, REPO, BRANCH, HUMAN, PROGRAM, MODEL are now optional overrides.
  // resolveContext will apply defaults for missing WORKSPACE later.
  it("parses successfully with only HUB_URL and TEAM_TOKEN; optional fields are undefined", () => {
    const config = parseConfig({
      HUB_URL: "http://hub.example.com",
      TEAM_TOKEN: "tok-xyz",
    });
    expect(config.HUB_URL).toBe("http://hub.example.com");
    expect(config.TEAM_TOKEN).toBe("tok-xyz");
    expect(config.WORKSPACE).toBeUndefined();
    expect(config.REPO).toBeUndefined();
    expect(config.BRANCH).toBeUndefined();
    expect(config.HUMAN).toBeUndefined();
    expect(config.PROGRAM).toBeUndefined();
    expect(config.MODEL).toBeUndefined();
    expect(config.BASE_BRANCH).toBeUndefined();
  });

  it("HEARTBEAT_INTERVAL_SECONDS defaults to 60 when not set", () => {
    const config = parseConfig({
      HUB_URL: "http://hub.example.com",
      TEAM_TOKEN: "tok-xyz",
    });
    expect(config.HEARTBEAT_INTERVAL_SECONDS).toBe(60);
  });

  it("HEARTBEAT_INTERVAL_SECONDS coerces a string value to number", () => {
    const config = parseConfig({
      HUB_URL: "http://hub.example.com",
      TEAM_TOKEN: "tok-xyz",
      HEARTBEAT_INTERVAL_SECONDS: "30",
    });
    expect(config.HEARTBEAT_INTERVAL_SECONDS).toBe(30);
  });

  it("HEARTBEAT_INTERVAL_SECONDS throws on non-positive value", () => {
    expect(() =>
      parseConfig({
        HUB_URL: "http://hub.example.com",
        TEAM_TOKEN: "tok-xyz",
        HEARTBEAT_INTERVAL_SECONDS: "0",
      })
    ).toThrow();
  });

  it("BASE_BRANCH is optional and undefined when not set", () => {
    const config = parseConfig({
      HUB_URL: "http://hub.example.com",
      TEAM_TOKEN: "tok-xyz",
    });
    expect(config.BASE_BRANCH).toBeUndefined();
  });

  it("BASE_BRANCH is present when set", () => {
    const config = parseConfig({
      HUB_URL: "http://hub.example.com",
      TEAM_TOKEN: "tok-xyz",
      BASE_BRANCH: "develop",
    });
    expect(config.BASE_BRANCH).toBe("develop");
  });

  it("SHEPHERD_INBOX_DIR is optional and undefined when not set", () => {
    const config = parseConfig({
      HUB_URL: "http://hub.example.com",
      TEAM_TOKEN: "tok-xyz",
    });
    expect(config.SHEPHERD_INBOX_DIR).toBeUndefined();
  });

  it("SHEPHERD_INBOX_DIR is present when set (overrides the default inbox dir)", () => {
    const config = parseConfig({
      HUB_URL: "http://hub.example.com",
      TEAM_TOKEN: "tok-xyz",
      SHEPHERD_INBOX_DIR: "/tmp/shepherd-inbox",
    });
    expect(config.SHEPHERD_INBOX_DIR).toBe("/tmp/shepherd-inbox");
  });
});

// Insecure http HUB_URL: cleartext to a non-loopback host is refused unless the
// operator explicitly opts in. Loopback http and https always pass.
describe("assertHubUrlAllowed", () => {
  it("allows https to any host", () => {
    expect(() => assertHubUrlAllowed("https://shepherd.example.com", {})).not.toThrow();
  });

  it("allows plain http to loopback hosts (local dev)", () => {
    for (const url of [
      "http://localhost:4000",
      "http://127.0.0.1:4000",
      "http://[::1]:4000",
    ]) {
      expect(() => assertHubUrlAllowed(url, {})).not.toThrow();
    }
  });

  it("REFUSES plain http to a non-loopback host without the opt-in", () => {
    expect(() => assertHubUrlAllowed("http://hub.example.com", {})).toThrow(
      /cleartext|unencrypted|SHEPHERD_ALLOW_INSECURE_HTTP/,
    );
  });

  it("permits non-loopback http when SHEPHERD_ALLOW_INSECURE_HTTP is set (with a stderr warning)", () => {
    const errSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    for (const val of ["1", "true", "yes", "YES"]) {
      expect(() =>
        assertHubUrlAllowed("http://hub.example.com", { SHEPHERD_ALLOW_INSECURE_HTTP: val }),
      ).not.toThrow();
    }
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it("does not opt in for a non-truthy flag value", () => {
    expect(() =>
      assertHubUrlAllowed("http://hub.example.com", { SHEPHERD_ALLOW_INSECURE_HTTP: "0" }),
    ).toThrow();
  });
});
