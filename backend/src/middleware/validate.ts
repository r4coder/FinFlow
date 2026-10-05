import type { Request } from 'express';
import { ZodTypeAny, z } from 'zod';

export const parseBody = <T extends ZodTypeAny>(schema: T, req: Request): z.infer<T> => schema.parse(req.body ?? {});
export const parseQuery = <T extends ZodTypeAny>(schema: T, req: Request): z.infer<T> => schema.parse(req.query ?? {});
