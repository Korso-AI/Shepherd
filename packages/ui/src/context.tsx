import { createContext, useContext } from "react";
import type { ReactNode } from "react";
import type { ShepherdClient } from "./client.js";

/**
 * Holds the active {@link ShepherdClient}, or `null` when no provider is above
 * a consumer. The nullable default lets {@link useShepherdClient} distinguish
 * "no provider" from a legitimately-provided client and fail loudly rather than
 * handing back a silent stand-in.
 */
const ShepherdClientContext = createContext<ShepherdClient | null>(null);

/** Props for {@link ShepherdClientProvider}. */
export interface ShepherdClientProviderProps {
  /** The client made available to every descendant via the context. */
  client: ShepherdClient;
  /** The subtree that may read the client through {@link useShepherdClient}. */
  children: ReactNode;
}

/**
 * Supplies a {@link ShepherdClient} to the React subtree. This is the seam that
 * keeps the dashboard auth-agnostic: the host constructs a client (wiring in
 * whatever auth it uses) and injects it here, so components below only ever see
 * the auth-neutral client interface — never tokens or transport details.
 *
 * @param props - The client to provide and the children that consume it.
 * @returns A provider element wrapping `children`.
 */
export function ShepherdClientProvider({
  client,
  children,
}: ShepherdClientProviderProps): ReactNode {
  return (
    <ShepherdClientContext.Provider value={client}>
      {children}
    </ShepherdClientContext.Provider>
  );
}

/**
 * Reads the {@link ShepherdClient} from context. Throws when called outside a
 * {@link ShepherdClientProvider} so a missing provider surfaces as an immediate,
 * named error at render time instead of a confusing null-dereference later.
 *
 * @returns The client supplied by the nearest provider.
 * @throws Error When invoked with no {@link ShepherdClientProvider} ancestor.
 */
export function useShepherdClient(): ShepherdClient {
  const client = useContext(ShepherdClientContext);
  if (client === null) {
    throw new Error(
      "useShepherdClient must be used within <ShepherdClientProvider>",
    );
  }
  return client;
}
