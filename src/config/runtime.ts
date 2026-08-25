const normalizeBaseUrl = (value?: string): string => (value || '').trim().replace(/\/+$/, '');

export const SITE_URL = normalizeBaseUrl(import.meta.env.VITE_SITE_URL as string);

export const WATCHPARTY_API = normalizeBaseUrl(import.meta.env.VITE_WATCHPARTY_API as string) ||
  normalizeBaseUrl(import.meta.env.VITE_MAIN_API as string);

export const MAIN_API = normalizeBaseUrl(import.meta.env.VITE_MAIN_API as string);
export const PROXIES_EMBED_API = normalizeBaseUrl(import.meta.env.VITE_PROXIES_EMBED_API as string);
export const BESTDEBRID_API_BASE = 'https://bestdebrid.com/api/v1';

export const buildSiteUrl = (path: string): string => {
  return `${SITE_URL}${path.startsWith('/') ? path : `/${path}`}`;
};
