import { describe, it, expect } from "vitest";
import {
  normalize,
  segmentsCompatible,
  patternsOverlap,
  globsOverlap,
} from "../src/globs";

describe("globs module", () => {
  describe("normalize()", () => {
    const cases: Array<[string, string[]]> = [
      ["src/auth/login.ts", ["src", "auth", "login.ts"]],
      ["src/auth/", ["src", "auth", "**"]], // trailing slash -> dir reservation
      ["src/auth", ["src", "auth"]], // plain file/segment, not a dir
      ["src\\auth\\login.ts", ["src", "auth", "login.ts"]], // backslashes -> forward
      ["src/Login.ts", ["src", "login.ts"]], // lowercased
      ["SRC/AUTH/", ["src", "auth", "**"]], // lowercased + dir expand
      ["**/*.test.ts", ["**", "*.test.ts"]],
      ["./src/auth", ["src", "auth"]], // leading ./ dropped
      ["/src/auth", ["src", "auth"]], // leading / absorbed (empty segment)
      ["src//auth", ["src", "auth"]], // duplicate slash absorbed
      ["src/./auth", ["src", "auth"]], // interior . dropped
      ["src/x/../auth", ["src", "auth"]], // .. pops previous segment
      ["../src/auth", ["src", "auth"]], // .. above root dropped
      ["src/../../auth", ["auth"]], // surplus .. cannot climb above root
    ];
    for (const [input, expected] of cases) {
      it(`normalizes ${JSON.stringify(input)} -> ${JSON.stringify(expected)}`, () => {
        expect(normalize(input)).toEqual(expected);
      });
    }
  });

  describe("segmentsCompatible()", () => {
    const cases: Array<[string, string, boolean, string]> = [
      ["*", "anything.ts", true, "bare * matches anything"],
      ["anything.ts", "*", true, "bare * matches anything (symmetric)"],
      ["login.ts", "login.ts", true, "equal literals"],
      ["login.ts", "logout.ts", false, "unequal literals"],
      [
        "*.ts",
        "auth.js",
        true,
        "wildcard side -> conservatively compatible (recall)",
      ],
      [
        "auth.js",
        "*.ts",
        true,
        "wildcard side -> conservatively compatible (symmetric)",
      ],
      ["file?.ts", "fileX.ts", true, "? wildcard -> conservatively compatible"],
      ["{a,b}.ts", "c.ts", true, "brace wildcard -> conservatively compatible"],
    ];
    for (const [a, b, expected, label] of cases) {
      it(`segmentsCompatible(${JSON.stringify(a)}, ${JSON.stringify(b)}) === ${expected} (${label})`, () => {
        expect(segmentsCompatible(a, b)).toBe(expected);
      });
    }
  });

  describe("patternsOverlap()", () => {
    const cases: Array<[string[], string[], boolean, string]> = [
      [[], [], true, "both empty -> overlap"],
      [["**"], [], true, "one empty, other all ** -> overlap"],
      [["**", "**"], [], true, "one empty, other all ** (multiple) -> overlap"],
      [[], ["**"], true, "one empty, other all ** (symmetric) -> overlap"],
      [["src"], [], false, "one empty, other non-** -> no overlap"],
      [
        ["src", "auth", "**"],
        ["src", "auth", "login.ts"],
        true,
        "** absorbs tail",
      ],
      [["src", "auth"], ["src", "payments"], false, "disjoint literals"],
      [
        ["**", "*.test.ts"],
        ["src", "auth", "foo.test.ts"],
        true,
        "leading ** absorbs prefix",
      ],
    ];
    for (const [a, b, expected, label] of cases) {
      it(`patternsOverlap(${JSON.stringify(a)}, ${JSON.stringify(b)}) === ${expected} (${label})`, () => {
        expect(patternsOverlap(a, b)).toBe(expected);
      });
    }
  });

  describe("globsOverlap()", () => {
    // Happy path + spec-required cases
    it("src/auth/** overlaps src/auth/login.ts", () => {
      expect(globsOverlap(["src/auth/**"], ["src/auth/login.ts"])).toBe(true);
    });

    it("src/auth/** overlaps **/*.test.ts (** on right absorbs src/auth)", () => {
      expect(globsOverlap(["src/auth/**"], ["**/*.test.ts"])).toBe(true);
    });

    it("src/auth/** does NOT overlap src/payments/** (disjoint subtrees)", () => {
      expect(globsOverlap(["src/auth/**"], ["src/payments/**"])).toBe(false);
    });

    it("src/auth/ (dir) overlaps src/auth/login.ts (dir expands to src/auth/**)", () => {
      expect(globsOverlap(["src/auth/"], ["src/auth/login.ts"])).toBe(true);
    });

    it("src/Login.ts overlaps src/login.ts (case-insensitive)", () => {
      expect(globsOverlap(["src/Login.ts"], ["src/login.ts"])).toBe(true);
    });

    it("any-pair: [src/payments/**, src/auth/x.ts] overlaps [src/auth/**]", () => {
      expect(
        globsOverlap(["src/payments/**", "src/auth/x.ts"], ["src/auth/**"]),
      ).toBe(true);
    });

    // Error path: empty arrays must not throw and return false
    it("empty A array -> false, no throw", () => {
      expect(() => globsOverlap([], ["src/auth/**"])).not.toThrow();
      expect(globsOverlap([], ["src/auth/**"])).toBe(false);
    });

    it("empty B array -> false, no throw", () => {
      expect(globsOverlap(["src/auth/**"], [])).toBe(false);
    });

    it("both empty arrays -> false, no throw", () => {
      expect(globsOverlap([], [])).toBe(false);
    });

    // Documented known over-report (acceptable recall-favoring behavior).
    // `src/*.ts` vs `src/auth.js`: head segments `src`==`src` compatible, then
    // `*.ts` (wildcard) vs `auth.js` -> conservatively compatible, so reports true
    // even though `*.ts` would never actually match a `.js` file. ACCEPTABLE:
    // v1 favors recall; a later precision pass (picomatch) could rule this out.
    it("KNOWN OVER-REPORT (acceptable): src/*.ts vs src/auth.js -> true", () => {
      expect(globsOverlap(["src/*.ts"], ["src/auth.js"])).toBe(true);
    });

    // Non-overlap sanity at the file level
    it("src/auth/login.ts does NOT overlap src/auth/logout.ts", () => {
      expect(globsOverlap(["src/auth/login.ts"], ["src/auth/logout.ts"])).toBe(
        false,
      );
    });
  });
});
