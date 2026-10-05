import express from 'express';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import swaggerUi from 'swagger-ui-express';
import { env, isTest } from './config/env';
import { prisma } from './db';
import { requireAuth } from './middleware/auth';
import { errorHandler, notFoundHandler } from './middleware/error';
import { authRouter } from './routes/auth.routes';
import { invoiceRouter } from './routes/invoice.routes';
import { approvalRouter, exceptionRouter } from './routes/approval.routes';
import { automationRouter } from './routes/automation.routes';
import { analyticsRouter, auditRouter, notificationRouter, settingsRouter, taskRouter, userRouter, vendorRouter } from './routes/misc.routes';
import { buildOpenApi } from './docs';
import { redisHealthy } from './jobs/queue';

export function createApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  // Swagger UI needs inline scripts/styles, so it gets its own relaxed CSP; the rest of the API uses Helmet defaults.
  app.use('/api/docs', helmet({ contentSecurityPolicy: false }), swaggerUi.serve, swaggerUi.setup(buildOpenApi()));
  app.use(helmet());
  app.use(cors({ origin: env.FRONTEND_URL.split(','), credentials: true }));
  app.use(cookieParser());
  app.use(express.json({ limit: '1mb' }));
  app.use(
    '/api',
    rateLimit({
      windowMs: 60_000,
      limit: 600,
      standardHeaders: true,
      legacyHeaders: false,
      skip: () => isTest,
      handler: (_req, res) => res.status(429).json({ success: false, error: { code: 'RATE_LIMITED', message: 'Too many requests' } }),
    }),
  );

  app.get('/api/health', async (_req, res) => {
    let db = false;
    try {
      await prisma.$queryRaw`SELECT 1`;
      db = true;
    } catch {
      /* unhealthy */
    }
    const redis = await redisHealthy();
    res.status(db && redis ? 200 : 503).json({ success: db && redis, data: { status: db && redis ? 'ok' : 'degraded', database: db, redis } });
  });

  app.use('/api/auth', authRouter);
  // Everything below requires authentication; organizationId is derived server-side from the verified token + membership.
  app.use('/api/invoices', requireAuth, invoiceRouter);
  app.use('/api/vendors', requireAuth, vendorRouter);
  app.use('/api/approvals', requireAuth, approvalRouter);
  app.use('/api/exceptions', requireAuth, exceptionRouter);
  app.use('/api/automation', requireAuth, automationRouter);
  app.use('/api/analytics', requireAuth, analyticsRouter);
  app.use('/api/audit-logs', requireAuth, auditRouter);
  app.use('/api/notifications', requireAuth, notificationRouter);
  app.use('/api/settings', requireAuth, settingsRouter);
  app.use('/api/users', requireAuth, userRouter);
  app.use('/api/tasks', requireAuth, taskRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
