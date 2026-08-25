/**
 * Champ titre avec proposition de titres du catalogue.
 *
 * La saisie reste libre — on ajoute au calendrier des choses qui n'existent
 * dans aucune base — mais choisir une fiche existante remplit le titre, y
 * rattache l'affiche et la page du site, et devine la catégorie. Ça évite de
 * ressaisir « The Lord of the Rings: The Fellowship of the Ring » à la main.
 *
 * La recherche passe par l'instance axios sur laquelle le cache HTTP est
 * installé : deux frappes identiques ne déclenchent qu'une requête, et
 * revenir sur une recherche déjà faite est instantané.
 */
import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { Loader2, Search, X } from 'lucide-react';
import axios from 'axios';
import { getTmdbLanguage } from '../../i18n';
import { encodeId } from '../../utils/idEncoder';
import { CATEGORY_ACCENT } from './categoryAccent';
import type { CalendarCategory, CalendarMediaLink } from '../../types/calendar';
import { getOverlayPortalRoot } from '../../utils/overlayPortal';

const TMDB_API_KEY = import.meta.env.VITE_TMDB_API_KEY || '';

/**
 * Attente après la dernière frappe. Assez court pour paraître instantané,
 * assez long pour ne pas interroger TMDB à chaque lettre d.un titre long.
 */
const DEBOUNCE_MS = 250;

/** En deçà, une recherche ne rapporte que du bruit. */
const MIN_QUERY_LENGTH = 2;

const MAX_SUGGESTIONS = 6;

interface TmdbSearchResult {
  id: number;
  media_type?: string;
  title?: string;
  name?: string;
  poster_path?: string | null;
  release_date?: string;
  first_air_date?: string;
  genre_ids?: number[];
  original_language?: string;
}

export interface TitleSelection {
  title: string;
  link: CalendarMediaLink;
  category: CalendarCategory;
  /** `YYYY-MM-DD` de sortie, quand TMDB la connaît. */
  releaseDate?: string;
  href: string;
}

const TMDB_GENRE_ANIMATION = 16;
const TMDB_GENRE_DOCUMENTARY = 99;

/**
 * Catégorie déduite d'une fiche. L'animation japonaise devient « Anime », le
 * reste de l'animation reste film ou série — un Pixar n'est pas un anime.
 */
const categoryOf = (result: TmdbSearchResult): CalendarCategory => {
  const genres = result.genre_ids ?? [];
  if (genres.includes(TMDB_GENRE_DOCUMENTARY)) return 'documentary';
  if (genres.includes(TMDB_GENRE_ANIMATION) && result.original_language === 'ja') return 'anime';
  return result.media_type === 'tv' ? 'tv' : 'movie';
};

interface CalendarTitleFieldProps {
  value: string;
  onChange: (value: string) => void;
  onSelect: (selection: TitleSelection) => void;
  /** Rattachement courant, pour proposer de le retirer. */
  linked?: CalendarMediaLink;
  onUnlink: () => void;
  invalid?: boolean;
  id?: string;
}

const CalendarTitleField: React.FC<CalendarTitleFieldProps> = ({
  value, onChange, onSelect, linked, onUnlink, invalid, id,
}) => {
  const { t } = useTranslation();
  const [results, setResults] = useState<TmdbSearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  /** Requête déjà servie par la liste affichée, pour ne pas la refaire. */
  const servedQuery = useRef('');

  useEffect(() => {
    const query = value.trim();
    // Une fiche rattachée signifie que l'utilisateur a déjà choisi : on ne lui
    // repropose pas la liste tant qu'il ne modifie pas le titre.
    if (linked || query.length < MIN_QUERY_LENGTH || query === servedQuery.current) {
      if (query.length < MIN_QUERY_LENGTH) setResults([]);
      return;
    }

    let cancelled = false;
    const timer = setTimeout(async () => {
      if (!TMDB_API_KEY) return;
      setLoading(true);
      try {
        const response = await axios.get<{ results?: TmdbSearchResult[] }>(
          'https://api.themoviedb.org/3/search/multi',
          { params: { api_key: TMDB_API_KEY, language: getTmdbLanguage(), query, include_adult: false, page: 1 } },
        );
        if (cancelled) return;
        servedQuery.current = query;
        setResults((response.data.results ?? [])
          .filter((item) => item.media_type === 'movie' || item.media_type === 'tv')
          .slice(0, MAX_SUGGESTIONS));
        setOpen(true);
      } catch {
        if (!cancelled) setResults([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, DEBOUNCE_MS);

    return () => { cancelled = true; clearTimeout(timer); };
  }, [value, linked]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (panelRef.current?.contains(target) || anchor?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown, true);
    return () => document.removeEventListener('mousedown', onPointerDown, true);
  }, [open, anchor]);

  const rect = anchor?.getBoundingClientRect();

  const choose = (result: TmdbSearchResult) => {
    const title = result.title ?? result.name ?? '';
    const mediaType = result.media_type === 'tv' ? 'tv' : 'movie';
    servedQuery.current = title;
    onSelect({
      title,
      link: { mediaType, tmdbId: result.id, posterPath: result.poster_path ?? null },
      category: categoryOf(result),
      releaseDate: (result.release_date || result.first_air_date || '').slice(0, 10) || undefined,
      href: `/${mediaType}/${encodeId(result.id)}`,
    });
    setOpen(false);
  };

  return (
    <>
      <div ref={setAnchor} className="relative">
        <input
          id={id}
          value={value}
          onChange={(event) => { onChange(event.target.value); if (linked) onUnlink(); }}
          onFocus={() => { if (results.length > 0 && !linked) setOpen(true); }}
          placeholder={t('calendar.fieldTitlePlaceholder')}
          autoComplete="off"
          className={`flex h-10 w-full rounded-lg border bg-white/5 px-3 pr-10 text-sm text-white placeholder:text-white/40 transition-all duration-200 hover:bg-white/[0.07] focus:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500/50 ${
            invalid ? 'border-red-500/60' : 'border-white/10'
          }`}
        />
        <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center">
          {loading
            ? <Loader2 className="h-4 w-4 animate-spin text-white/40" />
            : <Search className="h-4 w-4 text-white/30" />}
        </span>
      </div>

      {linked && (
        <button
          type="button"
          onClick={onUnlink}
          className="mt-2 inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 py-1 pl-1 pr-3 text-xs text-white/60 transition-colors hover:bg-white/10 hover:text-white"
        >
          {linked.posterPath
            ? <img src={`https://image.tmdb.org/t/p/w92${linked.posterPath}`} alt="" loading="lazy" decoding="async" className="h-6 w-4 rounded-sm object-cover" />
            : <span className="h-6 w-4 rounded-sm bg-white/10" />}
          {t('calendar.linkedToCatalog')}
          <X className="h-3 w-3" />
        </button>
      )}

      {createPortal(
        <AnimatePresence>
          {open && results.length > 0 && rect && (
            <motion.div
              ref={panelRef}
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={{ duration: 0.14, ease: 'easeOut' }}
              data-lenis-prevent
              style={{
                position: 'fixed',
                top: rect.bottom + 6,
                left: Math.max(8, Math.min(rect.left, window.innerWidth - rect.width - 8)),
                width: rect.width,
                zIndex: 100010,
              }}
              className="max-h-72 overflow-y-auto overscroll-contain rounded-xl border border-white/10 bg-gray-900 p-1 shadow-2xl shadow-black/60"
            >
              {results.map((result) => {
                const title = result.title ?? result.name ?? '';
                const year = (result.release_date || result.first_air_date || '').slice(0, 4);
                const category = categoryOf(result);
                return (
                  <button
                    key={`${result.media_type}-${result.id}`}
                    type="button"
                    onClick={() => choose(result)}
                    className="flex w-full items-center gap-3 rounded-lg p-2 text-left transition-colors hover:bg-white/10"
                  >
                    {result.poster_path ? (
                      <img src={`https://image.tmdb.org/t/p/w92${result.poster_path}`} alt=""
                        loading="lazy" decoding="async" className="h-12 w-8 shrink-0 rounded object-cover" />
                    ) : (
                      <span className="h-12 w-8 shrink-0 rounded bg-white/5" />
                    )}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm text-white">{title}</span>
                      <span className="flex items-center gap-1.5 text-xs text-white/40">
                        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${CATEGORY_ACCENT[category].dot}`} />
                        {t(`calendar.category.${category}`)}
                        {year ? ` · ${year}` : ''}
                      </span>
                    </span>
                  </button>
                );
              })}
            </motion.div>
          )}
        </AnimatePresence>,
        getOverlayPortalRoot(),
      )}
    </>
  );
};

export default CalendarTitleField;
