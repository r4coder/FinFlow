import { createContext, ReactNode, useCallback, useContext, useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, refreshSession, setToken, unwrap } from './api';

export interface Me {
  id: string;
  email: string;
  fullName: string;
  role: 'OWNER' | 'ADMIN' | 'FINANCE_MANAGER' | 'FINANCE_USER' | 'VIEWER';
  permissions: string[];
  organization: { id: string; name: string };
  onboarding: { aiConfigured: boolean; rulesReviewed: boolean; firstInvoice: boolean } | null;
  aiMode: 'MOCK' | 'GEMINI';
}

interface AuthCtx {
  me: Me | null;
  loading: boolean;
  can: (p: string) => boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (body: Record<string, unknown>) => Promise<void>;
  logout: () => Promise<void>;
  reload: () => Promise<void>;
}
const Ctx = createContext<AuthCtx>(null as any);
export const useAuth = () => useContext(Ctx);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const qc = useQueryClient();

  const reload = useCallback(async () => {
    setMe(await unwrap<Me>(api.get('/auth/me')));
  }, []);

  useEffect(() => {
    (async () => {
      if (await refreshSession()) await reload().catch(() => setMe(null));
      setLoading(false);
    })();
    const out = () => {
      setToken(null);
      setMe(null);
      qc.clear();
    };
    window.addEventListener('auth:logout', out);
    return () => window.removeEventListener('auth:logout', out);
  }, [reload, qc]);

  const startSession = async (path: string, body: unknown) => {
    const d = await unwrap<{ accessToken: string }>(api.post(path, body));
    setToken(d.accessToken);
    qc.clear();
    await reload();
  };

  return (
    <Ctx.Provider
      value={{
        me,
        loading,
        can: (p) => !!me?.permissions.includes(p),
        login: (email, password) => startSession('/auth/login', { email, password }),
        register: (body) => startSession('/auth/register', body),
        logout: async () => {
          await api.post('/auth/logout').catch(() => undefined);
          setToken(null);
          setMe(null);
          qc.clear();
        },
        reload,
      }}
    >
      {children}
    </Ctx.Provider>
  );
}
