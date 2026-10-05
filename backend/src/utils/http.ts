import type { NextFunction, Request, RequestHandler, Response } from 'express';

export const ok = (res: Response, data: unknown, status = 200) => res.status(status).json({ success: true, data });

export const asyncHandler =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler =>
  (req, res, next) => {
    fn(req, res, next).catch(next);
  };

export function paginationParams(query: Record<string, unknown>, defaults = { pageSize: 20, maxPageSize: 100 }) {
  const page = Math.max(1, Number(query.page) || 1);
  const pageSize = Math.min(defaults.maxPageSize, Math.max(1, Number(query.pageSize) || defaults.pageSize));
  return { page, pageSize, skip: (page - 1) * pageSize, take: pageSize };
}

export function pageMeta(total: number, page: number, pageSize: number) {
  return { total, page, pageSize, totalPages: Math.max(1, Math.ceil(total / pageSize)) };
}
