import { PrismaClient, Prisma } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { env } from './config/env';

const adapter = new PrismaPg({ connectionString: env.DATABASE_URL });

export const prisma = new PrismaClient({ adapter });
export type Tx = Prisma.TransactionClient;
export type Db = PrismaClient | Prisma.TransactionClient;
