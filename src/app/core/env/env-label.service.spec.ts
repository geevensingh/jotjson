import { PLATFORM_ID } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { EnvLabelService } from './env-label.service';

describe('EnvLabelService', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('returns "prod" on the server platform without touching window', () => {
    TestBed.configureTestingModule({
      providers: [{ provide: PLATFORM_ID, useValue: 'server' }],
    });
    const service = TestBed.inject(EnvLabelService);
    expect(service.label).toBe('prod');
    expect(service.prNumber).toBeNull();
    expect(service.withPrefix('Blobs - JotJSON')).toBe('Blobs - JotJSON');
  });

  it('classifies the Karma test host ("localhost") as "dev" in the browser platform', () => {
    TestBed.configureTestingModule({});
    const service = TestBed.inject(EnvLabelService);
    expect(service.label).toBe('dev');
    // Karma serves on localhost; not a preview host -> no PR number.
    expect(service.prNumber).toBeNull();
  });

  it('withPrefix is identity on prod', () => {
    TestBed.configureTestingModule({
      providers: [{ provide: PLATFORM_ID, useValue: 'server' }],
    });
    const service = TestBed.inject(EnvLabelService);
    expect(service.withPrefix('JotJSON')).toBe('JotJSON');
  });

  it('withPrefix prepends localized prefix when not on prod', () => {
    TestBed.configureTestingModule({});
    const service = TestBed.inject(EnvLabelService);
    expect(service.withPrefix('Blobs - JotJSON')).toBe('[dev] Blobs - JotJSON');
  });
});
