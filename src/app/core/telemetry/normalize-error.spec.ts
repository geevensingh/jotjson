import { HttpErrorResponse } from '@angular/common/http';
import { normalizeError, sanitizePath } from './normalize-error';

describe('sanitizePath', () => {
  it('returns undefined for empty input', () => {
    expect(sanitizePath('')).toBeUndefined();
    expect(sanitizePath(null)).toBeUndefined();
  });

  it('strips query strings', () => {
    expect(sanitizePath('/api/history?q=secret&from=2024')).toBe('/api/history');
  });

  it('strips fragments', () => {
    expect(sanitizePath('/blobs#section')).toBe('/blobs');
  });

  it('strips both query and fragment', () => {
    expect(sanitizePath('/x?a=1#frag')).toBe('/x');
  });

  it('returns plain paths unchanged', () => {
    expect(sanitizePath('/api/blobs/abc123')).toBe('/api/blobs/abc123');
  });
});

describe('normalizeError', () => {
  it('normalizes HttpErrorResponse without leaking message or body', () => {
    const err = new HttpErrorResponse({
      url: '/api/history?q=secret&continuationToken=xyz',
      status: 500,
      statusText: 'Internal Server Error',
      error: { code: 'cosmos.unavailable', detail: 'sensitive data' }
    });
    const out = normalizeError(err, { method: 'GET' });
    expect(out.kind).toBe('http');
    if (out.kind === 'http') {
      expect(out.status).toBe(500);
      expect(out.statusText).toBe('Internal Server Error');
      expect(out.method).toBe('GET');
      expect(out.pathTemplate).toBe('/api/history');
      expect(out.backendCode).toBe('cosmos.unavailable');
    }
    // Verify no leakage by re-stringifying
    const json = JSON.stringify(out);
    expect(json).not.toContain('secret');
    expect(json).not.toContain('continuationToken');
    expect(json).not.toContain('sensitive data');
  });

  it('prefers ctx.pathTemplate over the raw URL', () => {
    const err = new HttpErrorResponse({
      url: '/api/blobs/abc?x=1',
      status: 404
    });
    const out = normalizeError(err, { method: 'GET', pathTemplate: '/api/blobs/:slug' });
    expect(out.kind).toBe('http');
    if (out.kind === 'http') {
      expect(out.pathTemplate).toBe('/api/blobs/:slug');
    }
  });

  it('omits backendCode when body has no string code', () => {
    const err = new HttpErrorResponse({ url: '/api/x', status: 400, error: 'plain text' });
    const out = normalizeError(err);
    if (out.kind === 'http') {
      expect(out.backendCode).toBeUndefined();
    }
  });

  it('normalizes plain Error - redacted, truncated', () => {
    const e = new Error('failed for alice@x.io');
    const out = normalizeError(e);
    expect(out.kind).toBe('error');
    if (out.kind === 'error') {
      expect(out.name).toBe('Error');
      expect(out.message).toBe('failed for <email>');
      expect(out.stack).toBeDefined();
    }
  });

  it('redacts PII in stack frames', () => {
    const e = new Error('boom');
    e.stack = 'Error: boom\n  at user@x.io:1:1';
    const out = normalizeError(e);
    if (out.kind === 'error') {
      expect(out.stack).toContain('<email>');
      expect(out.stack).not.toContain('user@x.io');
    }
  });

  it('truncates very long messages', () => {
    const long = 'x'.repeat(2000);
    const out = normalizeError(new Error(long));
    if (out.kind === 'error') {
      expect(out.message.length).toBeLessThanOrEqual(500);
    }
  });

  it('handles non-Error throws', () => {
    const out = normalizeError({ random: 'object' });
    expect(out.kind).toBe('unknown');
    if (out.kind === 'unknown') {
      expect(out.repr).toContain('non-error thrown');
    }
  });

  it('preserves string throws (after redaction/truncate)', () => {
    const out = normalizeError('panic at the disco bob@x.io');
    expect(out.kind).toBe('unknown');
    if (out.kind === 'unknown') {
      expect(out.repr).toContain('<email>');
    }
  });
});
