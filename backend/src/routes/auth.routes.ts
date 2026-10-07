import { Router, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { env, isTest } from '../config/env';
import { requireAuth, auth } from '../middleware/auth';
import * as authService from '../services/auth.service';
import { asyncHandler, ok } from '../utils/http';
import { passwordSchema } from '../security/password';

export const authRouter = Router();

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => isTest,
  handler: (_req, res) => res.status(429).json({ success: false, error: { code: 'RATE_LIMITED', message: 'Too many attempts. Please try again later.' } }),
});

const COOKIE = 'if_refresh';
// No maxAge => session cookie: the browser deletes it when it is fully closed.
const setRefreshCookie = (res: Response, token: string) =>
  res.cookie(COOKIE, token, { httpOnly: true, sameSite: 'lax', secure: env.COOKIE_SECURE, path: '/api/auth' });

authRouter.post(
  '/register',
  limiter,
  asyncHandler(async (req, res) => {
    const input = authService.RegisterSchema.parse(req.body);
    const { refreshToken, ...rest } = await authService.register(input);
    setRefreshCookie(res, refreshToken);
    ok(res, rest, 201);
  }),
);

authRouter.post(
  '/login',
  limiter,
  asyncHandler(async (req, res) => {
    const { refreshToken, ...rest } = await authService.login(authService.LoginSchema.parse(req.body));
    setRefreshCookie(res, refreshToken);
    ok(res, rest);
  }),
);

authRouter.post(
  '/refresh',
  asyncHandler(async (req, res) => {
    const { refreshToken, accessToken } = await authService.refresh(req.cookies?.[COOKIE]);
    setRefreshCookie(res, refreshToken);
    ok(res, { accessToken });
  }),
);

authRouter.post(
  '/logout',
  asyncHandler(async (req, res) => {
    await authService.logout(req.cookies?.[COOKIE]);
    res.clearCookie(COOKIE, { path: '/api/auth' });
    ok(res, { loggedOut: true });
  }),
);

authRouter.get(
  '/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    const a = auth(req);
    ok(res, await authService.me(a.userId, a.organizationId));
  }),
);

authRouter.post(
  '/forgot-password',
  limiter,
  asyncHandler(async (req, res) => {
    ok(res, await authService.forgotPassword(String(req.body?.email ?? '')));
  }),
);

authRouter.post(
  '/reset-password',
  limiter,
  asyncHandler(async (req, res) => {
    const body = z.object({ token: z.string().min(10), password: passwordSchema }).parse(req.body);
    await authService.resetPassword(body.token, body.password);
    ok(res, { reset: true });
  }),
);
