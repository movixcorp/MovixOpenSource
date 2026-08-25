import { ageMap, allAgesCerts } from './certificationUtils';

const TMDB_API_KEY = import.meta.env.VITE_TMDB_API_KEY || '';
const TMDB_API_BASE_URL = 'https://api.themoviedb.org/3';
const CACHE_PREFIX = 'movix_content_age_v1_';
const VERIFIED_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const UNKNOWN_CACHE_TTL_MS = 60 * 60 * 1000;
const MAX_CONCURRENT_REQUESTS = 6;

export type AgeClassifiableMediaType = 'movie' | 'tv';

/** Minimal shape shared by TMDB lists, watchlists and search results. */
export interface AgeClassifiableContent {
  id: number;
  media_type?: string;
  type?: string;
  adult?: boolean;
}

interface CachedAge {
  age: number | null;
  cachedAt: number;
}

const inFlightRequests = new Map<string, Promise<number | null>>();
const queuedRequests: Array<() => void> = [];
let activeRequests = 0;

const runNextRequest = () => {
  if (activeRequests >= MAX_CONCURRENT_REQUESTS) return;
  const next = queuedRequests.shift();
  if (next) next();
};

const scheduleRequest = <T>(request: () => Promise<T>): Promise<T> => new Promise((resolve, reject) => {
  const execute = () => {
    activeRequests += 1;
    request().then(resolve, reject).finally(() => {
      activeRequests -= 1;
      runNextRequest();
    });
  };

  if (activeRequests < MAX_CONCURRENT_REQUESTS) execute();
  else queuedRequests.push(execute);
});

export const getContentMediaType = (content: AgeClassifiableContent): AgeClassifiableMediaType | null => {
  const mediaType = content.media_type || content.type;
  return mediaType === 'movie' || mediaType === 'tv' ? mediaType : null;
};

export const getContentAgeKey = (content: AgeClassifiableContent): string => {
  const mediaType = getContentMediaType(content) || content.media_type || content.type || 'other';
  return `${mediaType}:${content.id}:${content.adult === true ? 'adult' : 'standard'}`;
};

const getCertificationAge = (certification: unknown): number | null => {
  if (typeof certification !== 'string') return null;
  const normalized = certification.trim().toUpperCase();
  if (!normalized) return null;
  if (allAgesCerts.has(normalized)) return 0;
  return ageMap[normalized] ?? null;
};

const getCachedAge = (key: string): number | null | undefined => {
  if (typeof sessionStorage === 'undefined') return undefined;
  try {
    const raw = sessionStorage.getItem(`${CACHE_PREFIX}${key}`);
    if (!raw) return undefined;
    const cached = JSON.parse(raw) as CachedAge;
    if (!cached || typeof cached.cachedAt !== 'number' || (cached.age !== null && typeof cached.age !== 'number')) {
      return undefined;
    }
    const ttl = cached.age === null ? UNKNOWN_CACHE_TTL_MS : VERIFIED_CACHE_TTL_MS;
    if (Date.now() - cached.cachedAt > ttl) {
      sessionStorage.removeItem(`${CACHE_PREFIX}${key}`);
      return undefined;
    }
    return cached.age;
  } catch {
    return undefined;
  }
};

const cacheAge = (key: string, age: number | null) => {
  if (typeof sessionStorage === 'undefined') return;
  try {
    sessionStorage.setItem(`${CACHE_PREFIX}${key}`, JSON.stringify({ age, cachedAt: Date.now() } satisfies CachedAge));
  } catch {
    // Storage can be unavailable in private browsing; the in-memory request
    // deduplication still prevents duplicate calls during this session.
  }
};

const getMovieCertificationAge = async (id: number): Promise<number | null> => {
  const response = await fetch(`${TMDB_API_BASE_URL}/movie/${id}/release_dates?api_key=${encodeURIComponent(TMDB_API_KEY)}`);
  if (!response.ok) return null;
  const data = await response.json() as { results?: Array<{ iso_3166_1?: string; release_dates?: Array<{ certification?: string; type?: number }> }> };
  const regions = data.results || [];
  const preferredRegions = ['FR', 'US', 'GB', 'CA'];
  const orderedRegions = [
    ...preferredRegions.map((region) => regions.find((entry) => entry.iso_3166_1 === region)).filter(Boolean),
    ...regions.filter((entry) => !preferredRegions.includes(entry.iso_3166_1 || '')),
  ] as Array<{ release_dates?: Array<{ certification?: string; type?: number }> }>;

  for (const region of orderedRegions) {
    const releases = region.release_dates || [];
    const preferredRelease = releases.find((release) => (release.type === 3 || release.type === 2) && release.certification?.trim())
      || releases.find((release) => release.certification?.trim());
    const age = getCertificationAge(preferredRelease?.certification);
    if (age !== null) return age;
  }
  return null;
};

const getTvCertificationAge = async (id: number): Promise<number | null> => {
  const response = await fetch(`${TMDB_API_BASE_URL}/tv/${id}/content_ratings?api_key=${encodeURIComponent(TMDB_API_KEY)}`);
  if (!response.ok) return null;
  const data = await response.json() as { results?: Array<{ iso_3166_1?: string; rating?: string }> };
  const ratings = data.results || [];
  const preferredRegions = ['FR', 'US', 'GB', 'CA', 'JP'];
  const orderedRatings = [
    ...preferredRegions.map((region) => ratings.find((entry) => entry.iso_3166_1 === region)).filter(Boolean),
    ...ratings.filter((entry) => !preferredRegions.includes(entry.iso_3166_1 || '')),
  ] as Array<{ rating?: string }>;

  for (const rating of orderedRatings) {
    const age = getCertificationAge(rating.rating);
    if (age !== null) return age;
  }
  return null;
};

/**
 * Resolves the TMDB age classification for one movie or series. Results are
 * shared between mounted lists and cached for the rest of the browser session.
 */
export const getContentAge = (content: AgeClassifiableContent): Promise<number | null> => {
  if (content.adult === true) return Promise.resolve(18);

  const mediaType = getContentMediaType(content);
  if (!mediaType || !Number.isFinite(content.id)) return Promise.resolve(null);

  const key = `${mediaType}:${content.id}`;
  const cached = getCachedAge(key);
  if (cached !== undefined) return Promise.resolve(cached);

  const existing = inFlightRequests.get(key);
  if (existing) return existing;

  const request = scheduleRequest(async () => {
    if (!TMDB_API_KEY) return null;
    try {
      const age = mediaType === 'movie'
        ? await getMovieCertificationAge(content.id)
        : await getTvCertificationAge(content.id);
      cacheAge(key, age);
      return age;
    } catch {
      return null;
    }
  }).finally(() => {
    inFlightRequests.delete(key);
  });

  inFlightRequests.set(key, request);
  return request;
};

/**
 * Content with no verified rating is hidden for minor profiles. This fails
 * safely when TMDB has no classification instead of briefly exposing a title
 * before the verification request completes. An 18+ profile can still see an
 * unrated title, while `adult: true` is always handled as 18.
 */
export const isContentAllowedForAge = (age: number | null, ageRestriction: number): boolean => {
  if (!ageRestriction || ageRestriction <= 0) return true;
  if (age === null) return ageRestriction >= 18;
  return age <= ageRestriction;
};

export const filterContentByAge = async <T extends AgeClassifiableContent>(
  content: readonly T[],
  ageRestriction: number,
): Promise<T[]> => {
  if (!ageRestriction || ageRestriction <= 0) return [...content];

  const checks = await Promise.all(content.map(async (item) => {
    // TMDB provides no classification endpoint for collections and other
    // groupings. For a minor profile, hide an unclassifiable card rather than
    // risking an adult collection artwork or title. Collection pages that have
    // their movie parts available classify those parts individually instead.
    if (!getContentMediaType(item)) return ageRestriction >= 18 && item.adult !== true;
    const age = await getContentAge(item);
    return isContentAllowedForAge(age, ageRestriction);
  }));

  return content.filter((_, index) => checks[index]);
};
