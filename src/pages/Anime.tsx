import React, { useCallback, useEffect, useMemo, useState } from 'react';
import axios from 'axios';
import { useTranslation } from 'react-i18next';
import HeroSlider from '../components/HeroSlider';
import EmblaCarousel from '../components/EmblaCarousel';
import HeroSkeleton from '../components/skeletons/HeroSkeleton';
import ContentRowSkeleton from '../components/skeletons/ContentRowSkeleton';
import EmblaCarouselGenres from '../components/EmblaCarouselGenres';
import LazySection from '../components/LazySection';
import TelegramPromotion from '../components/TelegramPromotion';
import { useWrappedTracker } from '../hooks/useWrappedTracker';
import { getTmdbLanguage } from '../i18n';
import { getNumericAge } from '../utils/certificationUtils';
import { resolveTmdbKeywordId } from '../utils/tmdbKeywords';

const TMDB_API_KEY = import.meta.env.VITE_TMDB_API_KEY || '';
const IMMEDIATE_LOAD_COUNT = 2;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const DATA_CACHE_TTL_MS = 15 * 60 * 1000;
const MATURE_ANIME_AGE_THRESHOLD = 17;
const CONTENT_RATING_REGION_PRIORITY = ['FR', 'US', 'JP', 'GB', 'CA'] as const;
const CONTENT_RATING_CACHE_PREFIX = 'movix_anime_content_rating_';
const CONTENT_RATING_CONCURRENCY = 12;

interface AnimeShow {
  id: number;
  name: string;
  overview: string;
  poster_path: string;
  backdrop_path: string;
  vote_average: number;
  vote_count?: number;
  popularity?: number;
  first_air_date: string;
  genre_ids?: number[];
  media_type?: 'tv';
}

interface Category {
  id: string;
  title: string;
  items: AnimeShow[];
}

const ANIME_GENRE_CONFIG = [
  { id: 16, labelKey: 'genres.id_16', route: '/genre/anime/16', discoverGenres: '16' },
  { id: 10759, labelKey: 'genres.id_10759', route: '/genre/anime/10759', discoverGenres: '16,10759' },
  { id: 10765, labelKey: 'genres.id_10765', route: '/genre/anime/10765', discoverGenres: '16,10765' },
  { id: 35, labelKey: 'genres.id_35', route: '/genre/anime/35', discoverGenres: '16,35' },
  { id: 18, labelKey: 'genres.id_18', route: '/genre/anime/18', discoverGenres: '16,18' },
  { id: 9648, labelKey: 'genres.id_9648', route: '/genre/anime/9648', discoverGenres: '16,9648' },
  { id: 10751, labelKey: 'genres.id_10751', route: '/genre/anime/10751', discoverGenres: '16,10751' },
  { id: 10762, labelKey: 'genres.id_10762', route: '/genre/anime/10762', discoverGenres: '16,10762' },
] as const;

const CATEGORY_PRIORITY = [10759, 10765, 35, 18, 9648, 10751, 10762];

const pageStyles = `
@keyframes fadeInTitle {
  0% { opacity: 0; transform: translateY(10px); }
  100% { opacity: 1; transform: translateY(0); }
}

@keyframes expandWidth {
  0% { width: 0; }
  100% { width: 40px; }
}

.section-title {
  font-size: 1.5rem;
  font-weight: 700;
  position: relative;
  background: linear-gradient(90deg, #ffffff, #e2e2e2);
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
  text-shadow: 0px 2px 4px rgba(0, 0, 0, 0.3);
  letter-spacing: 0.5px;
  padding-bottom: 0.5rem;
  text-transform: uppercase;
  display: inline-block;
  animation: fadeInTitle 0.8s ease-out forwards;
  transition: all 0.3s ease;
}

.section-title:hover {
  background: linear-gradient(90deg, #ff3333, #ff9999);
  -webkit-background-clip: text;
  background-clip: text;
  transform: translateY(-2px);
  text-shadow: 0px 4px 8px rgba(255, 51, 51, 0.4);
}

.section-title::after {
  content: '';
  position: absolute;
  left: 0;
  bottom: 0;
  width: 40px;
  height: 3px;
  background: linear-gradient(90deg, #f11 0%, #f66 100%);
  border-radius: 3px;
  animation: expandWidth 0.6s ease-out forwards 0.3s;
  transform-origin: left;
  transition: all 0.3s ease;
}

.section-title:hover::after {
  width: 100%;
  background: linear-gradient(90deg, #ff3333, #ff9999);
}
`;

const uniqueById = (items: AnimeShow[]) =>
  items.filter((item, index, self) => index === self.findIndex((candidate) => candidate.id === item.id));

const isValidAnimeShow = (show: AnimeShow) =>
  Boolean(show?.id && show?.name && show?.poster_path && show?.overview?.trim());

const getAnimeReleaseTimestamp = (show: AnimeShow) => {
  if (!show.first_air_date) {
    return 0;
  }

  const timestamp = new Date(show.first_air_date).getTime();
  return Number.isNaN(timestamp) ? 0 : timestamp;
};

const compareAnimeTitles = (left: AnimeShow, right: AnimeShow) =>
  left.name.localeCompare(right.name, undefined, { sensitivity: 'base', numeric: true });

const compareAnimeByPopularity = (left: AnimeShow, right: AnimeShow) => {
  const popularityDiff = (right.popularity ?? 0) - (left.popularity ?? 0);
  if (popularityDiff !== 0) {
    return popularityDiff;
  }

  const voteCountDiff = (right.vote_count ?? 0) - (left.vote_count ?? 0);
  if (voteCountDiff !== 0) {
    return voteCountDiff;
  }

  const ratingDiff = (right.vote_average ?? 0) - (left.vote_average ?? 0);
  if (ratingDiff !== 0) {
    return ratingDiff;
  }

  return compareAnimeTitles(left, right);
};

const compareAnimeByRecent = (left: AnimeShow, right: AnimeShow) => {
  const dateDiff = getAnimeReleaseTimestamp(right) - getAnimeReleaseTimestamp(left);
  if (dateDiff !== 0) {
    return dateDiff;
  }

  return compareAnimeByPopularity(left, right);
};

const buildAnimeDiscoverParams = (
  language: string,
  keywordId: number | null,
  overrides: Record<string, string | number | boolean> = {},
) => ({
  api_key: TMDB_API_KEY,
  language,
  include_adult: false,
  with_genres: '16',
  sort_by: 'popularity.desc',
  'vote_count.gte': 25,
  ...(keywordId ? { with_keywords: String(keywordId) } : {}),
  ...overrides,
});

const getPreferredContentCertification = (contentRatings: Array<{ iso_3166_1?: string; rating?: string }>) => {
  for (const region of CONTENT_RATING_REGION_PRIORITY) {
    const match = contentRatings.find((item) => item.iso_3166_1 === region && item.rating);
    if (match?.rating) {
      return match.rating;
    }
  }

  const fallback = contentRatings.find((item) => item.rating);
  return fallback?.rating || '';
};

const getCachedContentAge = (showId: number) => {
  try {
    const cachedValue = sessionStorage.getItem(`${CONTENT_RATING_CACHE_PREFIX}${showId}`);
    if (!cachedValue) {
      return null;
    }

    const parsedValue = JSON.parse(cachedValue) as { age?: number };
    return typeof parsedValue.age === 'number' ? parsedValue.age : null;
  } catch {
    return null;
  }
};

const setCachedContentAge = (showId: number, age: number) => {
  try {
    sessionStorage.setItem(`${CONTENT_RATING_CACHE_PREFIX}${showId}`, JSON.stringify({ age }));
  } catch {
    // Ignore cache write failures.
  }
};

const getAnimeContentAge = async (showId: number) => {
  const cachedAge = getCachedContentAge(showId);
  if (cachedAge !== null) {
    return cachedAge;
  }

  try {
    const response = await axios.get(`https://api.themoviedb.org/3/tv/${showId}/content_ratings`, {
      params: {
        api_key: TMDB_API_KEY,
      },
    });

    const contentRatings = Array.isArray(response.data?.results) ? response.data.results : [];
    const certification = getPreferredContentCertification(contentRatings);
    const age = certification ? getNumericAge(certification) : 0;
    setCachedContentAge(showId, age);
    return age;
  } catch {
    setCachedContentAge(showId, 0);
    return 0;
  }
};

const filterMatureAnime = async (items: AnimeShow[]) => {
  const results: AnimeShow[] = [];

  for (let index = 0; index < items.length; index += CONTENT_RATING_CONCURRENCY) {
    const chunk = items.slice(index, index + CONTENT_RATING_CONCURRENCY);
    const ages = await Promise.all(chunk.map((item) => getAnimeContentAge(item.id)));

    chunk.forEach((item, chunkIndex) => {
      if (ages[chunkIndex] < MATURE_ANIME_AGE_THRESHOLD) {
        results.push(item);
      }
    });
  }

  return results;
};

const Anime: React.FC = () => {
  const { t, i18n } = useTranslation();
  const tmdbLanguage = getTmdbLanguage();
  const [animeShows, setAnimeShows] = useState<AnimeShow[]>([]);
  const [featuredShows, setFeaturedShows] = useState<AnimeShow[]>([]);
  const [topContent, setTopContent] = useState<AnimeShow[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [genreImages, setGenreImages] = useState<Record<number, string | undefined>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const dataCacheKey = `movix_anime_data_v2_${tmdbLanguage}`;
  const dataCacheTsKey = `${dataCacheKey}_timestamp`;
  const genreImageCacheKey = `movix_anime_genre_images_v2_${tmdbLanguage}`;
  const genreImageCacheTsKey = `${genreImageCacheKey}_timestamp`;

  useWrappedTracker({
    mode: 'page',
    pageData: { pageName: 'anime' },
  });

  const getGenreLabel = useCallback((genreId: number) => {
    return t(`genres.id_${genreId}`, { defaultValue: `Genre ${genreId}` });
  }, [t]);

  const genreItems = useMemo(() => {
    return ANIME_GENRE_CONFIG.map((genre) => ({
      id: genre.id,
      name: t(genre.labelKey),
      route: genre.route,
      imageUrl: genreImages[genre.id],
    }));
  }, [genreImages, t]);

  const organizeContentByCategories = useCallback((items: AnimeShow[]) => {
    const filteredItems = uniqueById(items).filter(isValidAnimeShow);
    const genreMap: Record<number, AnimeShow[]> = {};

    filteredItems.forEach((item) => {
      item.genre_ids?.forEach((genreId) => {
        if (genreId === 16) {
          return;
        }

        if (!genreMap[genreId]) {
          genreMap[genreId] = [];
        }

        if (!genreMap[genreId].some((show) => show.id === item.id)) {
          genreMap[genreId].push(item);
        }
      });
    });

    const priorityMap = new Map(CATEGORY_PRIORITY.map((id, index) => [id, index]));
    const rawGenreCategories = Object.entries(genreMap)
      .map(([genreId, genreItems]) => {
        const sortedItems = [...genreItems].sort(compareAnimeByPopularity);
        const priorityIndex = priorityMap.get(Number(genreId));
        const priorityBoost = priorityIndex === undefined ? 0 : (CATEGORY_PRIORITY.length - priorityIndex) * 5;

        return {
          id: genreId,
          title: getGenreLabel(Number(genreId)),
          items: sortedItems.slice(0, 15),
          score: sortedItems.length + priorityBoost,
        };
      })
      .filter((category) => category.items.length >= 3)
      .sort((left, right) => right.score - left.score);

    const usedShowIds = new Set<number>();
    const genreCategories = rawGenreCategories
      .map(({ id, title, items }) => {
        const distinctItems = items
          .filter((item) => !usedShowIds.has(item.id))
          .slice(0, 15);

        distinctItems.forEach((item) => {
          usedShowIds.add(item.id);
        });

        return { id, title, items: distinctItems };
      })
      .filter((category) => category.items.length >= 4)
      .slice(0, 6)
      .map(({ id, title, items }) => ({ id, title, items }));

    const recentShows = filteredItems
      .filter((item) => Boolean(item.first_air_date))
      .sort(compareAnimeByRecent)
      .slice(0, 15);

    const nextCategories: Category[] = [];
    if (recentShows.length >= 5) {
      nextCategories.push({
        id: 'recent-anime',
        title: t('animePage.recentAnime'),
        items: recentShows,
      });
    }

    nextCategories.push(...genreCategories);
    setCategories(nextCategories);
  }, [getGenreLabel, t]);

  const fetchAnimeShows = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);

      const cachedData = sessionStorage.getItem(dataCacheKey);
      const cacheTimestamp = sessionStorage.getItem(dataCacheTsKey);

      if (cachedData && cacheTimestamp) {
        const isRecent = (Date.now() - Number(cacheTimestamp)) < DATA_CACHE_TTL_MS;
        if (isRecent) {
          const parsedData = JSON.parse(cachedData);
          setFeaturedShows(parsedData.featuredShows || []);
          setTopContent(parsedData.topContent || []);
          setAnimeShows(parsedData.animeShows || []);

          if (Array.isArray(parsedData.animeShows) && parsedData.animeShows.length > 0) {
            organizeContentByCategories(parsedData.animeShows);
          }

          setLoading(false);
          return;
        }
      }

      const animeKeywordId = await resolveTmdbKeywordId('anime', tmdbLanguage);

      const discoverRequests = [
        ...Array.from({ length: 3 }, (_, index) =>
          axios.get('https://api.themoviedb.org/3/discover/tv', {
            params: buildAnimeDiscoverParams(tmdbLanguage, animeKeywordId, {
              page: index + 1,
            }),
          }),
        ),
        ...ANIME_GENRE_CONFIG.filter((genre) => genre.id !== 16).map((genre) =>
          axios.get('https://api.themoviedb.org/3/discover/tv', {
            params: buildAnimeDiscoverParams(tmdbLanguage, animeKeywordId, {
              page: 1,
              with_genres: genre.discoverGenres,
            }),
          }),
        ),
      ];

      const responses = await Promise.all(discoverRequests);
      const allShows = uniqueById(
        responses.flatMap((response) =>
          (response.data?.results || [])
            .filter(isValidAnimeShow)
            .map((show: AnimeShow) => ({
              ...show,
              media_type: 'tv',
            })),
        ),
      ).sort(compareAnimeByPopularity);
      const safeShows = await filterMatureAnime(allShows);

      const heroShows = safeShows
        .filter((show) => show.backdrop_path && show.overview)
        .slice(0, 8);
      const topAnime = safeShows.slice(0, 15);

      setFeaturedShows(heroShows);
      setTopContent(topAnime);
      setAnimeShows(safeShows);
      organizeContentByCategories(safeShows);

      sessionStorage.setItem(dataCacheKey, JSON.stringify({
        featuredShows: heroShows,
        topContent: topAnime,
        animeShows: safeShows,
      }));
      sessionStorage.setItem(dataCacheTsKey, Date.now().toString());
    } catch (fetchError) {
      console.error('Error fetching anime shows:', fetchError);
      setError(t('home.errorLoadingData'));
    } finally {
      setLoading(false);
    }
  }, [dataCacheKey, dataCacheTsKey, organizeContentByCategories, t, tmdbLanguage]);

  useEffect(() => {
    fetchAnimeShows();
  }, [fetchAnimeShows]);

  useEffect(() => {
    const loadGenreImages = async () => {
      try {
        const cachedImages = sessionStorage.getItem(genreImageCacheKey);
        const cachedTimestamp = sessionStorage.getItem(genreImageCacheTsKey);

        if (cachedImages && cachedTimestamp && (Date.now() - Number(cachedTimestamp)) < ONE_DAY_MS) {
          setGenreImages(JSON.parse(cachedImages));
          return;
        }

        const animeKeywordId = await resolveTmdbKeywordId('anime', tmdbLanguage);
        const imageEntries = await Promise.all(
          ANIME_GENRE_CONFIG.map(async (genre) => {
            try {
              const response = await axios.get('https://api.themoviedb.org/3/discover/tv', {
                params: buildAnimeDiscoverParams(tmdbLanguage, animeKeywordId, {
                  with_genres: genre.discoverGenres,
                  page: 1,
                }),
              });

              const candidateShows = Array.isArray(response.data?.results)
                ? response.data.results.filter((show: AnimeShow) => show.backdrop_path || show.poster_path)
                : [];
              const safeCandidateShows = await filterMatureAnime(candidateShows);
              const firstVisual = safeCandidateShows[0] || null;
              const imagePath = firstVisual?.backdrop_path || firstVisual?.poster_path || '';

              return [genre.id, imagePath ? `https://image.tmdb.org/t/p/w780${imagePath}` : undefined] as const;
            } catch {
              return [genre.id, undefined] as const;
            }
          }),
        );

        const nextImages = Object.fromEntries(imageEntries);
        setGenreImages(nextImages);
        sessionStorage.setItem(genreImageCacheKey, JSON.stringify(nextImages));
        sessionStorage.setItem(genreImageCacheTsKey, Date.now().toString());
      } catch {
        // Ignore genre image loading failures.
      }
    };

    loadGenreImages();
  }, [genreImageCacheKey, genreImageCacheTsKey, tmdbLanguage]);

  useEffect(() => {
    document.title = `${t('animePage.title')} - Movix`;
  }, [i18n.language, t]);

  if (error) {
    return (
      <div className="flex items-center justify-center h-screen">
        <div className="bg-red-600/10 text-red-600 px-6 py-4 rounded-lg">
          {error}
        </div>
      </div>
    );
  }

  if (loading && animeShows.length === 0) {
    return (
      <div className="min-h-screen bg-black text-white">
        <div className="relative w-full pt-16 md:pt-20 lg:pt-24">
          <HeroSkeleton />
        </div>
        <div className="container mx-auto px-4 py-8 space-y-8">
          <ContentRowSkeleton />
          <ContentRowSkeleton />
          <ContentRowSkeleton />
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-black text-white">
      <style>{pageStyles}</style>

      <div className="relative w-full pt-16 md:pt-20 lg:pt-24">
        {featuredShows.length > 0 && (
          <HeroSlider
            items={featuredShows.map((show) => ({ ...show, media_type: 'tv' }))}
          />
        )}
      </div>

      <div className="w-full bg-black py-6 relative mt-8 z-[20] px-4 md:px-8">
        <EmblaCarouselGenres
          title={<span><span className="text-white mr-2">🧭</span><span>{t('genres.findByGenre')}</span></span>}
          items={genreItems}
        />
      </div>

      <div className="pb-12 -mt-4 relative z-[20]">
        {topContent.length > 0 && (
          <div className="px-4 md:px-8">
            <LazySection index={0} immediateLoadCount={IMMEDIATE_LOAD_COUNT}>
              <EmblaCarousel
                title={<span><span className="text-red-600 mr-2">🔥</span><span>{t('animePage.trending')}</span></span>}
                items={topContent.map((item) => ({
                  ...item,
                  media_type: 'tv',
                  poster_path: item.poster_path || '',
                  backdrop_path: item.backdrop_path || '',
                  overview: item.overview || '',
                }))}
                mediaType="anime-trending"
                showRanking={true}
              />
            </LazySection>
          </div>
        )}

        {categories.map((category, index) => (
          <div key={`wrap-${category.id}`} className="px-4 md:px-8">
            <LazySection key={category.id} index={1 + index} immediateLoadCount={IMMEDIATE_LOAD_COUNT}>
              <EmblaCarousel
                title={category.title}
                items={category.items.map((item) => ({
                  ...item,
                  media_type: 'tv',
                  poster_path: item.poster_path || '',
                  backdrop_path: item.backdrop_path || '',
                  overview: item.overview || '',
                }))}
                mediaType={category.id}
              />
            </LazySection>
          </div>
        ))}

        <TelegramPromotion />
      </div>
    </div>
  );
};

export default Anime;
