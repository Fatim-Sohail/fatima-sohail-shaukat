import type { BillingSummary } from '../application/billingRun.js';

interface Logger {
  debug(obj: object, msg: string): void;
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

export interface BillingSchedulerOptions {
  run: () => Promise<BillingSummary>;
  intervalMs: number;
  log: Logger;
}

/**
 * Runs billing now and then every `intervalMs`. A tick that fires while the previous run is
 * still going is skipped rather than queued. Each run opens and commits its own short
 * transactions, so nothing is held between ticks. Returns stop(), which clears the timer and
 * resolves once any in-flight run has finished (so the pool can be closed safely after it).
 */
export function startBillingScheduler(options: BillingSchedulerOptions): () => Promise<void> {
  const { run, intervalMs, log } = options;
  let current: Promise<void> | null = null;

  const tick = (): void => {
    if (current) {
      log.warn({ intervalMs }, 'billing run still in progress, skipping this tick');
      return;
    }
    current = run()
      .then((summary) => {
        const worked = summary.renewed + summary.failed + summary.expired + summary.errors > 0;
        if (worked) {
          log.info({ billing: summary }, 'billing run completed');
        } else {
          log.debug({ billing: summary }, 'billing run completed, nothing due');
        }
      })
      .catch((error: unknown) => {
        log.error({ err: error }, 'billing run failed');
      })
      .finally(() => {
        current = null;
      });
  };

  tick();
  const timer = setInterval(tick, intervalMs);

  return async () => {
    clearInterval(timer);
    await current;
  };
}
