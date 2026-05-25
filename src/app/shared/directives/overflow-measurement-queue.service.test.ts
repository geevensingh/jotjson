import { OverflowMeasurementQueue } from './overflow-measurement-queue.service';

describe('OverflowMeasurementQueue', () => {
  let queue: OverflowMeasurementQueue;

  beforeEach(() => {
    queue = new OverflowMeasurementQueue();
  });

  it('batches multiple enqueued measurements into one rAF flush', () => {
    const reads: number[] = [];
    const writes: number[] = [];
    queue.enqueue(
      () => {
        reads.push(1);
        return 'a';
      },
      () => writes.push(1),
    );
    queue.enqueue(
      () => {
        reads.push(2);
        return 'b';
      },
      () => writes.push(2),
    );
    queue.enqueue(
      () => {
        reads.push(3);
        return 'c';
      },
      () => writes.push(3),
    );

    expect(reads).toEqual([]);
    expect(writes).toEqual([]);

    const flushed = queue.__flushForTesting();

    expect(flushed).toBe(3);
    expect(reads).toEqual([1, 2, 3]);
    expect(writes).toEqual([1, 2, 3]);
  });

  it('runs every read callback before any write callback (two-phase contract)', () => {
    const order: string[] = [];
    queue.enqueue(
      () => {
        order.push('read-1');
        return 'one';
      },
      () => order.push('write-1'),
    );
    queue.enqueue(
      () => {
        order.push('read-2');
        return 'two';
      },
      () => order.push('write-2'),
    );
    queue.enqueue(
      () => {
        order.push('read-3');
        return 'three';
      },
      () => order.push('write-3'),
    );

    queue.__flushForTesting();

    expect(order).toEqual(['read-1', 'read-2', 'read-3', 'write-1', 'write-2', 'write-3']);
  });

  it('passes each read return value to its matching write callback', () => {
    const received: Array<{ index: number; value: number }> = [];
    queue.enqueue<number>(
      () => 10,
      (value) => received.push({ index: 0, value }),
    );
    queue.enqueue<number>(
      () => 20,
      (value) => received.push({ index: 1, value }),
    );
    queue.enqueue<number>(
      () => 30,
      (value) => received.push({ index: 2, value }),
    );

    queue.__flushForTesting();

    expect(received).toEqual([
      { index: 0, value: 10 },
      { index: 1, value: 20 },
      { index: 2, value: 30 },
    ]);
  });

  it('clears pending entries after flush so a subsequent batch starts fresh', () => {
    const calls: string[] = [];
    queue.enqueue(
      () => 'a',
      () => calls.push('first'),
    );
    queue.__flushForTesting();
    expect(calls).toEqual(['first']);

    queue.enqueue(
      () => 'b',
      () => calls.push('second'),
    );
    queue.__flushForTesting();
    expect(calls).toEqual(['first', 'second']);
  });

  it('uses requestAnimationFrame in production paths', (done) => {
    let writeCount = 0;
    queue.enqueue(
      () => 'value',
      () => {
        writeCount++;
      },
    );
    expect(writeCount).toBe(0);
    requestAnimationFrame(() => {
      expect(writeCount).toBe(1);
      done();
    });
  });
});
