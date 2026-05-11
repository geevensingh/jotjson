import { TestBed } from '@angular/core/testing';
import { Meta } from '@angular/platform-browser';
import type { JsonBlob } from '../api/models';
import { SeoService } from './seo.service';

function blob(overrides: Partial<JsonBlob> = {}): JsonBlob {
  return {
    id: 'b1',
    slug: 'abc123',
    content: '{"a":1}',
    ownerId: 'u1',
    isPublic: true,
    version: 1,
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('SeoService', () => {
  let svc: SeoService;
  let meta: Meta;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    svc = TestBed.inject(SeoService);
    meta = TestBed.inject(Meta);
  });

  afterEach(() => {
    for (const sel of [
      'property="og:title"',
      'property="og:description"',
      'property="og:type"',
      'property="og:url"',
      'property="og:site_name"',
      'name="twitter:card"',
      'name="robots"',
    ]) {
      meta.removeTag(sel);
    }
  });

  describe('setOpenGraphForBlob', () => {
    it('emits og:* and twitter:card tags with title', () => {
      svc.setOpenGraphForBlob(blob({ title: 'My config' }));
      expect(meta.getTag('property="og:title"')?.content).toBe('My config');
      expect(meta.getTag('property="og:description"')?.content).toBe(
        'My config - JSON shared on JotJSON',
      );
      expect(meta.getTag('property="og:type"')?.content).toBe('website');
      expect(meta.getTag('property="og:site_name"')?.content).toBe('JotJSON');
      expect(meta.getTag('property="og:url"')?.content).toContain('http');
      expect(meta.getTag('name="twitter:card"')?.content).toBe('summary');
    });

    it('falls back to "Untitled JSON" when title is missing/blank', () => {
      svc.setOpenGraphForBlob(blob({ title: '   ' }));
      expect(meta.getTag('property="og:title"')?.content).toBe('Untitled JSON');
      expect(meta.getTag('property="og:description"')?.content).toBe('JSON shared on JotJSON');
    });

    it('is idempotent - repeat calls update rather than duplicate', () => {
      svc.setOpenGraphForBlob(blob({ title: 'One' }));
      svc.setOpenGraphForBlob(blob({ title: 'Two' }));
      const all = meta.getTags('property="og:title"');
      expect(all.length).toBe(1);
      expect(all[0].content).toBe('Two');
    });

    it('clears any prior noindex when switching to a public blob', () => {
      svc.setNoindex(true);
      svc.setOpenGraphForBlob(blob({ title: 'Public' }));
      expect(meta.getTag('name="robots"')).toBeNull();
    });
  });

  describe('setNoindex', () => {
    it('adds robots=noindex when on', () => {
      svc.setNoindex(true);
      expect(meta.getTag('name="robots"')?.content).toBe('noindex');
    });

    it('removes the tag when off', () => {
      svc.setNoindex(true);
      svc.setNoindex(false);
      expect(meta.getTag('name="robots"')).toBeNull();
    });

    it('is idempotent on repeat on() calls', () => {
      svc.setNoindex(true);
      svc.setNoindex(true);
      expect(meta.getTags('name="robots"').length).toBe(1);
    });
  });

  describe('clearBlobTags', () => {
    it('removes every og:*, twitter:card, and robots tag', () => {
      svc.setOpenGraphForBlob(blob({ title: 'Cleanup' }));
      svc.setNoindex(true);
      svc.clearBlobTags();
      expect(meta.getTag('property="og:title"')).toBeNull();
      expect(meta.getTag('property="og:description"')).toBeNull();
      expect(meta.getTag('property="og:url"')).toBeNull();
      expect(meta.getTag('name="twitter:card"')).toBeNull();
      expect(meta.getTag('name="robots"')).toBeNull();
    });
  });
});
