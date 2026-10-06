import { buildApp } from './app.js';
import { loadConfig } from './shared/config.js';
import { createPool } from './shared/db/pool.js';

const config = loadConfig();
const pool = createPool(config.DATABASE_URL);
const app = await buildApp({ config, pool });

// Idle clients can error (e.g. DB restart); without a listener this would crash the process.
pool.on('error', (error) => {
  app.log.error({ err: error }, 'idle database client error');
});

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  app.log.info({ signal }, 'shutting down');
  await app.close();
  await pool.end();
  process.exit(0);
}

process.once('SIGINT', (signal) => void shutdown(signal));
process.once('SIGTERM', (signal) => void shutdown(signal));

try {
  await app.listen({ host: config.HOST, port: config.PORT });
} catch (error) {
  app.log.fatal(error, 'failed to start server');
  process.exit(1);
}
