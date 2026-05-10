import { Injectable, inject } from '@angular/core';
import { Meta } from '@angular/platform-browser';
import type { JsonBlob } from '../api/models';

/**
 * Centralizes `<meta>` tag management for per-route SEO / social concerns.
 *
 * Note: JotJSON is a client-rendered SPA, so tags set here are only honored by
 * crawlers that execute JavaScript (e.g. LinkedIn, Slack unfurl partially).
 * Universal support requires pre-rendering, which is tracked as milestone M7h.
 */
@Injectable({ providedIn: 'root' })
export class SeoService {
  private readonly meta = inject(Meta);

  private static readonly OG_TAGS = [
    'og:title',
    'og:description',
    'og:type',
    'og:url',
    'og:site_name',
  ] as const;

  private static readonly TWITTER_TAGS = ['twitter:card'] as const;

  /** Set Open Graph tags for a publicly-shared blob. Removes any prior noindex. */
  setOpenGraphForBlob(blob: JsonBlob): void {
    this.setNoindex(false);
    const title = (blob.title ?? '').trim();
    const displayTitle = title.length > 0 ? title : 'Untitled JSON';
    const description =
      title.length > 0 ? `${title} - JSON shared on JotJSON` : 'JSON shared on JotJSON';

    this.upsert('og:title', displayTitle);
    this.upsert('og:description', description);
    this.upsert('og:type', 'website');
    this.upsert('og:url', this.currentUrl());
    this.upsert('og:site_name', 'JotJSON');
    this.upsert('twitter:card', 'summary', { nameAttr: true });
  }

  /** Toggle the robots=noindex tag. */
  setNoindex(on: boolean): void {
    if (on) {
      this.upsert('robots', 'noindex', { nameAttr: true });
    } else {
      this.meta.removeTag('name="robots"');
    }
  }

  /** Remove every per-blob tag we might have emitted. Safe to call repeatedly. */
  clearBlobTags(): void {
    for (const property of SeoService.OG_TAGS) {
      this.meta.removeTag(`property="${property}"`);
    }
    for (const name of SeoService.TWITTER_TAGS) {
      this.meta.removeTag(`name="${name}"`);
    }
    this.setNoindex(false);
  }

  private upsert(key: string, content: string, opts: { nameAttr?: boolean } = {}): void {
    const selector = opts.nameAttr ? `name="${key}"` : `property="${key}"`;
    const definition: Record<string, string> = opts.nameAttr
      ? { name: key, content }
      : { property: key, content };
    if (this.meta.getTag(selector)) {
      this.meta.updateTag(definition, selector);
    } else {
      this.meta.addTag(definition);
    }
  }

  private currentUrl(): string {
    if (typeof window === 'undefined') return 'https://jotjson.com/';
    return window.location.href;
  }
}
