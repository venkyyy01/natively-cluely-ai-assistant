/**
 * Frontend Feature Flags
 *
 * This repository variant runs as a fully unlocked open build.
 * Keep premium-oriented UI capability enabled, but suppress upgrade/paywall
 * surfaces elsewhere so the app behaves like a single unrestricted product.
 */

export const FEATURES = {
  /** Set to false to completely hide premium UI elements */
  PREMIUM_ENABLED: true,
} as const;
