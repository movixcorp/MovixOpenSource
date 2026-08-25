import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import {
  ArrowLeft, CalendarDays, CalendarPlus, ChevronLeft, ChevronRight,
  Clock, Loader2, ListOrdered, LayoutGrid, Search, SlidersHorizontal, X,
} from 'lucide-react';
import SEO from '../components/SEO';
import { Button } from '../components/ui/button';
import { SquareBackground } from '../components/ui/square-background';
import CalendarEntryDialog from '../components/calendar/CalendarEntryDialog';
import CalendarPoster from '../components/calendar/CalendarPoster';
import { CALENDAR_CATEGORIES, CATEGORY_ACCENT } from '../components/calendar/categoryAccent';
import {
  buildCalendarOccurrences, monthWindow, readCachedCalendarOccurrences,
} from '../services/calendarService';
import {
  addCalendarEntry, expandCalendarEntries, parseDateKey, readCalendarEntries,
  removeCalendarEntry, toDateKey, todayKey, updateCalendarEntry,
  type CalendarEntryDraft,
} from '../utils/calendarEntries';
import type {
  CalendarOccurrence, CalendarPreferences,
  CalendarSource, UserCalendarEntry,
} from '../types/calendar';

/**
 * Version 4 : les séries en diffusion sont une source à part entière, et les
 * réglages retiennent désormais quelles sources leur ont été proposées (voir
 * `knownSources`). Les v2 et v3 décrivent un écran qui n'existe plus — nouvelle
 * clé, tout le monde repart des valeurs par défaut une fois, et les choix
 * suivants sont conservés.
 */
const PREFS_KEY = 'calendarPreferences.v4';

/** Les deux sources publiques en tête : ce sont elles qui remplissent la page par défaut. */
const ALL_SOURCES: CalendarSource[] = [
  'newReleases', 'airingEpisodes', 'watchlistEpisodes', 'watchlistMovies',
  'alerts', 'continueWatching', 'custom',
];

/**
 * Ligne secondaire d'un événement : le sous-titre calculé (« S2E4 », « Sortie
 * cinéma ») quand il existe, sinon le libellé libre que l'utilisateur a donné à
 * sa catégorie. Une entrée personnelle sans libellé n'affiche rien : répéter
 * « Autre » sous chaque titre n'apprend rien.
 */
const secondaryLabel = (item: CalendarOccurrence): string | undefined =>
  item.subtitle || item.customCategory || undefined;

/**
 * Texte préparé pour la recherche : accents retirés, casse ignorée. « reacher »
 * doit trouver « Reacher », et « evade » trouver « Évadé ». La plage est celle
 * des diacritiques combinants que `NFD` vient de détacher.
 */
const COMBINING_MARKS = new RegExp('[\\u0300-\\u036f]', 'g');
const searchable = (value: string): string =>
  value.normalize('NFD').replace(COMBINING_MARKS, '').toLowerCase();

/**
 * Ce que voit quelqu'un qui ouvre la page sans rien avoir réglé.
 *
 * L'agenda plutôt que la grille : une page vide de douze cases blanches ne dit
 * rien à qui n'a ni watchlist ni alerte, alors qu'une liste de sorties se lit
 * tout de suite. La grille reste à un clic pour qui veut la vue d'ensemble.
 *
 * Toutes les sources sont actives, sorties du moment comprises : le calendrier
 * a quelque chose à montrer dès la première visite.
 */
const DEFAULT_PREFS: CalendarPreferences = {
  view: 'agenda',
  sources: [...ALL_SOURCES],
  categories: [...CALENDAR_CATEGORIES],
};

/**
 * Ce qui est réellement écrit en stockage.
 *
 * `knownSources` répond à une question que `sources` seule ne peut pas trancher :
 * une source absente de la liste cochée est-elle **décochée**, ou simplement
 * **plus récente que le réglage** ? Sans la distinction, toute source ajoutée
 * au calendrier naissait éteinte chez tous ceux qui avaient déjà ouvert la page
 * — la fonctionnalité était livrée et restait invisible, sans que rien ne le
 * signale. En gardant la liste telle qu'elle était au moment de l'écriture, une
 * source jamais proposée est reconnue comme nouvelle et s'active d'elle-même,
 * tandis qu'une source proposée puis décochée le reste.
 */
interface StoredPreferences extends CalendarPreferences {
  knownSources?: CalendarSource[];
}

const readPrefs = (): CalendarPreferences => {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return DEFAULT_PREFS;
    const parsed = JSON.parse(raw) as Partial<StoredPreferences>;
    const stored = parsed.sources;
    // Faute de `knownSources` — réglage écrit avant son introduction — on part
    // du principe que seules les sources cochées avaient été proposées.
    const known = Array.isArray(parsed.knownSources) ? parsed.knownSources : stored;
    return {
      view: parsed.view === 'month' ? 'month' : 'agenda',
      // Une liste vide est un choix — tout décocher — et doit être relue telle
      // quelle. Seule une valeur absente ou illisible retombe sur le défaut.
      sources: Array.isArray(stored)
        ? ALL_SOURCES.filter((source) => stored.includes(source) || !known?.includes(source))
        : DEFAULT_PREFS.sources,
      categories: Array.isArray(parsed.categories)
        ? CALENDAR_CATEGORIES.filter((category) => parsed.categories?.includes(category))
        : DEFAULT_PREFS.categories,
    };
  } catch {
    return DEFAULT_PREFS;
  }
};

/** Les six semaines affichées par la grille, lundi en tête. */
const buildMonthGrid = (year: number, month: number): Date[] => {
  const first = new Date(year, month, 1);
  // `getDay()` place dimanche à 0 : on décale pour commencer la semaine lundi.
  const offset = (first.getDay() + 6) % 7;
  const start = new Date(year, month, 1 - offset);
  return Array.from({ length: 42 }, (_, index) =>
    new Date(start.getFullYear(), start.getMonth(), start.getDate() + index));
};

const CalendarPage: React.FC = () => {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();

  const [prefs, setPrefs] = useState<CalendarPreferences>(readPrefs);
  const [cursor, setCursor] = useState(() => { const now = new Date(); return { year: now.getFullYear(), month: now.getMonth() }; });
  const [auto, setAuto] = useState<CalendarOccurrence[]>([]);
  const [entries, setEntries] = useState<UserCalendarEntry[]>(() => readCalendarEntries());
  const [loading, setLoading] = useState(true);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const [dialog, setDialog] = useState<{ open: boolean; entry: UserCalendarEntry | null; date?: string }>(
    { open: false, entry: null },
  );

  const today = todayKey();
  const locale = i18n.language || 'fr';

  useEffect(() => {
    // `knownSources` est écrit à chaque fois : c'est l'instantané des sources
    // que cet écran proposait, celui qui permettra à la relecture de
    // reconnaître une source ajoutée depuis.
    const stored: StoredPreferences = { ...prefs, knownSources: [...ALL_SOURCES] };
    try { localStorage.setItem(PREFS_KEY, JSON.stringify(stored)); } catch { /* stockage indisponible */ }
  }, [prefs]);

  const { fromKey, toKey } = useMemo(
    () => monthWindow(cursor.year, cursor.month), [cursor.year, cursor.month],
  );

  // Les sources automatiques sont refaites à chaque changement de mois ou de
  // filtre. Un mois déjà consulté est réaffiché depuis le cache de fenêtres
  // avant même que la reconstruction démarre : pas de spinner, pas de grille
  // vide entre deux mois. L'écran de chargement n'apparaît donc que la
  // première fois qu'on ouvre une fenêtre donnée.
  //
  // Une construction abandonnée n'est pas annulée, seulement ignorée : le cache
  // HTTP mutualise les requêtes simultanées vers une même URL, donc annuler
  // celle d'un mois qu'on quitte casserait celle du mois qu'on ouvre s'ils
  // partagent une série. La laisser finir remplit le cache pour le retour.
  useEffect(() => {
    let stale = false;
    const options = {
      fromKey, toKey,
      sources: prefs.sources.filter((source) => source !== 'custom'),
    };

    const cached = readCachedCalendarOccurrences(options);
    setAuto(cached ?? []);
    setLoading(cached === null);

    buildCalendarOccurrences(options)
      .then((result) => { if (!stale) setAuto(result); })
      .catch(() => { if (!stale && cached === null) setAuto([]); })
      .finally(() => { if (!stale) setLoading(false); });

    return () => { stale = true; };
  }, [fromKey, toKey, prefs.sources]);

  const refreshEntries = useCallback(() => setEntries(readCalendarEntries()), []);

  /**
   * Les deux filtres se combinent, et tous deux portent sur l'ensemble du
   * calendrier. Le filtre par catégorie ne valait auparavant que pour les
   * entrées personnelles : décocher « Film » ne retirait aucun film du
   * calendrier, ce qui donnait un réglage qui semblait ne rien faire. Chaque
   * événement portant déjà sa catégorie, quelle que soit sa source, il n'y
   * avait pas de raison de le restreindre.
   */
  const occurrences = useMemo(() => {
    const custom = prefs.sources.includes('custom')
      ? expandCalendarEntries(entries, fromKey, toKey)
      : [];
    // La recherche porte sur le titre et le sous-titre : « reacher » trouve la
    // série, « au pied du pont » trouve l'épisode. Espaces superflus ignorés.
    const needle = searchable(query.trim());

    // Au sein d'un jour : les horaires connus d'abord, puis la popularité TMDB.
    // Une case de grille ne montre que trois lignes — sans ce tri, l'épisode
    // que tout le monde attend passait derrière « +9 autres », masqué par des
    // sorties confidentielles arrivées plus tôt dans l'assemblage. Les entrées
    // personnelles n'ont pas de popularité : l'infini les garde en tête, ce
    // sont les dates de l'utilisateur.
    return [...auto, ...custom]
      .filter((item) => prefs.sources.includes(item.source))
      .filter((item) => prefs.categories.includes(item.category))
      .filter((item) => !needle
        || searchable(item.title).includes(needle)
        || (item.subtitle ? searchable(item.subtitle).includes(needle) : false))
      .sort((a, b) => {
        if (a.date !== b.date) return a.date.localeCompare(b.date);
        const byTime = (a.time ?? '99:99').localeCompare(b.time ?? '99:99');
        if (byTime !== 0) return byTime;
        const rank = (item: CalendarOccurrence): number =>
          // `MAX_VALUE` et pas l'infini : deux entrées personnelles donneraient
          // `Infinity - Infinity = NaN`, et un comparateur qui rend NaN casse le tri.
          item.source === 'custom' ? Number.MAX_VALUE : item.popularity ?? 0;
        return rank(b) - rank(a);
      });
  }, [auto, entries, fromKey, toKey, prefs.sources, prefs.categories, query]);

  /**
   * Nombre de cases décochées, toutes listes confondues. Sert à dire dans la
   * barre d'outils qu'un filtre est actif : sans ça, un calendrier vidé par un
   * réglage oublié se lit comme un calendrier sans rien dedans, panneau de
   * filtres refermé.
   */
  const hiddenFilterCount = useMemo(
    () => (ALL_SOURCES.length - prefs.sources.length)
      + (CALENDAR_CATEGORIES.length - prefs.categories.length),
    [prefs.sources, prefs.categories],
  );

  const resetFilters = useCallback(
    () => setPrefs((current) => ({
      ...current,
      sources: [...ALL_SOURCES],
      categories: [...CALENDAR_CATEGORIES],
    })),
    [],
  );

  const byDay = useMemo(() => {
    const map = new Map<string, CalendarOccurrence[]>();
    for (const item of occurrences) {
      const list = map.get(item.date);
      if (list) list.push(item); else map.set(item.date, [item]);
    }
    return map;
  }, [occurrences]);

  const monthDays = useMemo(() => buildMonthGrid(cursor.year, cursor.month), [cursor.year, cursor.month]);

  /**
   * Repères chiffrés de l'en-tête. Le total du mois est compté sur le mois
   * civil seul : la fenêtre de construction déborde de sept jours de chaque
   * côté pour remplir la grille, et compter ce débord annoncerait des sorties
   * qui n'appartiennent pas au mois affiché.
   */
  const stats = useMemo(() => {
    const firstKey = toDateKey(new Date(cursor.year, cursor.month, 1));
    const lastKey = toDateKey(new Date(cursor.year, cursor.month + 1, 0));
    const now = new Date();
    const weekEndKey = toDateKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 6));
    return {
      month: occurrences.filter((item) => item.date >= firstKey && item.date <= lastKey).length,
      today: occurrences.filter((item) => item.date === today).length,
      week: occurrences.filter((item) => item.date >= today && item.date <= weekEndKey).length,
      // « Aujourd'hui » et « cette semaine » ne sont comptés que sur la fenêtre
      // chargée, celle du mois affiché. En mars, un compteur « aujourd'hui »
      // affiché depuis le mois de mai annoncerait zéro — pas parce qu'il n'y a
      // rien, mais parce que ces jours-là ne sont pas chargés. On les masque.
      showRelative: cursor.year === now.getFullYear() && cursor.month === now.getMonth(),
    };
  }, [occurrences, cursor.year, cursor.month, today]);

  const monthLabel = useMemo(
    () => new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric' })
      .format(new Date(cursor.year, cursor.month, 1)),
    [cursor.year, cursor.month, locale],
  );

  const searchActive = query.trim().length > 0;

  /**
   * Les jours de la grille qui contiennent au moins un résultat, dans l'ordre.
   *
   * En vue mois, une recherche laissait l'essentiel de la grille vide sans dire
   * où regarder : quarante-deux cases à balayer des yeux pour trouver les trois
   * qui restent. Cette liste alimente une rangée de raccourcis cliquables — un
   * par jour — et le surlignage des cases correspondantes.
   */
  const searchHits = useMemo(() => {
    if (!searchActive) return [];
    return monthDays
      .map((day) => {
        const key = toDateKey(day);
        return { key, count: byDay.get(key)?.length ?? 0 };
      })
      .filter((hit) => hit.count > 0);
  }, [searchActive, monthDays, byDay]);

  /** « mer. 26 août » — l'étiquette courte des raccourcis de recherche. */
  const shortDayLabel = useMemo(() => {
    const formatter = new Intl.DateTimeFormat(locale, { weekday: 'short', day: 'numeric', month: 'short' });
    return (key: string): string => {
      const date = parseDateKey(key);
      return date ? formatter.format(date) : key;
    };
  }, [locale]);

  const weekdayLabels = useMemo(() => {
    const formatter = new Intl.DateTimeFormat(locale, { weekday: 'short' });
    // 2024-01-01 est un lundi : la semaine part donc du bon jour.
    return Array.from({ length: 7 }, (_, index) => formatter.format(new Date(2024, 0, 1 + index)));
  }, [locale]);

  const shiftMonth = (delta: number) => {
    setSelectedDay(null);
    setCursor((current) => {
      const next = new Date(current.year, current.month + delta, 1);
      return { year: next.getFullYear(), month: next.getMonth() };
    });
  };

  const goToday = () => {
    const now = new Date();
    setCursor({ year: now.getFullYear(), month: now.getMonth() });
    setSelectedDay(today);
  };

  const toggle = <T,>(list: T[], value: T): T[] =>
    list.includes(value) ? list.filter((item) => item !== value) : [...list, value];

  const saveEntry = (draft: CalendarEntryDraft) => {
    if (dialog.entry) updateCalendarEntry(dialog.entry.id, draft);
    else addCalendarEntry(draft);
    refreshEntries();
  };

  const deleteEntry = () => {
    if (dialog.entry) { removeCalendarEntry(dialog.entry.id); refreshEntries(); }
  };

  const openOccurrence = (occurrence: CalendarOccurrence) => {
    if (occurrence.entryId) {
      const entry = entries.find((item) => item.id === occurrence.entryId) ?? null;
      setDialog({ open: true, entry });
      return;
    }
    if (occurrence.href) navigate(occurrence.href);
  };

  const dayLabel = (key: string) => {
    const date = parseDateKey(key);
    if (!date) return key;
    return new Intl.DateTimeFormat(locale, { weekday: 'long', day: 'numeric', month: 'long' }).format(date);
  };

  /** Événements de l'agenda : à partir d'aujourd'hui si le mois affiché est le mois courant. */
  const agendaDays = useMemo(() => {
    const startKey = (cursor.year === new Date().getFullYear() && cursor.month === new Date().getMonth())
      ? today
      : toDateKey(new Date(cursor.year, cursor.month, 1));
    const endKey = toDateKey(new Date(cursor.year, cursor.month + 1, 0));
    return [...byDay.entries()]
      .filter(([key]) => key >= startKey && key <= endKey)
      .sort((a, b) => a[0].localeCompare(b[0]));
  }, [byDay, cursor.year, cursor.month, today]);

  const selectedList = selectedDay ? byDay.get(selectedDay) ?? [] : [];

  return (
    <SquareBackground squareSize={48} borderColor="rgba(239, 68, 68, 0.10)" mode="combined">
      <SEO title={t('calendar.seoTitle')} description={t('calendar.seoDescription')} />

      <motion.div
        initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.3 }}
        className="min-h-screen px-4 pb-20 pt-24 md:px-8"
      >
        <div className="mx-auto max-w-7xl">
          {/* ── En-tête ─────────────────────────────────────────────── */}
          <div className="mb-8 flex flex-wrap items-center gap-4">
            <Button variant="outline" size="icon" onClick={() => navigate(-1)} aria-label={t('common.back')}>
              <ArrowLeft className="h-5 w-5" />
            </Button>
            <div className="flex items-center gap-3">
              <div className="rounded-2xl border border-red-500/20 bg-gradient-to-br from-red-600/25 to-red-500/5 p-3">
                <CalendarDays className="h-7 w-7 text-red-400" />
              </div>
              <div>
                <h1 className="text-2xl font-bold text-white md:text-3xl">{t('calendar.title')}</h1>
                <p className="text-sm text-white/50">
                  {t('calendar.subtitle', { count: stats.month })}
                </p>
              </div>
            </div>

            <Button className="ml-auto gap-2" onClick={() => setDialog({ open: true, entry: null, date: selectedDay ?? today })}>
              <CalendarPlus className="h-4 w-4" />
              <span className="hidden sm:inline">{t('calendar.addEntry')}</span>
            </Button>
          </div>

          {/* Repères chiffrés — trois nombres pour situer le mois d'un coup d'œil. */}
          <div className="mb-6 flex flex-wrap gap-x-8 gap-y-2 rounded-2xl border border-white/10 bg-black/40 px-5 py-4">
            {([
              ...(stats.showRelative
                ? ([['today', stats.today], ['week', stats.week]] as const)
                : []),
              ['month', stats.month],
            ] as Array<readonly [string, number]>).map(([key, value]) => (
              <div key={key} className="flex items-baseline gap-2">
                <span className={`text-xl font-bold tabular-nums ${value > 0 ? 'text-red-400' : 'text-white/30'}`}>
                  {value}
                </span>
                <span className="text-xs uppercase tracking-wider text-white/40">
                  {t(`calendar.stat.${key}`)}
                </span>
              </div>
            ))}
          </div>

          {/* ── Barre d'outils ──────────────────────────────────────── */}
          <div className="mb-6 flex flex-wrap items-center gap-3 rounded-2xl border border-white/10 bg-black/40 p-3">
            <div className="flex items-center gap-1">
              <Button variant="ghost" size="icon" onClick={() => shiftMonth(-1)} aria-label={t('calendar.previousMonth')}>
                <ChevronLeft className="h-5 w-5" />
              </Button>
              <span className="min-w-[9.5rem] text-center text-base font-semibold capitalize text-white">
                {monthLabel}
              </span>
              <Button variant="ghost" size="icon" onClick={() => shiftMonth(1)} aria-label={t('calendar.nextMonth')}>
                <ChevronRight className="h-5 w-5" />
              </Button>
            </div>

            <Button variant="outline" size="sm" onClick={goToday}>{t('calendar.today')}</Button>

            {loading && <Loader2 className="h-4 w-4 animate-spin text-red-400" />}

            {/* Recherche — filtre les événements affichés, toutes vues confondues. */}
            <div className="relative min-w-[10rem] flex-1 sm:max-w-xs">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-white/40" />
              <input
                type="search"
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  // Une nouvelle recherche repart de zéro : garder ouvert le
                  // panneau d'un jour choisi pour l'ancienne n'aide personne.
                  setSelectedDay(null);
                }}
                placeholder={t('calendar.searchPlaceholder')}
                className="h-9 w-full rounded-lg border border-white/10 bg-white/5 pl-9 pr-8 text-sm text-white placeholder:text-white/35 outline-none transition-colors focus:border-red-500/40 focus:bg-white/[0.08] [&::-webkit-search-cancel-button]:hidden"
              />
              {query && (
                <button
                  onClick={() => setQuery('')}
                  aria-label={t('calendar.clearSearch')}
                  className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-white/40 transition-colors hover:text-white"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>

            <div className="ml-auto flex items-center gap-2">
              <Button
                variant={filtersOpen ? 'destructive' : 'outline'}
                size="sm"
                className="gap-2"
                onClick={() => setFiltersOpen((open) => !open)}
              >
                <SlidersHorizontal className="h-3.5 w-3.5" />
                {t('calendar.filters')}
                {hiddenFilterCount > 0 && (
                  <span className="rounded-full bg-red-500/20 px-1.5 text-[11px] font-semibold text-red-200">
                    {hiddenFilterCount}
                  </span>
                )}
              </Button>

              <div className="flex rounded-lg border border-white/10 bg-white/5 p-0.5">
                {(['month', 'agenda'] as const).map((view) => (
                  <button
                    key={view}
                    onClick={() => setPrefs((current) => ({ ...current, view }))}
                    className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                      prefs.view === view ? 'bg-red-600 text-white' : 'text-white/60 hover:text-white'
                    }`}
                  >
                    {view === 'month' ? <LayoutGrid className="h-3.5 w-3.5" /> : <ListOrdered className="h-3.5 w-3.5" />}
                    <span className="hidden sm:inline">{t(`calendar.view.${view}`)}</span>
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* ── Filtres ─────────────────────────────────────────────── */}
          <AnimatePresence initial={false}>
            {filtersOpen && (
              <motion.div
                initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }}
                exit={{ opacity: 0, height: 0 }} transition={{ duration: 0.2 }}
                className="mb-6 overflow-hidden"
              >
                <div className="rounded-2xl border border-white/10 bg-black/40 p-5">
                  <div className="mb-4 flex items-center justify-between gap-3">
                    <p className="text-xs text-white/40">
                      {hiddenFilterCount > 0
                        ? t('calendar.filtersActive', { count: hiddenFilterCount })
                        : t('calendar.filtersNone')}
                    </p>
                    <button
                      onClick={resetFilters}
                      disabled={hiddenFilterCount === 0}
                      className="text-xs text-white/50 underline-offset-4 transition-colors enabled:hover:text-white enabled:hover:underline disabled:cursor-default disabled:text-white/20"
                    >
                      {t('calendar.resetFilters')}
                    </button>
                  </div>

                  <div className="grid gap-6 md:grid-cols-2">
                  <div>
                    <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-white/50">
                      {t('calendar.filterSources')}
                    </h2>
                    <div className="flex flex-wrap gap-2">
                      {ALL_SOURCES.map((source) => {
                        const active = prefs.sources.includes(source);
                        return (
                          <button
                            key={source}
                            onClick={() => setPrefs((current) => ({ ...current, sources: toggle(current.sources, source) }))}
                            className={`rounded-full border px-3 py-1.5 text-xs font-medium transition-all ${
                              active
                                ? 'border-red-500/40 bg-red-500/15 text-red-100'
                                : 'border-white/10 bg-white/5 text-white/50 hover:bg-white/10'
                            }`}
                          >
                            {t(`calendar.source.${source}`)}
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  <div>
                    <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-white/50">
                      {t('calendar.filterCategories')}
                    </h2>
                    <div className="flex flex-wrap gap-2">
                      {CALENDAR_CATEGORIES.map((category) => {
                        const active = prefs.categories.includes(category);
                        return (
                          <button
                            key={category}
                            onClick={() => setPrefs((current) => ({ ...current, categories: toggle(current.categories, category) }))}
                            className={`flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-medium transition-all ${
                              active
                                ? CATEGORY_ACCENT[category].chip
                                : 'border-white/10 bg-white/5 text-white/50 hover:bg-white/10'
                            }`}
                          >
                            <span className={`h-2 w-2 rounded-full ${CATEGORY_ACCENT[category].dot}`} />
                            {t(`calendar.category.${category}`)}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                  </div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {/* ── Résultats de recherche en vue mois ──────────────────── */}
          {/* La grille filtrée ne dit pas où regarder : quarante-deux cases
              dont trois pleines. Cette rangée les liste et y emmène d'un clic.
              Un mois sans résultat propose de poursuivre la recherche sur les
              mois voisins plutôt que d'afficher une grille muette. */}
          {prefs.view === 'month' && searchActive && (
            <div className="mb-4 flex flex-wrap items-center gap-2 rounded-2xl border border-white/10 bg-black/40 px-4 py-3">
              {searchHits.length > 0 ? (
                <>
                  <span className="mr-1 text-xs text-white/50">
                    {t('calendar.searchHits', { count: searchHits.reduce((sum, hit) => sum + hit.count, 0) })}
                  </span>
                  {searchHits.map((hit) => (
                    <button
                      key={hit.key}
                      onClick={() => {
                        const next = selectedDay === hit.key ? null : hit.key;
                        setSelectedDay(next);
                        // Le panneau du jour s'ouvre sous la grille, hors de
                        // l'écran depuis la barre : on l'y amène.
                        // Après le montage du panneau — l'état vient d'être
                        // posé, le rendu n'a pas encore eu lieu.
                        if (next) {
                          window.setTimeout(() => {
                            document.getElementById('calendar-day-panel')
                              ?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                          }, 80);
                        }
                      }}
                      className={`flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium capitalize transition-all ${
                        selectedDay === hit.key
                          ? 'border-red-500/40 bg-red-500/15 text-red-100'
                          : 'border-white/10 bg-white/5 text-white/70 hover:bg-white/10 hover:text-white'
                      }`}
                    >
                      {shortDayLabel(hit.key)}
                      {hit.count > 1 && (
                        <span className="rounded-full bg-white/10 px-1.5 text-[10px] tabular-nums text-white/60">
                          {hit.count}
                        </span>
                      )}
                    </button>
                  ))}
                </>
              ) : (
                <>
                  <span className="text-xs text-white/50">
                    {t('calendar.searchNoneMonth', { month: monthLabel })}
                  </span>
                  <div className="ml-auto flex items-center gap-2">
                    <button
                      onClick={() => shiftMonth(-1)}
                      className="flex items-center gap-1 rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-white/70 transition-colors hover:bg-white/10 hover:text-white"
                    >
                      <ChevronLeft className="h-3 w-3" />
                      {t('calendar.previousMonth')}
                    </button>
                    <button
                      onClick={() => shiftMonth(1)}
                      className="flex items-center gap-1 rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-white/70 transition-colors hover:bg-white/10 hover:text-white"
                    >
                      {t('calendar.nextMonth')}
                      <ChevronRight className="h-3 w-3" />
                    </button>
                  </div>
                </>
              )}
            </div>
          )}

          {/* ── Grille mensuelle ────────────────────────────────────── */}
          {prefs.view === 'month' ? (
            <div className="overflow-hidden rounded-2xl border border-white/10 bg-black/40">
              <div className="grid grid-cols-7 border-b border-white/10">
                {weekdayLabels.map((label) => (
                  <div key={label} className="px-2 py-3 text-center text-[11px] font-semibold uppercase tracking-wider text-white/40">
                    {label}
                  </div>
                ))}
              </div>

              <div className="grid grid-cols-7">
                {monthDays.map((day) => {
                  const key = toDateKey(day);
                  const items = byDay.get(key) ?? [];
                  const outside = day.getMonth() !== cursor.month;
                  const isToday = key === today;
                  const isSelected = key === selectedDay;
                  // Pendant une recherche, les cases pleines ressortent et les
                  // vides s'estompent : l'œil va droit aux résultats.
                  const isHit = searchActive && items.length > 0;
                  const isMiss = searchActive && items.length === 0;

                  return (
                    <button
                      key={key}
                      onClick={() => setSelectedDay(isSelected ? null : key)}
                      className={`group relative min-h-[104px] border-b border-r border-white/[0.06] p-2 text-left align-top transition-colors [&:nth-child(7n)]:border-r-0 ${
                        outside ? 'bg-black/20' : 'hover:bg-white/[0.04]'
                      } ${isHit && !isSelected ? 'bg-red-500/[0.06] ring-1 ring-inset ring-red-500/25' : ''} ${
                        isMiss ? 'opacity-40' : ''
                      } ${isSelected ? 'bg-red-500/10 ring-1 ring-inset ring-red-500/40' : ''}`}
                    >
                      <span className={`inline-flex h-6 w-6 items-center justify-center rounded-full text-xs font-semibold ${
                        isToday ? 'bg-red-600 text-white'
                          : outside ? 'text-white/25' : 'text-white/70'
                      }`}>
                        {day.getDate()}
                      </span>

                      <div className="mt-1.5 space-y-1">
                        {items.slice(0, 3).map((item) => (
                          <div
                            key={item.key}
                            className={`truncate rounded-md px-1.5 py-1 text-[11px] font-medium ${CATEGORY_ACCENT[item.category].cell}`}
                            title={`${item.title}${item.subtitle ? ` — ${item.subtitle}` : ''}`}
                          >
                            {item.title}
                          </div>
                        ))}
                        {items.length > 3 && (
                          <div className="px-1.5 text-[11px] font-medium text-white/40">
                            {t('calendar.moreCount', { count: items.length - 3 })}
                          </div>
                        )}
                      </div>
                    </button>
                  );
                })}
              </div>

              {/* Légende — sans elle, les couleurs des puces ne veulent rien dire. */}
              <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-white/10 px-4 py-3">
                {CALENDAR_CATEGORIES.map((category) => (
                  <span key={category} className="flex items-center gap-2 text-[11px] text-white/45">
                    <span className={`h-2 w-2 rounded-full ${CATEGORY_ACCENT[category].dot}`} />
                    {t(`calendar.category.${category}`)}
                  </span>
                ))}
              </div>
            </div>
          ) : (
            /* ── Agenda ──────────────────────────────────────────────── */
            <div className="space-y-6">
              {agendaDays.length === 0 && !loading && (
                <div className="rounded-2xl border border-white/10 bg-black/40 py-16 text-center">
                  <CalendarDays className="mx-auto mb-4 h-10 w-10 text-white/20" />
                  {/* Un mois vidé par une recherche, par un filtre ou réellement
                      vide demandent trois gestes différents : effacer la
                      recherche, réafficher les sources, ou rien du tout. */}
                  <p className="text-white/50">
                    {query.trim()
                      ? t('calendar.emptySearch', { query: query.trim() })
                      : hiddenFilterCount > 0 ? t('calendar.emptyFiltered') : t('calendar.emptyMonth')}
                  </p>
                  {query.trim() && (
                    <button
                      onClick={() => setQuery('')}
                      className="mt-3 text-sm text-red-300 underline-offset-4 transition-colors hover:text-red-200 hover:underline"
                    >
                      {t('calendar.clearSearch')}
                    </button>
                  )}
                  {!query.trim() && hiddenFilterCount > 0 && (
                    <button
                      onClick={resetFilters}
                      className="mt-3 text-sm text-red-300 underline-offset-4 transition-colors hover:text-red-200 hover:underline"
                    >
                      {t('calendar.resetFilters')}
                    </button>
                  )}
                </div>
              )}
              {agendaDays.map(([key, items]) => (
                <div key={key}>
                  <div className="mb-3 flex items-center gap-3">
                    <h2 className={`text-sm font-semibold capitalize ${key === today ? 'text-red-400' : 'text-white/80'}`}>
                      {key === today ? t('calendar.todayLabel') : dayLabel(key)}
                    </h2>
                    <div className="h-px flex-1 bg-white/10" />
                  </div>
                  {/* Trois cartes par rangée sur grand écran : une sortie par
                      ligne faisait défiler des kilomètres pour un jour chargé. */}
                  <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                    {items.map((item) => (
                      <button
                        key={item.key}
                        onClick={() => openOccurrence(item)}
                        className="flex w-full items-center gap-3 rounded-xl border border-white/10 bg-black/40 p-3 text-left transition-colors hover:border-white/20 hover:bg-white/[0.06]"
                      >
                        <span className={`h-10 w-1 shrink-0 rounded-full ${CATEGORY_ACCENT[item.category].dot}`} />
                        <CalendarPoster path={item.posterPath} className="h-16 w-11" />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate font-medium text-white">{item.title}</span>
                          {secondaryLabel(item) && (
                            <span className="block truncate text-sm text-white/50">{secondaryLabel(item)}</span>
                          )}
                          {item.note && <span className="block truncate text-xs text-white/35">{item.note}</span>}
                        </span>
                        {item.time && (
                          <span className="flex shrink-0 items-center gap-1 text-xs text-white/50">
                            <Clock className="h-3 w-3" />{item.time}
                          </span>
                        )}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* ── Détail du jour sélectionné ──────────────────────────── */}
          <AnimatePresence>
            {prefs.view === 'month' && selectedDay && (
              <motion.div
                id="calendar-day-panel"
                initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 10 }}
                transition={{ duration: 0.2 }}
                className="mt-6 rounded-2xl border border-white/10 bg-black/40 p-5"
              >
                <div className="mb-4 flex items-center justify-between gap-3">
                  <h2 className="text-sm font-semibold capitalize text-white">{dayLabel(selectedDay)}</h2>
                  <button
                    onClick={() => setDialog({ open: true, entry: null, date: selectedDay })}
                    className="flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-white/70 transition-colors hover:bg-white/10 hover:text-white"
                  >
                    <CalendarPlus className="h-3.5 w-3.5" />
                    {t('calendar.addOnThisDay')}
                  </button>
                </div>
                {selectedList.length === 0 ? (
                  <p className="py-4 text-center text-sm text-white/40">
                    {hiddenFilterCount > 0 ? t('calendar.emptyDayFiltered') : t('calendar.emptyDay')}
                  </p>
                ) : (
                  <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                    {selectedList.map((item) => (
                      <button
                        key={item.key}
                        onClick={() => openOccurrence(item)}
                        className="flex w-full items-center gap-3 rounded-xl border border-white/[0.08] bg-white/[0.03] p-2.5 text-left transition-colors hover:bg-white/[0.07]"
                      >
                        <span className={`h-9 w-1 shrink-0 rounded-full ${CATEGORY_ACCENT[item.category].dot}`} />
                        <CalendarPoster path={item.posterPath} className="h-12 w-8" />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium text-white">{item.title}</span>
                          {secondaryLabel(item) && (
                            <span className="block truncate text-xs text-white/50">{secondaryLabel(item)}</span>
                          )}
                        </span>
                        {item.time && <span className="shrink-0 text-xs text-white/50">{item.time}</span>}
                      </button>
                    ))}
                  </div>
                )}
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </motion.div>

      <CalendarEntryDialog
        isOpen={dialog.open}
        onClose={() => setDialog({ open: false, entry: null })}
        onSave={saveEntry}
        onDelete={dialog.entry ? deleteEntry : undefined}
        entry={dialog.entry}
        defaultDate={dialog.date}
      />
    </SquareBackground>
  );
};

export default CalendarPage;
