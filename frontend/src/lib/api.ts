import axios, { AxiosResponse } from 'axios';

let accessToken: string | null = null;
export const setToken = (t: string | null) => {
  accessToken = t;
};

export const api = axios.create({ baseURL: '/api', withCredentials: true });

api.interceptors.request.use((cfg) => {
  if (accessToken) cfg.headers.Authorization = `Bearer ${accessToken}`;
  return cfg;
});

let refreshing: Promise<string | null> | null = null;
async function refresh(): Promise<string | null> {
  try {
    const r = await axios.post('/api/auth/refresh', {}, { withCredentials: true });
    setToken(r.data.data.accessToken);
    return r.data.data.accessToken;
  } catch {
    setToken(null);
    return null;
  }
}

api.interceptors.response.use(
  (r) => r,
  async (err) => {
    const orig = err.config;
    if (err.response?.status === 401 && orig && !orig._retry && !String(orig.url).includes('/auth/')) {
      orig._retry = true;
      refreshing ??= refresh().finally(() => (refreshing = null));
      const t = await refreshing;
      if (t) {
        orig.headers.Authorization = `Bearer ${t}`;
        return api(orig);
      }
      window.dispatchEvent(new Event('auth:logout'));
    }
    return Promise.reject(err);
  },
);

export const unwrap = <T,>(p: Promise<AxiosResponse>): Promise<T> => p.then((r) => r.data.data as T);
export const errMsg = (e: any): string => e?.response?.data?.error?.message ?? e?.message ?? 'Something went wrong';
export const errDetails = (e: any): { path: string; message: string }[] => e?.response?.data?.error?.details ?? [];
export { refresh as refreshSession };
