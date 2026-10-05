import { Queue, Worker, UnrecoverableError } from 'bullmq';
import IORedis from 'ioredis';
import { env } from '../config/env';
import { markProcessingFailed, processInvoice } from '../invoices/pipeline';
import { AIProviderError } from '../ai/types';

/**
 * Queue layout. Today the staged pipeline (extract -> validate -> duplicates -> anomalies -> rules -> automation ->
 * notifications -> audit) runs inside the single `invoice-processing` queue so the whole run is one atomic, idempotent
 * unit. Each stage is its own function in invoices/pipeline.ts / rules/engine.ts and can be split across the other
 * queue names later without changing the data model.
 */
export const QUEUES = { invoiceProcessing: 'invoice-processing' } as const;
export const RESERVED_QUEUE_NAMES = ['ai-extraction', 'validation', 'rule-evaluation', 'approval', 'notifications'];

export const MAX_ATTEMPTS = 3;

export interface ProcessJobData {
  invoiceId: string;
  organizationId: string;
  run: number;
}

let connection: IORedis | null = null;
let queue: Queue<ProcessJobData> | null = null;
let worker: Worker<ProcessJobData> | null = null;

const getConnection = () => (connection ??= new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null }));
const getQueue = () => (queue ??= new Queue<ProcessJobData>(QUEUES.invoiceProcessing, { connection: getConnection() }));

const isFatal = (e: unknown) => e instanceof AIProviderError && !e.retryable;

/** Runs the pipeline with the same retry policy as the BullMQ worker (used in inline mode). */
export async function runWithRetries(invoiceId: string, run: number) {
  let lastError = '';
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await processInvoice(invoiceId, run);
    } catch (e) {
      lastError = (e as Error).message;
      if (isFatal(e)) break;
    }
  }
  await markProcessingFailed(invoiceId, run, lastError);
  return { skipped: false as const, status: 'FAILED', decidedBy: null };
}

/** Idempotent enqueue: the BullMQ jobId is derived from invoice + run, so enqueueing twice creates ONE job. */
export async function enqueueInvoiceProcessing(data: ProcessJobData) {
  if (env.QUEUE_MODE === 'inline') {
    await runWithRetries(data.invoiceId, data.run);
    return;
  }
  await getQueue().add('process-invoice', data, {
    jobId: `invoice-${data.invoiceId}-run-${data.run}`,
    attempts: MAX_ATTEMPTS,
    backoff: { type: 'exponential', delay: 2000 },
    removeOnComplete: 200,
    removeOnFail: 500,
  });
}

export function startWorker() {
  if (env.QUEUE_MODE === 'inline' || worker) return worker;
  worker = new Worker<ProcessJobData>(
    QUEUES.invoiceProcessing,
    async (job) => {
      try {
        return await processInvoice(job.data.invoiceId, job.data.run);
      } catch (e) {
        if (isFatal(e)) throw new UnrecoverableError((e as Error).message);
        throw e;
      }
    },
    { connection: getConnection(), concurrency: 4 },
  );
  worker.on('failed', (job, err) => {
    if (!job) return;
    const exhausted = job.attemptsMade >= (job.opts.attempts ?? MAX_ATTEMPTS) || err instanceof UnrecoverableError;
    if (exhausted) markProcessingFailed(job.data.invoiceId, job.data.run, err.message).catch((e) => console.error('[worker] markProcessingFailed', e.message));
  });
  worker.on('error', (e) => console.error('[worker] error', e.message));
  return worker;
}

export async function redisHealthy(): Promise<boolean> {
  if (env.QUEUE_MODE === 'inline') return true;
  try {
    return (await getConnection().ping()) === 'PONG';
  } catch {
    return false;
  }
}

export async function closeQueues() {
  await worker?.close();
  await queue?.close();
  await connection?.quit().catch(() => undefined);
  worker = null;
  queue = null;
  connection = null;
}
