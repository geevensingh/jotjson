import { TestBed } from '@angular/core/testing';
import { Meta } from '@angular/platform-browser';
import { SeoService } from './seo.service';

describe('SeoService', () => {
  let svc: SeoService;
  let meta: Meta;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    svc = TestBed.inject(SeoService);
    meta = TestBed.inject(Meta);
  });

  afterEach(() => {
    meta.removeTag('name="robots"');
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

    it('is idempotent on repeat off() calls', () => {
      svc.setNoindex(false);
      svc.setNoindex(false);
      expect(meta.getTag('name="robots"')).toBeNull();
    });

    it('toggles cleanly between on and off', () => {
      svc.setNoindex(true);
      svc.setNoindex(false);
      svc.setNoindex(true);
      expect(meta.getTag('name="robots"')?.content).toBe('noindex');
      expect(meta.getTags('name="robots"').length).toBe(1);
    });
  });
});
