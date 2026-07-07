import { describe, it, expect } from "vitest";
import { buildFeedbackContext } from "./feedbackContext.js";
import { SHEPHERD_UI_VERSION } from "./version.js";

describe("buildFeedbackContext", () => {
  it("gathers route, appVersion, userAgent and viewport from the browser", () => {
    const ctx = buildFeedbackContext();
    expect(ctx).toBeDefined();
    expect(ctx!.route).toBe(window.location.pathname + window.location.hash);
    expect(ctx!.appVersion).toBe(SHEPHERD_UI_VERSION);
    expect(ctx!.userAgent).toBe(navigator.userAgent);
    expect(ctx!.viewport).toMatch(/^\d+x\d+$/);
  });
});
