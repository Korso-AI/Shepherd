/**
 * Client context silently attached to feedback submissions — route, library
 * version, user agent, viewport. Everything comes from browser globals and is
 * length-capped to match FeedbackContext's schema caps; in a windowless
 * environment (SSR) it degrades to undefined and feedback simply sends none.
 */

import type { FeedbackContextT } from "@shepherd/shared";
import { SHEPHERD_UI_VERSION } from "./version.js";

export function buildFeedbackContext(): FeedbackContextT | undefined {
  if (typeof window === "undefined") return undefined;
  return {
    route: (window.location.pathname + window.location.hash).slice(0, 256),
    appVersion: SHEPHERD_UI_VERSION,
    userAgent: navigator.userAgent.slice(0, 512),
    viewport: `${window.innerWidth}x${window.innerHeight}`,
  };
}
