import { Injectable, inject } from '@angular/core';
import { Meta } from '@angular/platform-browser';

/**
 * Centralizes the `<meta name="robots">` noindex toggle.
 *
 * Post-1.1.0 surface: only the robots noindex toggle. Per-blob Open Graph
 * and Twitter tags were retired alongside the `isPublic` blob visibility
 * flag - all blobs are unlisted and every `/s/:slug` page emits
 * `<meta name="robots" content="noindex">` always-on. The static homepage
 * OG defaults from `src/index.html` survive into the prerendered
 * `index.html` without any client-side per-blob OG emission.
 */
@Injectable({ providedIn: 'root' })
export class SeoService {
  private readonly meta = inject(Meta);

  /** Toggle the `robots=noindex` meta tag. */
  setNoindex(on: boolean): void {
    if (on) {
      const selector = 'name="robots"';
      const definition = { name: 'robots', content: 'noindex' };
      if (this.meta.getTag(selector)) {
        this.meta.updateTag(definition, selector);
      } else {
        this.meta.addTag(definition);
      }
    } else {
      this.meta.removeTag('name="robots"');
    }
  }
}
