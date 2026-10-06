import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { BillingSummary } from '../../../src/modules/subscriptions/application/billingRun.js';
import { startBillingScheduler } from '../../../src/modules/subscriptions/infrastructure/billingScheduler.js';

const INTERVAL = 60_000;
const nothingDue: BillingSummary = { renewed: 0, failed: 0, expired: 0, errors: 0 };

const logger = () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });

/** A billing run that stays in progress until `finish` is called. */
function pendingRun() {
  let finish: (summary: BillingSummary) => void = () => undefined;
  const run = vi.fn(
    () =>
      new Promise<BillingSummary>((resolve) => {
        finish = resolve;
      }),
  );
  return {
    run,
    finish: (summary = nothingDue) => {
      finish(summary);
    },
  };
}

describe('startBillingScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs billing once immediately on start', async () => {
    const run = vi.fn<() => Promise<BillingSummary>>().mockResolvedValue(nothingDue);
    const stop = startBillingScheduler({ run, intervalMs: INTERVAL, log: logger() });

    expect(run).toHaveBeenCalledTimes(1);
    await stop();
  });

  it('runs again after each interval', async () => {
    const run = vi.fn<() => Promise<BillingSummary>>().mockResolvedValue(nothingDue);
    const stop = startBillingScheduler({ run, intervalMs: INTERVAL, log: logger() });

    await vi.advanceTimersByTimeAsync(INTERVAL - 1);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(run).toHaveBeenCalledTimes(3);
    await stop();
  });

  it('skips ticks while a run is still in progress instead of overlapping', async () => {
    const { run, finish } = pendingRun();
    const log = logger();
    const stop = startBillingScheduler({ run, intervalMs: INTERVAL, log });

    await vi.advanceTimersByTimeAsync(INTERVAL * 3);
    expect(run).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledTimes(3);

    finish();
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(run).toHaveBeenCalledTimes(2);

    finish();
    await stop();
  });

  it('logs a failed run and keeps running on later ticks', async () => {
    const run = vi
      .fn<() => Promise<BillingSummary>>()
      .mockRejectedValueOnce(new Error('database unavailable'))
      .mockResolvedValue(nothingDue);
    const log = logger();
    const stop = startBillingScheduler({ run, intervalMs: INTERVAL, log });

    await vi.advanceTimersByTimeAsync(0);
    expect(log.error).toHaveBeenCalledWith(
      { err: expect.any(Error) as Error },
      'billing run failed',
    );

    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(run).toHaveBeenCalledTimes(2);
    await stop();
  });

  it('logs the summary when a run did work, and stays quiet when nothing was due', async () => {
    const worked: BillingSummary = { renewed: 2, failed: 1, expired: 0, errors: 0 };
    const run = vi
      .fn<() => Promise<BillingSummary>>()
      .mockResolvedValueOnce(worked)
      .mockResolvedValue(nothingDue);
    const log = logger();
    const stop = startBillingScheduler({ run, intervalMs: INTERVAL, log });

    await vi.advanceTimersByTimeAsync(INTERVAL);
    await stop();

    expect(log.info).toHaveBeenCalledTimes(1);
    expect(log.info).toHaveBeenCalledWith({ billing: worked }, 'billing run completed');
    expect(log.debug).toHaveBeenCalledWith({ billing: nothingDue }, expect.any(String));
  });

  it('stop() waits for the in-flight run and prevents any further runs', async () => {
    const { run, finish } = pendingRun();
    const stop = startBillingScheduler({ run, intervalMs: INTERVAL, log: logger() });

    let stopped = false;
    const stopping = stop().then(() => {
      stopped = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(stopped).toBe(false);

    finish();
    await stopping;
    expect(stopped).toBe(true);

    await vi.advanceTimersByTimeAsync(INTERVAL * 5);
    expect(run).toHaveBeenCalledTimes(1);
  });
});
