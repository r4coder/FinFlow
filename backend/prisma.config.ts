import path from 'node:path';
import { defineConfig } from 'prisma/config';

/**
 * Default: standard Prisma CLI behaviour (native schema engine, `prisma migrate deploy` works normally).
 *
 * PRISMA_USE_WASM_ENGINE=1 is an escape hatch for locked-down environments that cannot download the Rust
 * schema-engine binary (it only supports generating SQL with `prisma migrate diff`, not applying it).
 */
const useWasm = process.env.PRISMA_USE_WASM_ENGINE === '1';

export default defineConfig(
  (useWasm
    ? {
        experimental: { adapter: true },
        schema: path.join('prisma', 'schema.prisma'),
        engine: 'js',
        adapter: async () => {
          const { PrismaPg } = await import('@prisma/adapter-pg');
          return new PrismaPg({ connectionString: process.env.DATABASE_URL });
        },
      }
    : { schema: path.join('prisma', 'schema.prisma') }) as any,
);
