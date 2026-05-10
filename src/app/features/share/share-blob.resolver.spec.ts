import { TestBed } from '@angular/core/testing';
import {
  Router,
  convertToParamMap,
  type ActivatedRouteSnapshot,
  type RouterStateSnapshot,
} from '@angular/router';
import { Observable, firstValueFrom, isObservable, throwError } from 'rxjs';
import { provideFakeAuth } from '../../../testing/auth.testing';
import { BlobService, type BlobFetchEvent } from '../../core/api/blob.service';
import type { JsonBlob } from '../../core/api/models';
import { LoadingSplashService } from '../../core/loading-splash/loading-splash.service';
import { LoggerService } from '../../core/telemetry/logger.service';
import { shareBlobResolver } from './share-blob.resolver';

function runResolver(slug: string): Promise<JsonBlob | null> {
  const route = {
    paramMap: convertToParamMap({ slug }),
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
      version: 1,
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
      ...overrides,
    };
  }

  let getWithProgressSpy: jasmine.Spy<(slug: string) => Observable<BlobFetchEvent>>;
  let navSpy: jasmine.Spy;
  let reportProgressSpy: jasmine.Spy;
  let markBytesCompleteSpy: jasmine.Spy;
  let eventSpy: jasmine.Spy;

  function makeStream(...events: BlobFetchEvent[]): Observable<BlobFetchEvent> {
    return new Observable<BlobFetchEvent>((subscriber) => {
      for (const event of events) subscriber.next(event);
      subscriber.complete();
    });
  }

  beforeEach(() => {
    getWithProgressSpy = jasmine
      .createSpy<(slug: string) => Observable<BlobFetchEvent>>('getWithProgress')
      .and.returnValue(makeStream({ kind: 'bytesComplete' }, { kind: 'blob', blob: blob() }));
    reportProgressSpy = jasmine.createSpy('reportBlobProgress');
    markBytesCompleteSpy = jasmine.createSpy('markBlobBytesComplete');
    eventSpy = jasmine.createSpy('event');
    TestBed.configureTestingModule({
      providers: [
        ...provideFakeAuth(),
        { provide: BlobService, useValue: { getWithProgress: getWithProgressSpy } },
        {
          provide: LoadingSplashService,
          useValue: {
            reportBlobProgress: reportProgressSpy,
            markBlobBytesComplete: markBytesCompleteSpy,
          },
        },
        { provide: LoggerService, useValue: { event: eventSpy } },
      ],
    });
    navSpy = spyOn(TestBed.inject(Router), 'navigate').and.resolveTo(true);
  });

  it('returns the fetched blob on success', async () => {
    const result = await runResolver('abc123');
    expect(getWithProgressSpy).toHaveBeenCalledWith('abc123');
    expect(result).toEqual(blob());
    expect(navSpy).not.toHaveBeenCalled();
  });

  it('calls splash.markBlobBytesComplete on the bytesComplete event', async () => {
    getWithProgressSpy.and.returnValue(
      makeStream(
        { kind: 'progress', loaded: 256, total: 1024 },
        { kind: 'bytesComplete' },
        { kind: 'blob', blob: blob() },
      ),
    );
    await runResolver('abc123');
    expect(markBytesCompleteSpy).toHaveBeenCalledTimes(1);
    // The bytesComplete trigger fires AFTER the last progress event
    // and BEFORE the terminal blob event - this is the entire point
    // of the v0.10.7 fix.
    expect(reportProgressSpy.calls.count()).toBeGreaterThan(0);
    const lastReportCall = reportProgressSpy.calls.mostRecent();
    expect(lastReportCall.args).toEqual([1024, 1024]);
  });

  it('navigates to /404 with attemptedSlug and returns null on error', async () => {
    getWithProgressSpy.and.returnValue(throwError(() => ({ status: 404 })));
    const result = await runResolver('missing');
    expect(result).toBeNull();
    expect(navSpy).toHaveBeenCalledWith(['/404'], {
      replaceUrl: true,
      state: { attemptedSlug: 'missing' },
    });
    expect(markBytesCompleteSpy).not.toHaveBeenCalled();
  });

  it('navigates to /404 (no state) and returns null when slug is empty', async () => {
    const route = {
      paramMap: convertToParamMap({}),
    } as unknown as ActivatedRouteSnapshot;
    const state = {} as RouterStateSnapshot;
    const out = TestBed.runInInjectionContext(() => shareBlobResolver(route, state));
    const result = isObservable(out)
      ? ((await firstValueFrom(out)) as JsonBlob | null)
      : ((await Promise.resolve(out)) as JsonBlob | null);
    expect(result).toBeNull();
    expect(navSpy).toHaveBeenCalledWith(['/404'], {
      replaceUrl: true,
      state: undefined,
    });
    expect(getWithProgressSpy).not.toHaveBeenCalled();
  });

  it('forwards progress events into LoadingSplashService.reportBlobProgress', async () => {
    getWithProgressSpy.and.returnValue(
      makeStream(
        { kind: 'progress', loaded: 256, total: 1024 },
        { kind: 'progress', loaded: 768, total: 1024 },
        { kind: 'bytesComplete' },
        { kind: 'blob', blob: blob() },
      ),
    );
    await runResolver('abc123');
    const calls = reportProgressSpy.calls.allArgs();
    // Three calls: two from progress events + one defensive snap-to-1.0
    // on the terminal blob event (kept in case bytesComplete somehow
    // didn't fire).
    expect(calls.length).toBe(3);
    expect(calls[0]).toEqual([256, 1024]);
    expect(calls[1]).toEqual([768, 1024]);
    expect(calls[2])
      .withContext('defensive snap-to-1.0 on terminal event remains for the no-bytesComplete case')
      .toEqual([1024, 1024]);
  });

  it('does not snap when no determinate total was ever observed', async () => {
    getWithProgressSpy.and.returnValue(
      makeStream(
        { kind: 'progress', loaded: 256, total: null },
        { kind: 'bytesComplete' },
        { kind: 'blob', blob: blob() },
      ),
    );
    await runResolver('abc123');
    expect(reportProgressSpy.calls.allArgs()).toEqual([[256, null]]);
  });

  it('emits blob.fetch.complete with determinateProgress=true when a total was observed', async () => {
    getWithProgressSpy.and.returnValue(
      makeStream(
        { kind: 'progress', loaded: 100, total: 1000 },
        { kind: 'bytesComplete' },
        { kind: 'blob', blob: blob() },
      ),
    );
    await runResolver('abc123');
    expect(eventSpy).toHaveBeenCalledWith('blob.fetch.complete', { determinateProgress: true });
  });

  it('emits blob.fetch.complete with determinateProgress=false when no total was observed', async () => {
    getWithProgressSpy.and.returnValue(
      makeStream(
        { kind: 'progress', loaded: 100, total: null },
        { kind: 'bytesComplete' },
        { kind: 'blob', blob: blob() },
      ),
    );
    await runResolver('abc123');
    expect(eventSpy).toHaveBeenCalledWith('blob.fetch.complete', { determinateProgress: false });
  });

  it('emits blob.fetch.complete only on success, not on error', async () => {
    getWithProgressSpy.and.returnValue(throwError(() => ({ status: 404 })));
    await runResolver('missing');
    expect(eventSpy).not.toHaveBeenCalled();
  });
});
