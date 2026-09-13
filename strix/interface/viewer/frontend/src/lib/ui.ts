// Small set of shared style tokens for the rewritten viewer UI. Not a design
// system, just enough shared constants to keep spacing/color/hierarchy
// consistent across the rewrite instead of repeating literal Tailwind
// strings in every file. Presentation-only; safe to change freely.

/** Standard card surface: one border weight, one fill, used everywhere. */
export const card = "rounded-2xl border border-white/10 bg-white/[0.03]";
/** Card internal padding, mobile-first. */
export const cardPad = "p-4 sm:p-5";
/** Muted body text. */
export const muted = "text-white/50";
/** Faint / tertiary text (timestamps, hints). */
export const faint = "text-white/35";
/** Primary (white pill) action button. */
export const primaryBtn =
  "inline-flex items-center justify-center gap-2 rounded-lg bg-white px-4 py-2.5 text-sm font-semibold text-black transition-opacity hover:opacity-90 disabled:opacity-60 cursor-pointer";
/** Secondary (outlined) action button. */
export const secondaryBtn =
  "inline-flex items-center justify-center gap-2 rounded-lg border border-white/15 px-4 py-2.5 text-sm font-medium text-white/80 transition-colors hover:border-white/30 hover:text-white cursor-pointer";
/** Minimum comfortable touch target for mobile controls. */
export const touchTarget = "min-h-[44px]";
