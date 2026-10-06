import Fastify from 'fastify';

import { loadConfig } from './shared/config.js';

const config = loadConfig();

const app = Fastify({ logger: { level: config.LOG_LEVEL } });

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  app.log.info({ signal }, 'shutting down');
  await app.close();
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
