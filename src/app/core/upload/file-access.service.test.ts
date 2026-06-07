import { PLATFORM_ID } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { type Mock } from 'vitest';
import {
  FileAccessError,
  FileAccessService,
  type FileAccessFailureCause,
} from './file-access.service';

type WritableMock = {
  write: Mock;
  close: Mock;
  abort: Mock;
};

function makeWritable(overrides: Partial<WritableMock> = {}): WritableMock {
  return {
    write: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    abort: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

interface FakeHandleOptions {
  readonly name?: string;
  readonly file?: File;
  readonly queriedPermission?: PermissionState;
  readonly requestedPermission?: PermissionState;
  readonly writable?: WritableMock;
  readonly createWritableError?: unknown;
  readonly getFileError?: unknown;
}

function makeFakeHandle(options: FakeHandleOptions = {}): {
  handle: FileSystemFileHandle;
  query: Mock;
  request: Mock;
  createWritable: Mock;
  getFile: Mock;
  writable: WritableMock;
} {
  const file =
    options.file ??
    new File(['{"k":1}'], options.name ?? 'data.json', { type: 'application/json' });
  const writable = options.writable ?? makeWritable();
  const query = vi.fn().mockResolvedValue(options.queriedPermission ?? 'granted');
  const request = vi.fn().mockResolvedValue(options.requestedPermission ?? 'granted');
  const createWritable = options.createWritableError
    ? vi.fn().mockRejectedValue(options.createWritableError)
    : vi.fn().mockResolvedValue(writable);
  const getFile = options.getFileError
    ? vi.fn().mockRejectedValue(options.getFileError)
    : vi.fn().mockResolvedValue(file);
  const handle = {
    kind: 'file' as const,
    name: options.name ?? 'data.json',
    queryPermission: query,
    requestPermission: request,
    createWritable,
    getFile,
  } as unknown as FileSystemFileHandle;
  return { handle, query, request, createWritable, getFile, writable };
}

function installPickerStubs(
  options: {
    openHandle?: FileSystemFileHandle | 'unsupported';
    openError?: unknown;
    saveHandle?: FileSystemFileHandle | 'unsupported';
    saveError?: unknown;
  } = {},
): { openPicker: Mock | undefined; savePicker: Mock | undefined } {
  let openPicker: Mock | undefined;
  let savePicker: Mock | undefined;
  if (options.openHandle === 'unsupported') {
    Object.defineProperty(window, 'showOpenFilePicker', {
      configurable: true,
      value: undefined,
    });
  } else {
    openPicker = options.openError
      ? vi.fn().mockRejectedValue(options.openError)
      : vi.fn().mockResolvedValue(options.openHandle ? [options.openHandle] : []);
    Object.defineProperty(window, 'showOpenFilePicker', { configurable: true, value: openPicker });
  }
  if (options.saveHandle === 'unsupported') {
    Object.defineProperty(window, 'showSaveFilePicker', {
      configurable: true,
      value: undefined,
    });
  } else {
    savePicker = options.saveError
      ? vi.fn().mockRejectedValue(options.saveError)
      : vi.fn().mockResolvedValue(options.saveHandle);
    Object.defineProperty(window, 'showSaveFilePicker', { configurable: true, value: savePicker });
  }
  return { openPicker, savePicker };
}

function setupBrowser(): FileAccessService {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [FileAccessService, { provide: PLATFORM_ID, useValue: 'browser' }],
  });
  return TestBed.inject(FileAccessService);
}

function setupServer(): FileAccessService {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [FileAccessService, { provide: PLATFORM_ID, useValue: 'server' }],
  });
  return TestBed.inject(FileAccessService);
}

afterEach(() => {
  Object.defineProperty(window, 'showOpenFilePicker', { configurable: true, value: undefined });
  Object.defineProperty(window, 'showSaveFilePicker', { configurable: true, value: undefined });
});

describe('FileAccessService', () => {
  describe('hasFileSystemAccess', () => {
    it('returns false on the server platform', () => {
      installPickerStubs({
        openHandle: makeFakeHandle().handle,
        saveHandle: makeFakeHandle().handle,
      });
      const service = setupServer();
      expect(service.hasFileSystemAccess()).toBe(false);
    });

    it('returns false on the browser when showOpenFilePicker is undefined', () => {
      installPickerStubs({ openHandle: 'unsupported', saveHandle: makeFakeHandle().handle });
      const service = setupBrowser();
      expect(service.hasFileSystemAccess()).toBe(false);
    });

    it('returns false on the browser when showSaveFilePicker is undefined', () => {
      installPickerStubs({ openHandle: makeFakeHandle().handle, saveHandle: 'unsupported' });
      const service = setupBrowser();
      expect(service.hasFileSystemAccess()).toBe(false);
    });

    it('returns true on the browser when both pickers are defined', () => {
      installPickerStubs({
        openHandle: makeFakeHandle().handle,
        saveHandle: makeFakeHandle().handle,
      });
      const service = setupBrowser();
      expect(service.hasFileSystemAccess()).toBe(true);
    });
  });

  describe('PLATFORM_ID server-platform invariant', () => {
    it('constructs without touching any browser globals', () => {
      installPickerStubs({ openHandle: 'unsupported', saveHandle: 'unsupported' });
      expect(() => setupServer()).not.toThrow();
    });
  });

  describe('openLocalFile', () => {
    it('throws unsupportedBrowser when the picker is undefined', async () => {
      installPickerStubs({ openHandle: 'unsupported', saveHandle: 'unsupported' });
      const service = setupBrowser();
      await expectFailureCause(() => service.openLocalFile(), 'unsupportedBrowser');
    });

    it('resolves null when the user cancels the picker (AbortError)', async () => {
      const abort = new DOMException('aborted', 'AbortError');
      installPickerStubs({ openError: abort });
      const service = setupBrowser();
      const result = await service.openLocalFile();
      expect(result).toBeNull();
    });

    it('resolves null when the picker returns an empty handle list', async () => {
      const { openPicker } = installPickerStubs({});
      // openHandle omitted; default mock returns [] for an empty list.
      openPicker!.mockResolvedValueOnce([]);
      const service = setupBrowser();
      const result = await service.openLocalFile();
      expect(result).toBeNull();
    });

    it('resolves with file + handle on a successful pick and proactively requests readwrite', async () => {
      const fake = makeFakeHandle();
      installPickerStubs({ openHandle: fake.handle });
      const service = setupBrowser();

      const result = await service.openLocalFile();

      expect(result).not.toBeNull();
      expect(result!.handle).toBe(fake.handle);
      expect(result!.file.name).toBe('data.json');
      expect(fake.query).toHaveBeenCalledWith({ mode: 'readwrite' });
    });

    it('skips requestPermission when queryPermission already returns granted', async () => {
      const fake = makeFakeHandle({ queriedPermission: 'granted' });
      installPickerStubs({ openHandle: fake.handle });
      const service = setupBrowser();

      await service.openLocalFile();

      expect(fake.query).toHaveBeenCalledTimes(1);
      expect(fake.request).not.toHaveBeenCalled();
    });

    it('calls requestPermission when queryPermission returns prompt', async () => {
      const fake = makeFakeHandle({ queriedPermission: 'prompt', requestedPermission: 'granted' });
      installPickerStubs({ openHandle: fake.handle });
      const service = setupBrowser();

      await service.openLocalFile();

      expect(fake.request).toHaveBeenCalledWith({ mode: 'readwrite' });
    });

    it('throws permissionDeniedInitial when the user denies the proactive prompt', async () => {
      const fake = makeFakeHandle({ queriedPermission: 'prompt', requestedPermission: 'denied' });
      installPickerStubs({ openHandle: fake.handle });
      const service = setupBrowser();

      await expectFailureCause(() => service.openLocalFile(), 'permissionDeniedInitial');
    });

    it('throws writeError on a non-Abort picker rejection', async () => {
      installPickerStubs({ openError: new Error('boom') });
      const service = setupBrowser();
      await expectFailureCause(() => service.openLocalFile(), 'writeError');
    });
  });

  describe('requestWritePermission', () => {
    it('short-circuits to granted without calling requestPermission', async () => {
      const fake = makeFakeHandle({ queriedPermission: 'granted' });
      const service = setupBrowser();
      const result = await service.requestWritePermission(fake.handle);
      expect(result).toBe('granted');
      expect(fake.request).not.toHaveBeenCalled();
    });

    it('asks the user when queryPermission returns prompt', async () => {
      const fake = makeFakeHandle({ queriedPermission: 'prompt', requestedPermission: 'granted' });
      const service = setupBrowser();
      const result = await service.requestWritePermission(fake.handle);
      expect(result).toBe('granted');
      expect(fake.request).toHaveBeenCalledWith({ mode: 'readwrite' });
    });

    it('returns denied verbatim when the user denies', async () => {
      const fake = makeFakeHandle({ queriedPermission: 'prompt', requestedPermission: 'denied' });
      const service = setupBrowser();
      const result = await service.requestWritePermission(fake.handle);
      expect(result).toBe('denied');
    });
  });

  describe('saveToFile', () => {
    it('writes + closes the writable on the happy path and returns lastModified', async () => {
      const updatedFile = new File(['{"k":2}'], 'data.json', {
        type: 'application/json',
        lastModified: 1_700_000_000_500,
      });
      const fake = makeFakeHandle({ file: updatedFile });
      const service = setupBrowser();

      const result = await service.saveToFile(fake.handle, '{"k":2}');

      expect(fake.writable.write).toHaveBeenCalledWith('{"k":2}');
      expect(fake.writable.close).toHaveBeenCalledTimes(1);
      expect(fake.writable.abort).not.toHaveBeenCalled();
      expect(result.lastModified).toBe(1_700_000_000_500);
    });

    it('maps NotAllowedError on createWritable to permissionDeniedRevoked', async () => {
      const fake = makeFakeHandle({
        createWritableError: new DOMException('denied', 'NotAllowedError'),
      });
      const service = setupBrowser();
      await expectFailureCause(
        () => service.saveToFile(fake.handle, ''),
        'permissionDeniedRevoked',
      );
    });

    it('maps NotFoundError on createWritable to notFound', async () => {
      const fake = makeFakeHandle({
        createWritableError: new DOMException('gone', 'NotFoundError'),
      });
      const service = setupBrowser();
      await expectFailureCause(() => service.saveToFile(fake.handle, ''), 'notFound');
    });

    it('maps QuotaExceededError during write to diskFull', async () => {
      const writable = makeWritable({
        write: vi.fn().mockRejectedValue(new DOMException('full', 'QuotaExceededError')),
      });
      const fake = makeFakeHandle({ writable });
      const service = setupBrowser();
      await expectFailureCause(() => service.saveToFile(fake.handle, 'data'), 'diskFull');
      expect(writable.abort).toHaveBeenCalled();
    });

    it('maps AbortError during write to aborted', async () => {
      const writable = makeWritable({
        write: vi.fn().mockRejectedValue(new DOMException('abort', 'AbortError')),
      });
      const fake = makeFakeHandle({ writable });
      const service = setupBrowser();
      await expectFailureCause(() => service.saveToFile(fake.handle, 'data'), 'aborted');
    });

    it('maps unknown errors to writeError and preserves the underlyingCause', async () => {
      const cause = new Error('something else');
      const writable = makeWritable({ close: vi.fn().mockRejectedValue(cause) });
      const fake = makeFakeHandle({ writable });
      const service = setupBrowser();
      try {
        await service.saveToFile(fake.handle, 'data');
        throw new Error('expected throw');
      } catch (caught) {
        expect(caught).toBeInstanceOf(FileAccessError);
        const err = caught as FileAccessError;
        expect(err.kind).toBe('writeError');
        expect(err.cause).toBe(cause);
      }
    });

    it('falls back to Date.now() when getFile rejects after a successful write', async () => {
      const dateNow = Date.now();
      vi.spyOn(Date, 'now').mockReturnValue(dateNow);
      const fake = makeFakeHandle({
        getFileError: new DOMException('not found', 'NotFoundError'),
      });
      const service = setupBrowser();
      const result = await service.saveToFile(fake.handle, 'data');
      expect(result.lastModified).toBe(dateNow);
    });
  });

  describe('saveAsNewFile', () => {
    it('throws unsupportedBrowser when the save picker is undefined', async () => {
      installPickerStubs({ openHandle: 'unsupported', saveHandle: 'unsupported' });
      const service = setupBrowser();
      await expectFailureCause(
        () => service.saveAsNewFile('data', 'data.json'),
        'unsupportedBrowser',
      );
    });

    it('resolves null when the user cancels the picker (AbortError)', async () => {
      installPickerStubs({ saveError: new DOMException('aborted', 'AbortError') });
      const service = setupBrowser();
      const result = await service.saveAsNewFile('data', 'data.json');
      expect(result).toBeNull();
    });

    it('writes through saveToFile after a successful pick and returns file + handle + lastModified', async () => {
      const updatedFile = new File(['data'], 'newname.json', {
        type: 'application/json',
        lastModified: 1_700_000_001_000,
      });
      const fake = makeFakeHandle({ name: 'newname.json', file: updatedFile });
      installPickerStubs({ saveHandle: fake.handle });
      const service = setupBrowser();

      const result = await service.saveAsNewFile('data', 'suggested.json');

      expect(result).not.toBeNull();
      expect(result!.handle).toBe(fake.handle);
      expect(result!.file.name).toBe('newname.json');
      expect(result!.lastModified).toBe(1_700_000_001_000);
      expect(fake.writable.write).toHaveBeenCalledWith('data');
      expect(fake.writable.close).toHaveBeenCalled();
    });

    it('throws permissionDeniedInitial when the save picker grants but requestPermission denies', async () => {
      const fake = makeFakeHandle({ queriedPermission: 'prompt', requestedPermission: 'denied' });
      installPickerStubs({ saveHandle: fake.handle });
      const service = setupBrowser();
      await expectFailureCause(
        () => service.saveAsNewFile('data', 'data.json'),
        'permissionDeniedInitial',
      );
    });

    it('throws writeError on a non-Abort picker rejection', async () => {
      installPickerStubs({ saveError: new Error('boom') });
      const service = setupBrowser();
      await expectFailureCause(() => service.saveAsNewFile('data', 'data.json'), 'writeError');
    });
  });

  describe('FileAccessError shape', () => {
    it('carries the kind as a closed-enum string and preserves the underlying Error.cause', () => {
      const underlying = new Error('underlying');
      const error = new FileAccessError('notFound', 'oops', underlying);
      expect(error).toBeInstanceOf(Error);
      expect(error.name).toBe('FileAccessError');
      expect(error.kind).toBe('notFound');
      expect(error.message).toBe('oops');
      expect(error.cause).toBe(underlying);
    });

    it('falls back to the kind as the message when none is supplied', () => {
      const error = new FileAccessError('diskFull');
      expect(error.message).toBe('diskFull');
    });
  });
});

async function expectFailureCause(
  action: () => Promise<unknown>,
  expected: FileAccessFailureCause,
): Promise<void> {
  try {
    await action();
    throw new Error(`expected FileAccessError with kind "${expected}"`);
  } catch (caught) {
    expect(caught).toBeInstanceOf(FileAccessError);
    const err = caught as FileAccessError;
    expect(err.kind).toBe(expected);
  }
}
