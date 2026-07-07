import { describe, it, expect } from "vitest";
import { SHEPHERD_UI_VERSION } from "./version.js";
import pkg from "../package.json";

describe("SHEPHERD_UI_VERSION", () => {
  it("matches package.json (bump version.ts when releasing)", () => {
    expect(SHEPHERD_UI_VERSION).toBe(pkg.version);
  });
});
