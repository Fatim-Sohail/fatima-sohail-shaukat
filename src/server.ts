import { buildApp } from './app.js';
import { billDueSubscriptions } from './modules/subscriptions/application/billingRun.js';
import { startBillingScheduler } from './modules/subscriptions/infrastructure/billingScheduler.js';
import { createMockPaymentGateway } from './modules/subscriptions/infrastructure/mockPaymentGateway.js';
import { loadConfig } from './shared/config.js';
import { createPool } from './shared/db/pool.js';

const config = loadConfig();
const pool = createPool(config.DATABASE_URL);
// Shared by the HTTP routes and the scheduler so both see the same idempotency records.
const payments = createMockPaymentGateway({ failureRate: config.PAYMENT_FAILURE_RATE });
const now = (): Date => new Date();
const app = await buildApp({ config, pool, payments, now });

// Idle clients can error (e.g. DB restart); without a listener this would crash the process.
pool.on('error', (error) => {
  app.log.error({ err: error }, 'idle database client error');
});

try {
  await app.listen({ host: config.HOST, port: config.PORT });
} catch (error) {
  app.log.fatal(error, 'failed to start server');
  process.exit(1);
}

const stopBilling = startBillingScheduler({
  run: () => billDueSubscriptions({ pool, payments, now }),
  intervalMs: config.BILLING_INTERVAL_MS,
  log: app.log.child({ component: 'billing-scheduler' }),
});

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  app.log.info({ signal }, 'shutting down');
  // Waits for an in-flight billing run so the pool isn't closed underneath it.
  await stopBilling();
  await app.close();
  await pool.end();
  process.exit(0);
}

process.once('SIGINT', (signal) => void shutdown(signal));
process.once('SIGTERM', (signal) => void shutdown(signal));
