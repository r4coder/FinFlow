import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { AppError } from '../utils/errors';
import { isProduction } from '../config/env';

export function notFoundHandler(_req: Request, res: Response) {
  res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Route not found' } });
}

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  if (err instanceof ZodError) {
    return res.status(400).json({
      success: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Invalid request',
        details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      },
    });
  }
  if (err instanceof AppError) {
    return res.status(err.status).json({ success: false, error: { code: err.code, message: err.message, details: err.details } });
  }
  const e = err as { type?: string; code?: string; message?: string };
  if (e?.type === 'entity.parse.failed') {
    return res.status(400).json({ success: false, error: { code: 'INVALID_JSON', message: 'Malformed JSON body' } });
  }
  if (e?.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ success: false, error: { code: 'FILE_TOO_LARGE', message: 'File exceeds the maximum upload size' } });
  }
  // Never echo internals (or secrets) to the client. Log only message + route.
  console.error(`[error] ${req.method} ${req.path}: ${e?.message ?? 'unknown error'}`);
  res.status(500).json({
    success: false,
    error: { code: 'INTERNAL_ERROR', message: isProduction ? 'Internal server error' : e?.message ?? 'Internal server error' },
  });
}
