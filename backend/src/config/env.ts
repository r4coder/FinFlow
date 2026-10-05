import 'dotenv/config';
import { z } from 'zod';

const isProd = process.env.NODE_ENV === 'production';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(4000),
  FRONTEND_URL: z.string().default('http://localhost:5173'),
  BACKEND_URL: z.string().default('http://localhost:4000'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  JWT_SECRET: z.string().min(isProd ? 32 : 8),
  JWT_REFRESH_SECRET: z.string().min(isProd ? 32 : 8),
  ENCRYPTION_KEY: z.string().min(isProd ? 32 : 8),
  AI_MODE: z.enum(['mock', 'gemini']).default('mock'),
  AI_MODEL: z.string().default('gemini-2.5-flash'),
  QUEUE_MODE: z.enum(['bullmq', 'inline']).default('bullmq'),
  RUN_WORKER: z
    .string()
    .default('true')
    .transform((v) => v === 'true'),
  MAX_UPLOAD_MB: z.coerce.number().default(10),
  STORAGE_DIR: z.string().default('./storage'),
  ACCESS_TOKEN_TTL: z.string().default('15m'),
  REFRESH_TOKEN_DAYS: z.coerce.number().default(14),
  COOKIE_SECURE: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment configuration:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
export const isProduction = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';
