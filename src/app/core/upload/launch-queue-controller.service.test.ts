import { PLATFORM_ID } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { type Mock, type Mocked } from 'vitest';
import { LoggerService } from '../telemetry/logger.service';
import { LaunchQueueController, type LaunchEvent } from './launch-queue-controller.service';

type Consumer = (params: LaunchParams) => void | Promise<void>;

interface FakeLaunchQueue {
  setConsumer(consumer: Consumer): void;
}

function makeHandle(file: File): FileSystemFileHandle {
  return {
    kind: 'file' as const,
    name: file.name,
    getFile: vi.fn().mockResolvedValue(file),
  } as unknown as FileSystemFileHandle;
}

function makeRejectingHandle(name: string, cause: unknown): FileSystemFileHandle {
  return {
    kind: 'file' as const,
    name,
    getFile: vi.fn().mockRejectedValue(cause),
  } as unknown as FileSystemFileHandle;
}

describe('LaunchQueueController', () => {
  let logger: Mocked<LoggerService>;
  let consumer: Consumer | null;
  let setConsumerSpy: Mock;

  function installLaunchQueue(present: boolean): void {
    consumer = null;
    setConsumerSpy = vi.fn().mockImplementation((cb: Consumer) => {
      consumer = cb;
    });
    if (present) {
      Object.defineProperty(window, 'launchQueue', {
        configurable: true,
        value: { setConsumer: setConsumerSpy } satisfies FakeLaunchQueue,
      });
    } else {
      Object.defineProperty(window, 'launchQueue', {
        configurable: true,
        value: undefined,
      });
    }
  }

  function configureBrowserTestBed(): void {
    TestBed.configureTestingModule({
      providers: [
        LaunchQueueController,
        { provide: LoggerService, useValue: logger },
        { provide: PLATFORM_ID, useValue: 'browser' },
      ],
    });
  }

  async function flush(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  }

  beforeEach(() => {
    logger = {
      error: vi.fn(),
      warn: vi.fn(),
      info: vi.fn(),
      event: vi.fn(),
    } as unknown as Mocked<LoggerService>;
  });

  afterEach(() => {
    Object.defineProperty(window, 'launchQueue', {
      configurable: true,
      value: undefined,
    });
  });

  it('does not touch window.launchQueue under prerender', () => {
    installLaunchQueue(true);
    TestBed.configureTestingModule({
      providers: [
        LaunchQueueController,
        { provide: LoggerService, useValue: logger },
        { provide: PLATFORM_ID, useValue: 'server' },
      ],
    });
    TestBed.inject(LaunchQueueController);
    expect(setConsumerSpy).not.toHaveBeenCalled();
  });

  it('is a silent no-op when window.launchQueue is absent', () => {
    installLaunchQueue(false);
    configureBrowserTestBed();
    const controller = TestBed.inject(LaunchQueueController);
    expect(controller.currentFileHandle()).toBeNull();
    // No throw is the contract; the handler simply never fires.
  });

  it('registers a single setConsumer on the browser platform', () => {
    installLaunchQueue(true);
    configureBrowserTestBed();
    TestBed.inject(LaunchQueueController);
    expect(setConsumerSpy).toHaveBeenCalledTimes(1);
  });

  it('ignores a launch event with files: []', async () => {
    installLaunchQueue(true);
    configureBrowserTestBed();
    const controller = TestBed.inject(LaunchQueueController);
    const handler = vi.fn();
    controller.registerHandler(handler);

    await consumer!({ files: [], targetURL: 'https://jotjson.com/' });
    await flush();

    expect(handler).not.toHaveBeenCalled();
    expect(controller.currentFileHandle()).toBeNull();
  });

  it('delivers a single file as a files-kind LaunchEvent', async () => {
    installLaunchQueue(true);
    configureBrowserTestBed();
    const controller = TestBed.inject(LaunchQueueController);
    const file = new File(['{}'], 'data.json', { type: 'application/json' });
    const handle = makeHandle(file);
    const handler = vi.fn().mockResolvedValue(undefined);
    controller.registerHandler(handler);

    await consumer!({ files: [handle], targetURL: 'https://jotjson.com/' });
    await flush();

    expect(handler).toHaveBeenCalledTimes(1);
    const event = handler.mock.lastCall![0] as LaunchEvent;
    expect(event.kind).toBe('files');
    if (event.kind === 'files') {
      expect(event.files.length).toBe(1);
      expect(event.files[0]).toBe(file);
    }
    expect(controller.currentFileHandle()).toBe(handle);
  });

  it('truncates a multi-file launch to the first handle (only one getFile call)', async () => {
    installLaunchQueue(true);
    configureBrowserTestBed();
    const controller = TestBed.inject(LaunchQueueController);
    const fileA = new File(['{}'], 'a.json');
    const fileB = new File(['{}'], 'b.json');
    const fileC = new File(['{}'], 'c.json');
    const handleA = makeHandle(fileA);
    const handleB = makeHandle(fileB);
    const handleC = makeHandle(fileC);
    const handler = vi.fn().mockResolvedValue(undefined);
    controller.registerHandler(handler);

    await consumer!({
      files: [handleA, handleB, handleC],
      targetURL: 'https://jotjson.com/',
    });
    await flush();

    expect(handleA.getFile).toHaveBeenCalledTimes(1);
    expect(handleB.getFile).not.toHaveBeenCalled();
    expect(handleC.getFile).not.toHaveBeenCalled();
    const event = handler.mock.lastCall![0] as LaunchEvent;
    expect(event.kind).toBe('files');
    if (event.kind === 'files') {
      expect(event.files.length).toBe(1);
      expect(event.files[0]).toBe(fileA);
    }
  });

  it('delivers an error event when getFile() rejects and fires home.fileHandler.readFailed', async () => {
    installLaunchQueue(true);
    configureBrowserTestBed();
    const controller = TestBed.inject(LaunchQueueController);
    const cause = new DOMException('Permission denied', 'NotAllowedError');
    const handle = makeRejectingHandle('data.json', cause);
    const handler = vi.fn().mockResolvedValue(undefined);
    controller.registerHandler(handler);

    await consumer!({ files: [handle], targetURL: 'https://jotjson.com/' });
    await flush();

    expect(handler).toHaveBeenCalledTimes(1);
    const event = handler.mock.lastCall![0] as LaunchEvent;
    expect(event.kind).toBe('error');
    if (event.kind === 'error') {
      expect(event.cause).toBe(cause);
    }
    expect(logger.error).toHaveBeenCalledWith('home.fileHandler.readFailed', cause);
    expect(controller.currentFileHandle()).toBe(handle);
  });

  it('replaces an active handler on re-register and emits a console warning', async () => {
    installLaunchQueue(true);
    configureBrowserTestBed();
    const controller = TestBed.inject(LaunchQueueController);
    const warn = vi.spyOn(console, 'warn');
    const first = vi.fn().mockResolvedValue(undefined);
    const second = vi.fn().mockResolvedValue(undefined);
    controller.registerHandler(first);
    controller.registerHandler(second);

    const handle = makeHandle(new File(['{}'], 'x.json'));
    await consumer!({ files: [handle], targetURL: 'https://jotjson.com/' });
    await flush();

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalled();
  });

  it('ignores a stale dispose so it does not clobber the newer handler', async () => {
    installLaunchQueue(true);
    configureBrowserTestBed();
    const controller = TestBed.inject(LaunchQueueController);
    vi.spyOn(console, 'warn');
    const first = vi.fn().mockResolvedValue(undefined);
    const second = vi.fn().mockResolvedValue(undefined);
    const disposeFirst = controller.registerHandler(first);
    controller.registerHandler(second);

    disposeFirst();

    const handle = makeHandle(new File(['{}'], 'x.json'));
    await consumer!({ files: [handle], targetURL: 'https://jotjson.com/' });
    await flush();

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('drops the active handler when its own dispose closure runs', async () => {
    installLaunchQueue(true);
    configureBrowserTestBed();
    const controller = TestBed.inject(LaunchQueueController);
    const handler = vi.fn().mockResolvedValue(undefined);
    const dispose = controller.registerHandler(handler);

    dispose();

    const handle = makeHandle(new File(['{}'], 'x.json'));
    await consumer!({ files: [handle], targetURL: 'https://jotjson.com/' });
    await flush();

    expect(handler).not.toHaveBeenCalled();
  });

  it('exposes currentFileHandle reflecting the latest launched handle', async () => {
    installLaunchQueue(true);
    configureBrowserTestBed();
    const controller = TestBed.inject(LaunchQueueController);
    const handler = vi.fn().mockResolvedValue(undefined);
    controller.registerHandler(handler);
    expect(controller.currentFileHandle()).toBeNull();

    const handleA = makeHandle(new File(['{}'], 'a.json'));
    await consumer!({ files: [handleA], targetURL: 'https://jotjson.com/' });
    await flush();
    expect(controller.currentFileHandle()).toBe(handleA);

    const handleB = makeHandle(new File(['[]'], 'b.json'));
    await consumer!({ files: [handleB], targetURL: 'https://jotjson.com/' });
    await flush();
    expect(controller.currentFileHandle()).toBe(handleB);
  });
});
