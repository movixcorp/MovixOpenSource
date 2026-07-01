import type { AxiosInstance, InternalAxiosRequestConfig } from 'axios';

const TMDB_HOST = 'api.themoviedb.org';
const TMDB_PATH_PREFIX = '/3/';

/**
 * Intercepteur axios qui redirige les appels TMDB vers le proxy backend
 * pour masquer la clé API côté client.
 *
 * Au lieu d'appeler https://api.themoviedb.org/3/genre/movie/list?api_key=XXX,
 * la requête est redirigée vers /api/tmdb-proxy/genre/movie/list?api_key=XXX
 * et le backend ajoute sa propre clé TMDB (process.env.TMDB_API_KEY).
 *
 * La clé API envoyée par le frontend est ignorée par le backend.
 */
export function registerTmdbProxyInterceptor(axiosInstance: AxiosInstance, mainApiUrl: string) {
  return axiosInstance.interceptors.request.use(
    (config: InternalAxiosRequestConfig) => {
      if (!config.url || !config.baseURL) return config;

      let fullUrl: string;
      try {
        fullUrl = new URL(config.url, config.baseURL).toString();
      } catch {
        return config;
      }

      // Ne toucher qu'aux requêtes vers api.themoviedb.org
      const parsed = new URL(fullUrl);
      if (parsed.hostname !== TMDB_HOST || !parsed.pathname.startsWith(TMDB_PATH_PREFIX)) {
        return config;
      }

      // Extraire le chemin TMDB (ex: /3/genre/movie/list -> genre/movie/list)
      const tmdbPath = parsed.pathname.replace(TMDB_PATH_PREFIX, '');
      const proxyUrl = `${mainApiUrl}/api/tmdb-proxy/${tmdbPath}`;

      // Reconstruire les paramètres, en supprimant api_key (le backend ajoute la sienne)
      const params = new URLSearchParams(parsed.search);
      params.delete('api_key');

      const paramsString = params.toString();
      config.url = paramsString ? `${proxyUrl}?${paramsString}` : proxyUrl;
      config.baseURL = ''; // Éviter que axios re-prépende baseURL

      return config;
    },
    (error) => Promise.reject(error)
  );
}
