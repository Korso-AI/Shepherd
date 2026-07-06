import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import type { ShepherdClient } from "../src/client.js";
import {
  ShepherdClientProvider,
  useShepherdClient,
} from "../src/context.js";

/**
 * A stub standing in for a real client. Both methods reject because the tests
 * never invoke them — they only assert that the EXACT instance flows through
 * the provider to the hook. Casting a minimal object keeps the test off the
 * network and proves the context carries identity, not a copy.
 */
const stubClient = {
  getLandscape: () => Promise.reject(new Error("not called")),
  announce: () => Promise.reject(new Error("not called")),
} as unknown as ShepherdClient;

/**
 * A consumer that proves identity: it shows "same" only when the hook returns
 * the very instance the provider was given. A copied/wrapped value would fail
 * this reference check, so the assertion guards against accidental indirection.
 */
function IdentityConsumer({ expected }: { expected: ShepherdClient }) {
  const client = useShepherdClient();
  return <p>{client === expected ? "same" : "different"}</p>;
}

/** A consumer rendered with NO provider, to exercise the thrown-error path. */
function BareConsumer() {
  useShepherdClient();
  return <p>unreachable</p>;
}

describe("ShepherdClientProvider / useShepherdClient", () => {
  it("hands the EXACT client instance to a consuming child", () => {
    render(
      <ShepherdClientProvider client={stubClient}>
        <IdentityConsumer expected={stubClient} />
      </ShepherdClientProvider>,
    );
    expect(screen.getByText("same")).toBeInTheDocument();
  });

  it("throws a named error when used outside a provider", () => {
    expect(() => render(<BareConsumer />)).toThrow(
      /within <ShepherdClientProvider>/,
    );
  });
});
