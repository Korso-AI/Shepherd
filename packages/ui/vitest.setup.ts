// Registers @testing-library/jest-dom's custom matchers (e.g. toBeInTheDocument)
// onto Vitest's `expect`. The `/vitest` entry wires them via Vitest's expect
// extension — NOT the jest `extend-expect` path, which targets Jest's globals.
import "@testing-library/jest-dom/vitest";
