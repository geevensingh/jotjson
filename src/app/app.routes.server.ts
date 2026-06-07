import { RenderMode, ServerRoute } from '@angular/ssr';

/**
 * Per-route rendering mode for static prerender. Only `/` and `/404`
 * are prerendered to disk; every other route uses
 * `RenderMode.Client`, which means the build does not invoke the
 * prerender pipeline for them and the runtime serves the static
 * shell (`shell.html`) instead.
 *
 * Auth-gated routes (`/blobs`, `/history`, `/profile`,
 * `/formatting-rules`, `/formatting-rules/:id`) are deliberately
 * client-only because their `authGuard` would synthesize a
 * soft-redirect at build time (no user, so the guard rejects). A
 * shell boot is the right behavior there - the guard fires on the
 * client with the actual auth state.
 *
 * `/s/:slug` is parameterized over an unbounded slug space and is
 * not prerendered. Crawler defense for `/s/:slug` lands in v1.3.0 via
 * three layers (client-side `<meta name="robots" content="noindex">`,
 * `X-Robots-Tag: noindex` HTTP header from `staticwebapp.config.json`,
 * and `Disallow: /s/` in `robots.txt`); per-blob Open Graph is
 * intentionally not emitted (DESIGN_SPEC.md SEO section).
 */
export const serverRoutes: ServerRoute[] = [
  { path: '', renderMode: RenderMode.Prerender },
  { path: '404', renderMode: RenderMode.Prerender },
  { path: '**', renderMode: RenderMode.Client },
];
