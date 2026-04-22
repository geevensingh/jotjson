import { TestBed } from '@angular/core/testing';
import { Router, convertToParamMap, type ActivatedRouteSnapshot, type RouterStateSnapshot } from '@angular/router';
import { of, throwError, firstValueFrom, from, isObservable } from 'rxjs';
import { provideFakeAuth } from '../../../testing/auth.testing';
import { BlobService } from '../../core/api/blob.service';
import type { JsonBlob } from '../../core/api/models';
import { shareBlobResolver } from './share-blob.resolver';

function runResolver(slug: string): Promise<JsonBlob | null> {
  const route = {
    paramMap: convertToParamMap({ slug })
  } as unknown as ActivatedRouteSnapshot;
  const state = {} as RouterStateSnapshot;
  const out = TestBed.runInInjectionContext(() => shareBlobResolver(route, state));
  if (isObservable(out)) return firstValueFrom(out) as Promise<JsonBlob | null>;
  if (out instanceof Promise) return out as Promise<JsonBlob | null>;
  return Promise.resolve(out as JsonBlob | null);
}

describe('shareBlobResolver', () => {
  function blob(overrides: Partial<JsonBlob> = {}): JsonBlob {
    return {
      id: 'id-1',
      slug: 'abc123',
      content: '{"a":1}',
      ownerId: 'owner',
      isPublic: false,
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
      ...overrides
    };
  }

  let getSpy: jasmine.Spy;
  let navSpy: jasmine.Spy;

  beforeEach(() => {
    getSpy = jasmine.createSpy('get').and.returnValue(of(blob()));
    TestBed.configureTestingModule({
      providers: [
        ...provideFakeAuth(),
        { provide: BlobService, useValue: { get: getSpy } }
      ]
    });
    navSpy = spyOn(TestBed.inject(Router), 'navigate').and.resolveTo(true);
  });

  it('returns the fetched blob on success', async () => {
    const result = await runResolver('abc123');
    expect(getSpy).toHaveBeenCalledWith('abc123');
    expect(result).toEqual(blob());
    expect(navSpy).not.toHaveBeenCalled();
  });

  it('redirects to / and returns null on error', async () => {
    getSpy.and.returnValue(throwError(() => ({ status: 404 })));
    const result = await runResolver('missing');
    expect(result).toBeNull();
    expect(navSpy).toHaveBeenCalledWith(['/']);
  });

  it('redirects to / and returns null when slug is empty', async () => {
    const route = {
      paramMap: convertToParamMap({})
    } as unknown as ActivatedRouteSnapshot;
    const state = {} as RouterStateSnapshot;
    const out = TestBed.runInInjectionContext(() =>
      shareBlobResolver(route, state)
    );
    const result = isObservable(out)
      ? ((await firstValueFrom(out)) as JsonBlob | null)
      : ((await Promise.resolve(out)) as JsonBlob | null);
    expect(result).toBeNull();
    expect(navSpy).toHaveBeenCalledWith(['/']);
    expect(getSpy).not.toHaveBeenCalled();
  });
});

// Suppress unused-import warnings for `from` (kept so helpers can be extended
// without another import churn).
void from;
