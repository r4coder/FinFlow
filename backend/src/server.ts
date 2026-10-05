import { createApp } from './app';
import { env } from './config/env';
import { prisma } from './db';
import { closeQueues, startWorker } from './jobs/queue';

const app = createApp();
const server = app.listen(env.PORT, () => {
  console.log(`InvoiceFlow API listening on :${env.PORT} (queue=${env.QUEUE_MODE}, worker=${env.RUN_WORKER})`);
  if (env.RUN_WORKER) startWorker();
});

async function shutdown() {
  console.log('Shutting down...');
  server.close();
  await closeQueues();
  await prisma.$disconnect();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
