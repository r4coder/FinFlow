const TEST_DB = process.env.TEST_DATABASE_NAME ?? 'invoiceflow_test';
const BASE = process.env.TEST_DATABASE_BASE_URL ?? 'postgresql://postgres:postgres@localhost:5432';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = `${BASE}/${TEST_DB}`;
process.env.QUEUE_MODE = 'inline';
process.env.RUN_WORKER = 'false';
process.env.JWT_SECRET = 'test-jwt-secret-0123456789';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-0123456789';
process.env.ENCRYPTION_KEY = 'test-encryption-key-0123456789';
process.env.AI_MODE = 'mock';
process.env.STORAGE_DIR = `${process.env.TMPDIR ?? '/tmp'}/invoiceflow-test-storage`;
